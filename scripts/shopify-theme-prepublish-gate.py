#!/usr/bin/env python3
"""Check a Shopify draft before publication; this does not publish or enforce permissions."""
import argparse
import datetime
from dataclasses import dataclass
import email.utils
import http.cookiejar
import json
import re
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from html.parser import HTMLParser

BRANDS = ('mandarina-duck', 'brics', 'samsonite', 'american-tourister')
STORE = 'https://www.toptik.co.il'
GALLERY = 'https://landing.toptik.co.il/api/carousel'


class GateRateLimit(Exception):
    """The run cannot continue after the first HTTP 429."""
    code = 'RATE_LIMITED'


@dataclass(frozen=True)
class SignatureContext:
    """Non-secret operator metadata, never proof of a valid request signature."""
    required: bool = False
    configured: bool | None = None
    expires_at: str | None = None


class SignatureConfigurationError(Exception):
    def __init__(self, code, message, state):
        super().__init__(code + ': ' + message)
        self.code, self.state = code, state


def signature_preflight(context, signed_transport_available=False, now=None):
    state = {'required': context.required, 'configured': context.configured,
             'status': 'not_required', 'expires_at': None,
             'verification': 'operator_metadata_only_not_signature_verification'}
    if not context.required:
        return state

    def blocked(code, status, message):
        state['status'] = status
        raise SignatureConfigurationError(code, message, state)

    if context.configured is not True:
        blocked('SIGNATURE_MISSING', 'missing', 'required signature configuration was not declared; no request authorized')
    try:
        expiry = datetime.datetime.fromisoformat(context.expires_at or '')
        if expiry.tzinfo is None:
            raise ValueError('timezone required')
        expiry = expiry.astimezone(datetime.timezone.utc)
    except (ValueError, TypeError, OverflowError):
        blocked('SIGNATURE_INVALID', 'invalid_expiry', 'required signature expiry is missing or invalid; supply an explicit timezone-aware expiry')
    state['expires_at'] = expiry.isoformat()
    now = time.time() if now is None else now
    if expiry.timestamp() <= now:
        blocked('SIGNATURE_EXPIRED', 'expired', 'declared signature expiry has passed; no request authorized')
    if not signed_transport_available:
        blocked('SIGNED_TRANSPORT_UNAVAILABLE', 'transport_unavailable', 'metadata alone cannot sign requests; an explicitly authorized external signed opener is required')
    state['status'] = 'external_transport_configured'
    return state


def signature_origin_allowed(url):
    try:
        parts = urllib.parse.urlsplit(url)
        return (parts.scheme == 'https' and parts.hostname == 'www.toptik.co.il'
                and parts.port in (None, 443) and parts.username is None and parts.password is None)
    except ValueError:
        return False


class SignedOriginGuard(urllib.request.BaseHandler):
    """Reject an off-origin redirect before its signed opener can send it."""
    handler_order = 50

    def __init__(self, on_violation):
        self.on_violation = on_violation

    def http_request(self, request):
        if not signature_origin_allowed(request.full_url):
            self.on_violation()
        return request

    https_request = http_request


class PlainOriginGuard(urllib.request.BaseHandler):
    handler_order = 50

    def __init__(self, on_violation):
        self.on_violation = on_violation

    def http_request(self, request):
        if signature_origin_allowed(request.full_url):
            self.on_violation()
        return request

    https_request = http_request


class SignedHeadersGuard(urllib.request.BaseHandler):
    """Check names only, after ordinary header processors; never inspect values."""
    handler_order = 10000

    def __init__(self, transport):
        self.transport = transport

    def http_request(self, request):
        self.transport.ensure_signature()
        if not signature_origin_allowed(request.full_url):
            self.transport.reject_signed_origin()
        names = {name.lower() for headers in (request.headers, request.unredirected_hdrs)
                 for name in headers}
        if not {'signature', 'signature-input', 'signature-agent'}.issubset(names):
            self.transport.reject_missing_headers()
        return request

    https_request = http_request


class PlainHeadersGuard(urllib.request.BaseHandler):
    handler_order = 10000

    def __init__(self, on_violation):
        self.on_violation = on_violation

    def http_request(self, request):
        if signature_origin_allowed(request.full_url):
            self.on_violation()
        for headers in (request.headers, request.unredirected_hdrs):
            for name in list(headers):
                if name.lower() in ('signature', 'signature-input', 'signature-agent'):
                    del headers[name]
        return request

    https_request = http_request


class PreviewSessionError(Exception):
    """The preview session cannot safely continue."""


def clean_url(url):
    parts = urllib.parse.urlsplit(url)
    host = parts.hostname or ''
    if parts.port:
        host += ':' + str(parts.port)
    safe_query = [(name, value) for name, value in urllib.parse.parse_qsl(parts.query)
                  if name in ('preview_theme_id', 'variant') and re.fullmatch(r'[0-9]+', value)]
    return urllib.parse.urlunsplit((parts.scheme, host, parts.path, urllib.parse.urlencode(safe_query), ''))


class GateReport:
    def __init__(self, theme_id, clock=time.time):
        self.clock = clock
        self.data = {'theme_id': theme_id, 'started_at': self.now(), 'finished_at': None,
                     'result': 'running', 'requests': [], 'brands': {}, 'categories': {},
                     'counters': {'shopify': 0, 'other': 0, 'retries': 0}}

    def now(self):
        return datetime.datetime.fromtimestamp(self.clock(), datetime.timezone.utc).isoformat()

    def begin(self, request, is_shopify):
        entry = {'url': clean_url(request.full_url), 'started_at': self.now(),
                 'response_received_at': None, 'status': None, 'final_url': None}
        self.data['requests'].append(entry)
        self.data['counters']['shopify' if is_shopify else 'other'] += 1
        request._gate_trace = entry

    def response(self, request, response):
        entry = getattr(request, '_gate_trace', None)
        if entry is not None:
            entry.update(response_received_at=self.now(), status=response.status,
                         final_url=clean_url(response.geturl()))


def retry_delay(value, now):
    if value is None:
        return None
    value = value.strip()
    if re.fullmatch(r'[0-9]+', value):
        try:
            return float(int(value))
        except (ValueError, OverflowError):
            return None
    try:
        parsed = email.utils.parsedate_to_datetime(value)
        if parsed is None or parsed.tzinfo is None:
            return None
        return max(0.0, parsed.timestamp() - now)
    except (ValueError, TypeError, OverflowError):
        return None


class ShopifyPacer(urllib.request.BaseHandler):
    """Space request starts, including redirect hops, across both openers."""
    handler_order = 100

    def __init__(self, clock, sleep, report=None, before_request=None):
        self.clock = clock
        self.sleep = sleep
        self.last_started = None
        self.report = report
        self.before_request = before_request

    def http_request(self, request):
        host = (urllib.parse.urlsplit(request.full_url).hostname or '').lower().rstrip('.')
        is_shopify = (host in ('www.toptik.co.il', 'toptik.co.il', 'shopify.com') or
                      host.endswith(('.myshopify.com', '.shopify.com', '.shopifycdn.com', '.shopifycloud.com')))
        if is_shopify:
            while self.last_started is not None:
                remaining = 30.0 - (self.clock() - self.last_started)
                if remaining <= 0:
                    break
                self.sleep(remaining)
            self.last_started = self.clock()
        if self.before_request:
            self.before_request()
        if self.report:
            self.report.begin(request, is_shopify)
        return request

    https_request = http_request

    def http_response(self, request, response):
        if self.report:
            self.report.response(request, response)
        return response

    https_response = http_response


class ThemeGateTransport:
    """Serialize requests and permanently stop this run on any HTTP 429."""

    def __init__(self, clock=time.monotonic, sleep=time.sleep, opener_factory=None,
                 retry_429_once=False, wall_clock=time.time, report=None,
                 signature_context=None, signed_opener_factory=None):
        self.signature_context = signature_context or SignatureContext()
        self.signed_transport_available = signed_opener_factory is not None
        self._wall_clock, self.report = wall_clock, report
        self.ensure_signature()
        opener_factory = opener_factory or urllib.request.build_opener
        self._pacer = ShopifyPacer(clock, sleep, report, self.ensure_signature)
        self._clock, self._sleep, self._wall_clock = clock, sleep, wall_clock
        self._retry_enabled, self._retry_used, self.report = retry_429_once, False, report
        self.last_response = None
        self._jar = http.cookiejar.CookieJar()
        if signed_opener_factory is not None:
            # External adapters must preserve these supplied handlers. They are
            # invoked only for the allowed Shopify origin, never for Gallery.
            self._preview = signed_opener_factory(SignedOriginGuard(self.reject_signed_origin),
                self._pacer, urllib.request.HTTPCookieProcessor(self._jar), SignedHeadersGuard(self))
            self._live = signed_opener_factory(SignedOriginGuard(self.reject_signed_origin),
                self._pacer, SignedHeadersGuard(self))
            self._plain = opener_factory(PlainOriginGuard(self.reject_plain_signed_origin),
                self._pacer, PlainHeadersGuard(self.reject_plain_signed_origin))
        else:
            self._preview = opener_factory(self._pacer, urllib.request.HTTPCookieProcessor(self._jar))
            self._live = opener_factory(self._pacer)
            self._plain = self._preview
        self._lock = threading.Lock()
        self._rate_limit = None

    def ensure_signature(self):
        try:
            state = signature_preflight(self.signature_context, self.signed_transport_available,
                                        self._wall_clock())
        except SignatureConfigurationError as exc:
            if self.report:
                self.report.data['signature'] = dict(exc.state)
            raise
        if self.report:
            self.report.data['signature'] = state
        return state

    def reject_signed_origin(self):
        state = dict(self.ensure_signature(), status='scope_blocked')
        if self.report:
            self.report.data['signature'] = state
        raise SignatureConfigurationError('SIGNED_TRANSPORT_SCOPE_INVALID',
            'external signed transport cannot follow a redirect outside its authorized Shopify origin', state)

    def reject_plain_signed_origin(self):
        state = dict(self.ensure_signature(), status='scope_blocked')
        if self.report:
            self.report.data['signature'] = state
        raise SignatureConfigurationError('SIGNED_TRANSPORT_SCOPE_INVALID',
            'plain transport cannot follow a redirect into the signed Shopify origin', state)

    def reject_missing_headers(self):
        state = dict(self.ensure_signature(), status='request_headers_missing')
        if self.report:
            self.report.data['signature'] = state
        raise SignatureConfigurationError('SIGNED_TRANSPORT_MISSING_HEADERS',
            'external transport did not attach all required signature header names; request blocked', state)

    def get(self, url, use_cookies=True):
        with self._lock:
            if self._rate_limit is not None:
                raise self._rate_limit
            self.ensure_signature()
            self.last_response = None
            if self.signed_transport_available and not signature_origin_allowed(url):
                opener = self._plain
            else:
                opener = self._preview if use_cookies else self._live
            while True:
                request = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0 TopTik-theme-gate/1.0'})
                try:
                    with opener.open(request, timeout=30) as response:
                        self.last_response = {'status': getattr(response, 'status', 200),
                                              'final_url': clean_url(response.geturl()) if hasattr(response, 'geturl') else clean_url(url)}
                        return response.read().decode('utf-8')
                except urllib.error.HTTPError as exc:
                    self.last_response = {'status': exc.code, 'final_url': clean_url(exc.geturl())}
                    if exc.code != 429:
                        raise
                    arrival = self._clock()
                    retry_after = exc.headers.get('Retry-After') if exc.headers else None
                    delay = retry_delay(retry_after, self._wall_clock())
                    safe_retry = re.sub(r'[\x00-\x1f\x7f]', '', str(retry_after or ''))[:128]
                    detail = 'HTTP 429' + (f'; Retry-After: {safe_retry}' if safe_retry else '')
                    final_url = exc.geturl()
                    try:
                        exc.close()
                    except Exception:
                        pass
                    if self._retry_enabled and not self._retry_used and delay is not None:
                        print(f'{detail}; waiting before one permitted retry', file=sys.stderr)
                        self._retry_used = True
                        if self.report:
                            self.report.data['counters']['retries'] += 1
                        while self._clock() < arrival + delay:
                            self._sleep(arrival + delay - self._clock())
                        url = final_url
                        continue
                    self._rate_limit = GateRateLimit(detail)
                    raise self._rate_limit from exc


class Page(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.links = []
        self.series_links = []
        self.ids = set()
        self.images = 0
        self.in_series = False
        self.side_depth = 0
        self.side_links = []

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == 'div' and 'tt-side__list' in a.get('class', '').split():
            self.side_depth = 1
        elif tag == 'div' and self.side_depth:
            self.side_depth += 1
        if a.get('id'):
            self.ids.add(a['id'])
        if tag == 'details' and 'tt-series-nav' in a.get('class', '').split():
            self.in_series = True
        if tag == 'a' and a.get('href'):
            href = urllib.parse.urlsplit(a['href']).path
            self.links.append(href)
            if self.side_depth:
                self.side_links.append(urllib.parse.unquote(href))
            if self.in_series:
                self.series_links.append(href)
        if tag == 'img' and (a.get('src') or a.get('data-src')):
            self.images += 1

    def handle_endtag(self, tag):
        if tag == 'div' and self.side_depth:
            self.side_depth -= 1
        if tag == 'details' and self.in_series:
            self.in_series = False


def actual_theme_id(html):
    theme = re.search(r'Shopify\.theme\s*=\s*(\{[^;]+\})', html)
    try:
        return str(json.loads(theme.group(1))['id']) if theme else ''
    except (ValueError, KeyError, TypeError):
        return ''


def validate_page(html, theme_id, brand, expected_series):
    errors = []
    actual_id = actual_theme_id(html)
    if actual_id != str(theme_id):
        errors.append('preview theme identity mismatch or missing')
    page = Page()
    page.feed(html)
    if not page.series_links:
        errors.append('series navigation missing')
    missing = sorted(set('/collections/' + key for key in expected_series) - set(page.series_links))
    if missing:
        errors.append('missing series: ' + ', '.join(missing))
    if not any(path.startswith('/products/') for path in page.links):
        errors.append('product links missing')
    if page.images < 2:
        errors.append('page images missing')
    for element in ('tt-filter-form', 'tt-sort-by', 'tt-brand-filter'):
        if element not in page.ids:
            errors.append('filter control missing: ' + element)
    if '/search' not in page.links:
        errors.append('search link missing')
    return errors


def validate_category_links(html, required, forbidden):
    page = Page()
    page.feed(html)
    missing = set(required) - set(page.side_links)
    unrelated = set(forbidden) & set(page.side_links)
    return ([f'missing category links: {sorted(missing)}'] if missing else []) + ([f'unrelated category links: {sorted(unrelated)}'] if unrelated else [])


class PreviewSession:
    def __init__(self, theme_id, transport, report):
        self.theme_id, self.transport, self.report = str(theme_id), transport, report
        self.started = False

    def get(self, url, entry):
        first = not self.started
        if first:
            self.started = True
            if self.report:
                self.report.data['preview_session']['status'] = 'initializing'
        else:
            parts = urllib.parse.urlsplit(url)
            query = [(key, value) for key, value in urllib.parse.parse_qsl(parts.query)
                     if key != 'preview_theme_id']
            url = urllib.parse.urlunsplit((parts.scheme, parts.netloc, parts.path,
                                           urllib.parse.urlencode(query), parts.fragment))
        try:
            html = self.transport.get(url)
        except SignatureConfigurationError:
            raise
        except GateRateLimit:
            if first and self.report:
                self.report.data['preview_session']['status'] = 'failed'
            raise
        except Exception as exc:
            if first:
                if self.report:
                    self.report.data['preview_session']['status'] = 'failed'
                raise PreviewSessionError('preview initialization failed: ' + type(exc).__name__) from exc
            raise
        actual_id = actual_theme_id(html)
        if entry is not None:
            entry['theme_id_observed'] = actual_id or None
        if actual_id != self.theme_id:
            if first and self.report:
                self.report.data['preview_session']['status'] = 'failed'
            raise PreviewSessionError('preview theme identity mismatch or missing')
        if first and self.report:
            self.report.data['preview_session']['status'] = 'initialized'
        return html


def _run(theme_id, transport, report, reuse_preview_session):
    preview_session = PreviewSession(theme_id, transport, report) if reuse_preview_session else None
    try:
        payload = json.loads(transport.get(GALLERY))
    except GateRateLimit as exc:
        if report:
            report.data.update(error_code='RATE_LIMITED', rate_limit_cause='unclassified')
        print('FAIL gate stopped: ' + str(exc), file=sys.stderr)
        return 1
    failures = []
    for brand in BRANDS:
        entry = report.data['brands'][brand] if report else None
        if entry is not None:
            entry.update(status='running', started_at=report.now())
        expected = {item['series']['key'] for item in payload['items'] if item.get('isActive') and (item.get('shopifyLink') or {}).get('isPublished') and (item.get('series') or {}).get('brand') == brand and item['series'].get('key')}
        if not expected:
            failures.append(brand + ': no active published gallery series, cannot verify')
            if entry is not None:
                entry.update(status='fail', finished_at=report.now(), errors=['no active published gallery series'])
            continue
        url = f'{STORE}/collections/{brand}?preview_theme_id={theme_id}'
        report_errors = []
        try:
            live = Page()
            live.feed(transport.get(f'{STORE}/collections/{brand}', use_cookies=False))
            expected.update(path.removeprefix('/collections/') for path in live.series_links if path.startswith('/collections/'))
            html = preview_session.get(url, entry) if preview_session else transport.get(url)
            errors = validate_page(html, theme_id, brand, expected)
        except SignatureConfigurationError:
            raise
        except PreviewSessionError as exc:
            if entry is not None:
                response = getattr(transport, 'last_response', None) or {}
                entry.update(status='theme_mismatch' if str(exc) == 'preview theme identity mismatch or missing' else 'initialization_failed',
                             finished_at=report.now(), http_status=response.get('status'),
                             final_url=response.get('final_url'), errors=[str(exc)])
            print('FAIL gate stopped: ' + str(exc), file=sys.stderr)
            return 1
        except GateRateLimit as exc:
            if report:
                report.data.update(error_code='RATE_LIMITED', rate_limit_cause='unclassified')
            if entry is not None:
                response = getattr(transport, 'last_response', None) or {}
                entry.update(status='rate_limited', finished_at=report.now(),
                             http_status=response.get('status'), final_url=response.get('final_url'), errors=['HTTP 429'])
            print('FAIL gate stopped: ' + str(exc), file=sys.stderr)
            return 1
        except Exception as exc:
            errors = [f'could not inspect preview: {exc}']
            report_errors = ['could not inspect preview: ' + type(exc).__name__]
        if errors:
            failures.extend(brand + ': ' + error for error in errors)
        else:
            print(f'PASS {brand}: {len(expected)} series and filter structure')
        if entry is not None:
            response = getattr(transport, 'last_response', None) or {}
            entry.update(status='fail' if errors else 'pass', finished_at=report.now(),
                         http_status=response.get('status'), final_url=response.get('final_url'),
                         errors=report_errors or errors)
    category_rules = {
        'all-bags': (['/collections/fashion-bags', '/collections/backpacks', '/collections/תיקי-נסיעות', '/collections/תיקי-גב-למחשב'], ['/collections/wallets', '/collections/מזוודות']),
        'wallets-and-accessories': (['/collections/wallets', '/collections/toiletry-pouches'], ['/collections/backpacks', '/collections/fashion-bags', '/collections/מזוודות']),
        'מזוודות': (['/collections/מזוודות', '/collections/טרולי-carry-on'], ['/collections/wallets', '/collections/fashion-bags', '/collections/backpacks']),
        'samsonite': (['/collections/מזוודות-סמסונייט', '/collections/טרולי-carry-on/samsonite', '/collections/תיקי-נסיעות/samsonite', '/collections/תיקי-גב-למחשב/samsonite'], []),
        'mandarina-duck-mellow-urban': (['/collections/all-bags/mandarinaduck'], ['/collections/wallets/mandarinaduck']),
    }
    for handle, (required, forbidden) in category_rules.items():
        entry = report.data['categories'][handle] if report else None
        if entry is not None:
            entry.update(status='running', started_at=report.now())
        report_errors = []
        try:
            url = f'{STORE}/collections/{urllib.parse.quote(handle)}?preview_theme_id={theme_id}'
            html = preview_session.get(url, entry) if preview_session else transport.get(url)
            errors = validate_category_links(html, required, forbidden)
        except SignatureConfigurationError:
            raise
        except PreviewSessionError as exc:
            if entry is not None:
                response = getattr(transport, 'last_response', None) or {}
                entry.update(status='theme_mismatch' if str(exc) == 'preview theme identity mismatch or missing' else 'initialization_failed',
                             finished_at=report.now(), http_status=response.get('status'),
                             final_url=response.get('final_url'), errors=[str(exc)])
            print('FAIL gate stopped: ' + str(exc), file=sys.stderr)
            return 1
        except GateRateLimit as exc:
            if report:
                report.data.update(error_code='RATE_LIMITED', rate_limit_cause='unclassified')
            if entry is not None:
                response = getattr(transport, 'last_response', None) or {}
                entry.update(status='rate_limited', finished_at=report.now(),
                             http_status=response.get('status'), final_url=response.get('final_url'), errors=['HTTP 429'])
            print('FAIL gate stopped: ' + str(exc), file=sys.stderr)
            return 1
        except Exception as exc:
            errors = [f'could not inspect category links: {exc}']
            report_errors = ['could not inspect category links: ' + type(exc).__name__]
        if errors:
            failures.extend(handle + ': ' + error for error in errors)
        else:
            print(f'PASS {handle}: relevant category links')
        if entry is not None:
            response = getattr(transport, 'last_response', None) or {}
            entry.update(status='fail' if errors else 'pass', finished_at=report.now(),
                         http_status=response.get('status'), final_url=response.get('final_url'),
                         errors=report_errors or errors)
    for failure in failures:
        print('FAIL ' + failure, file=sys.stderr)
    return 1 if failures else 0


def run(theme_id, transport=None, report=None, reuse_preview_session=False,
        signature_context=None, signed_opener_factory=None, retry_429_once=False):
    if report:
        report.data['preview_session'] = {'enabled': reuse_preview_session,
                                          'status': 'not_started' if reuse_preview_session else 'disabled'}
        report.data['brands'] = {brand: {'status': 'not_run'} for brand in BRANDS}
        report.data['categories'] = {handle: {'status': 'not_run'} for handle in
            ('all-bags', 'wallets-and-accessories', 'מזוודות', 'samsonite', 'mandarina-duck-mellow-urban')}
    try:
        context = signature_context or getattr(transport, 'signature_context', SignatureContext())
        if transport is None:
            transport = ThemeGateTransport(report=report, signature_context=context,
                                           signed_opener_factory=signed_opener_factory,
                                           retry_429_once=retry_429_once)
        elif context.required:
            if not isinstance(transport, ThemeGateTransport) or transport.signature_context != context:
                signature_preflight(context, signed_transport_available=False)
            transport.ensure_signature()
        elif report:
            report.data['signature'] = signature_preflight(context)
        result = _run(theme_id, transport, report, reuse_preview_session)
        if report:
            report.data['result'] = 'pass' if result == 0 else 'fail'
        return result
    except SignatureConfigurationError as exc:
        if report:
            report.data.update(result='blocked', error_code=exc.code, signature=dict(exc.state))
        print('FAIL gate blocked: ' + str(exc), file=sys.stderr)
        return 1
    except Exception:
        if report:
            report.data['result'] = 'error'
        raise
    finally:
        if report:
            report.data['finished_at'] = report.now()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--theme-id', required=True, type=int)
    parser.add_argument('--retry-429-once', action='store_true', help='retry one 429 only when Retry-After is valid')
    parser.add_argument('--reuse-preview-session', action='store_true', help='initialize preview once and validate the theme identity on every preview page')
    parser.add_argument('--report-json', help='write a local JSON report without headers or sensitive query parameters')
    parser.add_argument('--require-signature', action='store_true', help='fail closed before network unless explicit metadata and an external signed transport are available')
    parser.add_argument('--signature-configured', action='store_true', default=None, help='non-secret operator declaration only; does not attach or verify a signature')
    parser.add_argument('--signature-expires-at', help='non-secret, timezone-aware ISO8601 expiry; never a signature value')
    args = parser.parse_args()
    report = GateReport(args.theme_id)
    report.data['retry_429_once'] = args.retry_429_once
    try:
        context = SignatureContext(args.require_signature, args.signature_configured, args.signature_expires_at)
        result = run(args.theme_id, report=report, reuse_preview_session=args.reuse_preview_session,
                     signature_context=context, retry_429_once=args.retry_429_once)
    except Exception as exc:
        print('FAIL gate could not complete: ' + str(exc), file=sys.stderr)
        result = 1
    finally:
        if args.report_json:
            with open(args.report_json, 'w', encoding='utf-8') as output:
                json.dump(report.data, output, ensure_ascii=False, indent=2)
    sys.exit(result)


