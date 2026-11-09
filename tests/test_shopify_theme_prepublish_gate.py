import importlib.util
import contextlib
import concurrent.futures
import io
import json
import pathlib
import threading
import unittest
import urllib.error
import urllib.request
import urllib.response
import email.utils
from email.message import Message
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('gate', pathlib.Path(__file__).parents[1] / 'scripts' / 'shopify-theme-prepublish-gate.py')
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)

GOOD = '''<script>Shopify.theme = {"id":123};</script>
<a href="/search">search</a><div id="tt-filter-form"></div>
<select id="tt-sort-by"></select><select id="tt-brand-filter"></select>
<details class="tt-series-nav"><a href="/collections/brics-x">X</a></details>
<a href="/products/item">item</a><img src="one"><img src="two">'''


class GateTests(unittest.TestCase):
    def test_valid(self):
        self.assertEqual(gate.validate_page(GOOD, 123, 'brics', {'brics-x'}), [])

    def test_wrong_theme_is_failure(self):
        self.assertIn('preview theme identity mismatch or missing', gate.validate_page(GOOD, 456, 'brics', {'brics-x'}))

    def test_missing_series_and_filter_are_failures(self):
        errors = gate.validate_page(GOOD.replace('tt-sort-by', 'removed'), 123, 'brics', {'brics-x', 'brics-y'})
        self.assertTrue(any('brics-y' in error for error in errors))
        self.assertIn('filter control missing: tt-sort-by', errors)

    def test_no_navigation_and_no_product(self):
        errors = gate.validate_page(GOOD.replace('tt-series-nav', 'removed').replace('/products/item', '/other'), 123, 'brics', {'brics-x'})
        self.assertIn('series navigation missing', errors)
        self.assertIn('product links missing', errors)

    def test_first_429_stops_all_remaining_brand_and_category_requests(self):
        calls = []
        payload = {'items': [{'isActive': True, 'shopifyLink': {'isPublished': True},
                              'series': {'brand': brand, 'key': brand + '-x'}} for brand in gate.BRANDS]}

        class FakeOpener:
            def open(self, request, timeout):
                calls.append(request.full_url)
                if request.full_url == gate.GALLERY:
                    return contextlib.closing(io.BytesIO(json.dumps(payload).encode()))
                raise urllib.error.HTTPError(request.full_url, 429, 'Too Many Requests', {'Retry-After': '120'}, None)

        output = io.StringIO()
        with patch.object(gate.urllib.request, 'build_opener', side_effect=lambda *args: FakeOpener()), \
             contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(output):
            result = gate.run(123)
        self.assertEqual(result, 1)
        self.assertEqual(len(calls), 2, '429 must stop immediately instead of checking the next brand')
        self.assertIn('429', output.getvalue())
        self.assertIn('120', output.getvalue())

    def test_429_later_in_category_loop_stops_without_starting_next_category(self):
        payload = {'items': [{'isActive': True, 'shopifyLink': {'isPublished': True},
                              'series': {'brand': brand, 'key': brand + '-x'}} for brand in gate.BRANDS]}

        class FakeTransport:
            def __init__(self):
                self.calls = []

            def get(self, url, use_cookies=True):
                self.calls.append(url)
                if url == gate.GALLERY:
                    return json.dumps(payload)
                if len(self.calls) == 10:  # Gallery, eight brand pages, first category.
                    raise gate.GateRateLimit('HTTP 429; Retry-After: 60')
                return GOOD

        transport = FakeTransport()
        output = io.StringIO()
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(output):
            self.assertEqual(gate.run(123, transport), 1)
        self.assertEqual(len(transport.calls), 10)
        self.assertIn('Retry-After: 60', output.getvalue())

    def test_429_on_gallery_stops_without_any_shopify_request(self):
        class FakeTransport:
            def __init__(self):
                self.calls = []

            def get(self, url, use_cookies=True):
                self.calls.append(url)
                raise gate.GateRateLimit('HTTP 429')

        transport = FakeTransport()
        output = io.StringIO()
        with contextlib.redirect_stderr(output):
            self.assertEqual(gate.run(123, transport), 1)
        self.assertEqual(transport.calls, [gate.GALLERY])
        self.assertIn('429', output.getvalue())

    def test_partial_report_marks_rate_limit_and_remaining_not_run(self):
        payload = {'items': [{'isActive': True, 'shopifyLink': {'isPublished': True},
                              'series': {'brand': brand, 'key': brand + '-x'}} for brand in gate.BRANDS]}
        class FakeTransport:
            last_response = {'status': 429, 'final_url': gate.STORE + '/collections/mandarina-duck'}
            def get(self, url, use_cookies=True):
                if url == gate.GALLERY:
                    return json.dumps(payload)
                raise gate.GateRateLimit('HTTP 429')
        report = gate.GateReport(123)
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(gate.run(123, FakeTransport(), report), 1)
        first = report.data['brands']['mandarina-duck']
        self.assertEqual((first['status'], first['http_status']), ('rate_limited', 429))
        self.assertEqual(first['errors'], ['HTTP 429'])
        self.assertEqual(report.data['brands']['brics']['status'], 'not_run')
        self.assertEqual(report.data['categories']['all-bags']['status'], 'not_run')
        self.assertIsNotNone(report.data['finished_at'])
        self.assertEqual(report.data['error_code'], 'RATE_LIMITED')
        self.assertEqual(report.data['rate_limit_cause'], 'unclassified')
        self.assertEqual(report.data['signature']['status'], 'not_required')

    def test_report_includes_validation_failures_for_brands_and_categories(self):
        payload = {'items': [{'isActive': True, 'shopifyLink': {'isPublished': True},
                              'series': {'brand': brand, 'key': 'brics-x'}} for brand in gate.BRANDS]}
        class FakeTransport:
            last_response = {'status': 200, 'final_url': gate.STORE + '/collections/example?preview_theme_id=123'}
            def get(self, url, use_cookies=True):
                return json.dumps(payload) if url == gate.GALLERY else '<html></html>'
        report = gate.GateReport(123)
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(gate.run(123, FakeTransport(), report), 1)
        self.assertIn('series navigation missing', report.data['brands']['brics']['errors'])
        self.assertTrue(any('missing category links' in e for e in report.data['categories']['all-bags']['errors']))


class FakeClock:
    def __init__(self):
        self.now = 0.0
        self.sleeps = []

    def monotonic(self):
        return self.now

    def sleep(self, seconds):
        self.sleeps.append(seconds)
        self.now += seconds


class FakeNetwork(urllib.request.BaseHandler):
    handler_order = 200

    def __init__(self, clock, responder):
        self.clock = clock
        self.responder = responder
        self.calls = []

    def https_open(self, request):
        self.calls.append((request.full_url, self.clock.now, request.get_header('User-agent'), request.get_header('Cookie')))
        status, headers, body = self.responder(request.full_url)
        msg = Message()
        for key, value in headers.items():
            msg[key] = value
        stream = body if hasattr(body, 'read') else io.BytesIO(body)
        response = urllib.response.addinfourl(stream, msg, request.full_url, status)
        response.msg = 'simulated response'
        return response


class TransportTests(unittest.TestCase):
    def make_transport(self, responder, **options):
        clock = FakeClock()
        network = FakeNetwork(clock, responder)
        transport = gate.ThemeGateTransport(clock=clock.monotonic, sleep=clock.sleep, **options,
            opener_factory=lambda *handlers: urllib.request.build_opener(urllib.request.ProxyHandler({}), network, *handlers))
        return transport, clock, network

    def test_opt_in_waits_from_response_arrival_and_retries_once(self):
        calls = []
        clock = FakeClock()
        def respond(url):
            calls.append(url)
            if len(calls) == 1:
                clock.now += 10
                return (429, {'Retry-After': '60'}, b'limited')
            return (200, {}, b'ok')
        network = FakeNetwork(clock, respond)
        transport = gate.ThemeGateTransport(clock=clock.monotonic, sleep=clock.sleep, retry_429_once=True,
            opener_factory=lambda *handlers: urllib.request.build_opener(urllib.request.ProxyHandler({}), network, *handlers))
        self.assertEqual(transport.get(gate.STORE + '/one'), 'ok')
        self.assertEqual([call[1] for call in network.calls], [0, 70])

    def test_opt_in_rejects_missing_or_invalid_retry_after(self):
        for value in (None, '-1', '1.5', 'invalid'):
            headers = {} if value is None else {'Retry-After': value}
            transport, _, network = self.make_transport(lambda _url: (429, headers, b''), retry_429_once=True)
            with self.assertRaises(gate.GateRateLimit):
                transport.get(gate.STORE + '/one')
            self.assertEqual(len(network.calls), 1)

    def test_retry_is_single_for_entire_run(self):
        transport, _, network = self.make_transport(lambda _url: (429, {'Retry-After': '0'}, b''), retry_429_once=True)
        with self.assertRaises(gate.GateRateLimit):
            transport.get(gate.STORE + '/one')
        with self.assertRaises(gate.GateRateLimit):
            transport.get(gate.STORE + '/two')
        self.assertEqual([call[1] for call in network.calls], [0, 30])

    def test_successful_retry_consumes_entire_run_allowance(self):
        attempts = []
        def respond(_url):
            attempts.append(1)
            return (200, {}, b'ok') if len(attempts) == 2 else (429, {'Retry-After': '1'}, b'')
        transport, _, network = self.make_transport(respond, retry_429_once=True)
        self.assertEqual(transport.get(gate.STORE + '/one'), 'ok')
        with self.assertRaises(gate.GateRateLimit):
            transport.get(gate.STORE + '/two')
        self.assertEqual([call[1] for call in network.calls], [0, 30, 60])

    def test_http_date_past_still_obeys_pacing(self):
        epoch = 1700000000
        count = []
        def respond(_url):
            count.append(1)
            return (429, {'Retry-After': email.utils.formatdate(epoch - 60, usegmt=True)}, b'') if len(count) == 1 else (200, {}, b'ok')
        transport, _, network = self.make_transport(respond, retry_429_once=True, wall_clock=lambda: epoch)
        self.assertEqual(transport.get(gate.STORE + '/one'), 'ok')
        self.assertEqual([call[1] for call in network.calls], [0, 30])

    def test_http_date_future_is_respected(self):
        epoch = 1700000000
        count = []
        def respond(_url):
            count.append(1)
            return (429, {'Retry-After': email.utils.formatdate(epoch + 65, usegmt=True)}, b'') if len(count) == 1 else (200, {}, b'ok')
        transport, _, network = self.make_transport(respond, retry_429_once=True, wall_clock=lambda: epoch)
        self.assertEqual(transport.get(gate.STORE + '/one'), 'ok')
        self.assertEqual([call[1] for call in network.calls], [0, 65])

    def test_retry_after_a_redirect_retries_only_the_final_url(self):
        visits = []
        def respond(url):
            visits.append(url)
            if url.endswith('/one'):
                return 302, {'Location': gate.STORE + '/two'}, b''
            if visits.count(gate.STORE + '/two') == 1:
                return 429, {'Retry-After': '0'}, b''
            return 200, {}, b'ok'
        transport, _, network = self.make_transport(respond, retry_429_once=True)
        self.assertEqual(transport.get(gate.STORE + '/one'), 'ok')
        self.assertEqual(visits, [gate.STORE + '/one', gate.STORE + '/two', gate.STORE + '/two'])
        self.assertEqual([call[1] for call in network.calls], [0, 30, 60])

    def test_trace_records_redirects_without_secret_query(self):
        report = gate.GateReport(123, clock=lambda: 1700000000)
        def respond(url):
            return (302, {'Location': gate.STORE + '/two?token=secret'}, b'') if '/one' in url else (200, {}, b'ok')
        transport, _, _ = self.make_transport(respond, report=report)
        self.assertEqual(transport.get(gate.STORE + '/one?token=secret&preview_theme_id=123&variant=456'), 'ok')
        self.assertEqual([r['status'] for r in report.data['requests']], [302, 200])
        self.assertNotIn('secret', json.dumps(report.data))
        self.assertIn('preview_theme_id=123&variant=456', report.data['requests'][0]['url'])
        self.assertIsNotNone(report.data['requests'][0]['response_received_at'])
        self.assertNotIn('finished_at', report.data['requests'][0])

    def test_report_url_only_allows_numeric_identifiers(self):
        self.assertEqual(gate.clean_url(gate.STORE + '/one?preview_theme_id=secret&variant=123'),
                         gate.STORE + '/one?variant=123')

    def test_preview_session_reuses_cookie_and_aborts_on_category_mismatch(self):
        payload = {'items': [{'isActive': True, 'shopifyLink': {'isPublished': True},
                              'series': {'brand': brand, 'key': 'brics-x'}} for brand in gate.BRANDS]}
        def respond(url):
            if url == gate.GALLERY:
                return 200, {}, json.dumps(payload).encode()
            headers = {'Set-Cookie': 'preview=123; Path=/'} if 'preview_theme_id=' in url else {}
            html = GOOD.replace('"id":123', '"id":999') if '/all-bags' in url else GOOD
            return 200, headers, html.encode()
        report = gate.GateReport(123)
        transport, _, network = self.make_transport(respond, report=report)
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(gate.run(123, transport, report, reuse_preview_session=True), 1)
        preview_starts = [call for call in network.calls if 'preview_theme_id=' in call[0]]
        self.assertEqual(len(preview_starts), 1)
        self.assertEqual(preview_starts[0][0], gate.STORE + '/collections/mandarina-duck?preview_theme_id=123')
        for index in (1, 3, 5, 7):
            self.assertIsNone(network.calls[index][3], 'live baseline must not include preview cookie')
        self.assertIn('preview=123', network.calls[4][3])
        self.assertIn('preview=123', network.calls[9][3])
        self.assertEqual(len(network.calls), 10, 'must stop on mismatch without reinitializing')
        self.assertEqual(report.data['preview_session']['status'], 'initialized')
        self.assertEqual(report.data['brands']['brics']['theme_id_observed'], '123')
        self.assertEqual(report.data['categories']['all-bags']['theme_id_observed'], '999')
        self.assertEqual(report.data['categories']['all-bags']['status'], 'theme_mismatch')

    def test_failed_preview_initialization_stops_without_reinitializing(self):
        payload = {'items': [{'isActive': True, 'shopifyLink': {'isPublished': True},
                              'series': {'brand': brand, 'key': 'brics-x'}} for brand in gate.BRANDS]}
        def respond(url):
            if url == gate.GALLERY:
                return 200, {}, json.dumps(payload).encode()
            return 200, {}, (GOOD.replace('"id":123', '"id":999') if 'preview_theme_id=' in url else GOOD).encode()
        report = gate.GateReport(123)
        transport, _, network = self.make_transport(respond, report=report)
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(gate.run(123, transport, report, reuse_preview_session=True), 1)
        self.assertEqual(len(network.calls), 3)
        self.assertEqual(report.data['preview_session']['status'], 'failed')
        self.assertEqual(report.data['brands']['mandarina-duck']['theme_id_observed'], '999')

    def test_preview_session_all_pages_pass_with_only_one_initialization(self):
        payload = {'items': [{'isActive': True, 'shopifyLink': {'isPublished': True},
                              'series': {'brand': brand, 'key': 'brics-x'}} for brand in gate.BRANDS]}
        links = {
            'all-bags': ['/collections/fashion-bags', '/collections/backpacks', '/collections/תיקי-נסיעות', '/collections/תיקי-גב-למחשב'],
            'wallets-and-accessories': ['/collections/wallets', '/collections/toiletry-pouches'],
            'מזוודות': ['/collections/מזוודות', '/collections/טרולי-carry-on'],
            'samsonite': ['/collections/מזוודות-סמסונייט', '/collections/טרולי-carry-on/samsonite', '/collections/תיקי-נסיעות/samsonite', '/collections/תיקי-גב-למחשב/samsonite'],
            'mandarina-duck-mellow-urban': ['/collections/all-bags/mandarinaduck'],
        }
        def respond(url):
            if url == gate.GALLERY:
                return 200, {}, json.dumps(payload).encode()
            handle = urllib.parse.unquote(urllib.parse.urlsplit(url).path.rsplit('/', 1)[-1])
            # Samsonite appears as a brand and a category; its category links are harmless in both.
            side = '<div class="tt-side__list">' + ''.join('<a href="' + p + '">link</a>' for p in links.get(handle, [])) + '</div>'
            headers = {'Set-Cookie': 'preview=123; Path=/'} if 'preview_theme_id=' in url else {}
            return 200, headers, (GOOD + side).encode()
        report = gate.GateReport(123)
        transport, _, network = self.make_transport(respond, report=report)
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(gate.run(123, transport, report, reuse_preview_session=True), 0)
        self.assertEqual(len(network.calls), 14)
        self.assertEqual(len([c for c in network.calls if 'preview_theme_id=' in c[0]]), 1)
        for entry in list(report.data['brands'].values()) + list(report.data['categories'].values()):
            self.assertEqual((entry['status'], entry['theme_id_observed']), ('pass', '123'))

    def test_missing_theme_identity_stops_instead_of_reinitializing(self):
        payload = {'items': [{'isActive': True, 'shopifyLink': {'isPublished': True},
                              'series': {'brand': brand, 'key': 'brics-x'}} for brand in gate.BRANDS]}
        def respond(url):
            if url == gate.GALLERY:
                return 200, {}, json.dumps(payload).encode()
            html = GOOD.replace('<script>Shopify.theme = {"id":123};</script>', '') if '/all-bags' in url else GOOD
            return 200, {}, html.encode()
        report = gate.GateReport(123)
        transport, _, network = self.make_transport(respond, report=report)
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(gate.run(123, transport, report, reuse_preview_session=True), 1)
        self.assertEqual(len(network.calls), 10)
        self.assertIsNone(report.data['categories']['all-bags']['theme_id_observed'])
        self.assertEqual(report.data['categories']['all-bags']['status'], 'theme_mismatch')

    def test_shopify_requests_are_serial_and_spaced_by_30_seconds(self):
        transport, clock, network = self.make_transport(lambda _url: (200, {}, b'ok'))
        self.assertEqual(transport.get(gate.STORE + '/one', use_cookies=False), 'ok')
        self.assertEqual(transport.get(gate.GALLERY), 'ok')
        self.assertEqual(transport.get(gate.STORE + '/two'), 'ok')
        shopify = [call for call in network.calls if call[0].startswith(gate.STORE)]
        self.assertEqual([call[1] for call in shopify], [0.0, 30.0])
        self.assertEqual(clock.sleeps, [30.0])
        self.assertTrue(all(call[2] == 'Mozilla/5.0 TopTik-theme-gate/1.0' for call in network.calls))

    def test_redirect_to_shopify_is_a_separately_paced_request(self):
        def respond(url):
            return (302, {'Location': gate.STORE + '/two'}, b'') if url.endswith('/one') else (200, {}, b'ok')
        transport, _, network = self.make_transport(respond)
        self.assertEqual(transport.get(gate.STORE + '/one'), 'ok')
        self.assertEqual([call[1] for call in network.calls], [0.0, 30.0])

    def test_rate_limit_latches_closed_and_reports_retry_after_without_retry(self):
        transport, _, network = self.make_transport(lambda _url: (429, {'Retry-After': '120'}, b'limited'))
        with self.assertRaisesRegex(gate.GateRateLimit, '429.*Retry-After: 120'):
            transport.get(gate.STORE + '/one')
        with self.assertRaisesRegex(gate.GateRateLimit, '429'):
            transport.get(gate.STORE + '/two', use_cookies=False)
        self.assertEqual(len(network.calls), 1)

    def test_rate_limit_after_redirect_also_latches_closed(self):
        def respond(url):
            return (302, {'Location': gate.STORE + '/limited'}, b'') if url.endswith('/one') else (429, {'Retry-After': '90'}, b'limited')
        transport, _, network = self.make_transport(respond)
        with self.assertRaisesRegex(gate.GateRateLimit, '429.*Retry-After: 90'):
            transport.get(gate.STORE + '/one')
        with self.assertRaises(gate.GateRateLimit):
            transport.get(gate.STORE + '/later')
        self.assertEqual([call[1] for call in network.calls], [0.0, 30.0])

    def test_429_stops_even_if_closing_error_response_fails(self):
        class BrokenClose(urllib.error.HTTPError):
            def close(self):
                super().close()
                if not getattr(self, '_close_failed', False):
                    self._close_failed = True
                    raise OSError('simulated close failure')

        class FakeOpener:
            def open(self, request, timeout):
                raise BrokenClose(request.full_url, 429, 'Too Many Requests', {'Retry-After': '90'}, None)

        transport = gate.ThemeGateTransport(opener_factory=lambda *args: FakeOpener())
        with self.assertRaisesRegex(gate.GateRateLimit, '429.*Retry-After: 90'):
            transport.get(gate.STORE + '/one')
        with self.assertRaises(gate.GateRateLimit):
            transport.get(gate.STORE + '/later')

    def test_cookie_free_live_request_does_not_inherit_preview_cookie(self):
        def respond(url):
            return (200, {'Set-Cookie': 'preview=123; Path=/'}, b'ok') if url.endswith('/preview') else (200, {}, b'ok')
        transport, _, network = self.make_transport(respond)
        transport.get(gate.STORE + '/preview')
        transport.get(gate.STORE + '/live', use_cookies=False)
        transport.get(gate.STORE + '/preview-next')
        self.assertIsNone(network.calls[1][3])
        self.assertIn('preview=123', network.calls[2][3])

    def test_next_concurrent_request_waits_for_entire_response_body(self):
        started = threading.Event()
        release = threading.Event()
        second_attempted = threading.Event()

        class BlockingBody(io.BytesIO):
            def read(self, *args):
                started.set()
                if not release.wait(3):
                    raise TimeoutError('test body was not released')
                return super().read(*args)

        def respond(url):
            return (200, {}, BlockingBody(b'first')) if url.endswith('/one') else (200, {}, b'second')

        transport, _, network = self.make_transport(respond)
        def second():
            second_attempted.set()
            return transport.get(gate.STORE + '/two')

        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            first = pool.submit(transport.get, gate.STORE + '/one')
            try:
                self.assertTrue(started.wait(3))
                later = pool.submit(second)
                self.assertTrue(second_attempted.wait(3))
                self.assertEqual(len(network.calls), 1, 'second request started before body completed')
            finally:
                release.set()
            self.assertEqual(first.result(timeout=3), 'first')
            self.assertEqual(later.result(timeout=3), 'second')
        self.assertEqual([call[1] for call in network.calls], [0.0, 30.0])


class SignaturePolicyTests(unittest.TestCase):
    epoch = 1700000000

    def expiry(self, seconds):
        return gate.datetime.datetime.fromtimestamp(self.epoch + seconds, gate.datetime.timezone.utc).isoformat()

    def blocked(self, context, code):
        with self.assertRaises(gate.SignatureConfigurationError) as raised:
            gate.signature_preflight(context, now=self.epoch)
        self.assertEqual(raised.exception.code, code)
        return raised.exception

    def test_optional_mode_does_not_infer_signature_state(self):
        state = gate.signature_preflight(gate.SignatureContext(), now=self.epoch)
        self.assertEqual(state['status'], 'not_required')
        self.assertIsNone(state['configured'])

    def test_required_missing_configuration_is_positive_local_evidence(self):
        for configured in (None, False):
            self.blocked(gate.SignatureContext(True, configured), 'SIGNATURE_MISSING')

    def test_expiry_requires_a_known_timezone_aware_value(self):
        for expiry in (None, '', 'not-a-date', '2030-01-01', '2030-01-01T00:00:00'):
            self.blocked(gate.SignatureContext(True, True, expiry), 'SIGNATURE_INVALID')

    def test_expired_and_exact_boundary_are_blocked(self):
        for seconds in (-1, 0):
            self.blocked(gate.SignatureContext(True, True, self.expiry(seconds)), 'SIGNATURE_EXPIRED')

    def test_future_metadata_cannot_authorize_unsigned_transport(self):
        self.blocked(gate.SignatureContext(True, True, self.expiry(3600)), 'SIGNED_TRANSPORT_UNAVAILABLE')

    def test_context_and_explicit_external_transport_are_both_required(self):
        state = gate.signature_preflight(gate.SignatureContext(True, True, self.expiry(3600)), True, self.epoch)
        self.assertEqual(state['status'], 'external_transport_configured')
        self.assertEqual(state['verification'], 'operator_metadata_only_not_signature_verification')

    def test_invalid_input_is_not_echoed(self):
        marker = 'synthetic-sensitive-value-do-not-echo'
        exc = self.blocked(gate.SignatureContext(True, True, marker), 'SIGNATURE_INVALID')
        self.assertNotIn(marker, str(exc))
        self.assertNotIn(marker, json.dumps(exc.state))

    def test_required_configuration_failure_never_initializes_network(self):
        contexts = [gate.SignatureContext(True, False), gate.SignatureContext(True, True, 'invalid'),
                    gate.SignatureContext(True, True, self.expiry(-1)),
                    gate.SignatureContext(True, True, '2999-01-01T00:00:00+00:00')]
        expected = ['SIGNATURE_MISSING', 'SIGNATURE_INVALID', 'SIGNATURE_EXPIRED', 'SIGNED_TRANSPORT_UNAVAILABLE']
        for context, code in zip(contexts, expected):
            report = gate.GateReport(123)
            with patch.object(gate.urllib.request, 'build_opener', side_effect=AssertionError('network must not initialize')), \
                 contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(gate.run(123, report=report, signature_context=context), 1)
            self.assertEqual(report.data['error_code'], code)
            self.assertEqual(report.data['result'], 'blocked')
            self.assertEqual(report.data['requests'], [])
            self.assertEqual(report.data['counters'], {'shopify': 0, 'other': 0, 'retries': 0})
            self.assertIsNotNone(report.data['finished_at'])

    def signed_fixture(self, responder, expiry_seconds=3600, attach_names=True):
        clock = FakeClock()
        network = FakeNetwork(clock, responder)
        calls = []
        def factory(*handlers):
            calls.append(1)
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), network, *handlers)
            if attach_names:
                opener.addheaders = [(name, 'synthetic-test-fixture') for name in
                                     ('Signature', 'Signature-Input', 'Signature-Agent')]
            return opener
        context = gate.SignatureContext(True, True, self.expiry(expiry_seconds))
        report = gate.GateReport(123)
        transport = gate.ThemeGateTransport(clock=clock.monotonic, sleep=clock.sleep,
            wall_clock=lambda: self.epoch + clock.now, signature_context=context,
            signed_opener_factory=factory, report=report,
            opener_factory=lambda *handlers: urllib.request.build_opener(urllib.request.ProxyHandler({}), network, *handlers))
        return transport, clock, network, calls, report

    def test_external_factory_is_delegated_without_reading_credentials(self):
        transport, _, network, factories, report = self.signed_fixture(lambda _url: (200, {}, b'ok'))
        self.assertEqual(transport.get(gate.STORE + '/fixture'), 'ok')
        self.assertEqual(len(factories), 2)
        self.assertEqual(len(network.calls), 1)
        self.assertEqual(report.data['signature']['status'], 'external_transport_configured')
        self.assertNotIn('verified_signature', json.dumps(report.data))

    def test_expiry_during_pacing_blocks_redirect_before_next_request(self):
        def respond(url):
            return 302, {'Location': gate.STORE + '/second'}, b''
        transport, _, network, _, report = self.signed_fixture(respond, expiry_seconds=15)
        with self.assertRaises(gate.SignatureConfigurationError) as raised:
            transport.get(gate.STORE + '/first')
        self.assertEqual(raised.exception.code, 'SIGNATURE_EXPIRED')
        self.assertEqual(len(network.calls), 1)
        self.assertEqual(report.data['signature']['status'], 'expired')

    def test_required_context_cannot_be_paired_with_an_arbitrary_unsigned_transport(self):
        class NoNetwork:
            def get(self, *_args, **_kwargs):
                raise AssertionError('network must not run')
        report = gate.GateReport(123)
        context = gate.SignatureContext(True, True, '2999-01-01T00:00:00+00:00')
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(gate.run(123, NoNetwork(), report, signature_context=context), 1)
        self.assertEqual(report.data['error_code'], 'SIGNED_TRANSPORT_UNAVAILABLE')
        self.assertEqual(report.data['requests'], [])

    def test_future_metadata_and_unsigned_factory_are_blocked_before_network(self):
        transport, _, network, _, report = self.signed_fixture(lambda _url: (200, {}, b'ok'), attach_names=False)
        with self.assertRaises(gate.SignatureConfigurationError) as raised:
            transport.get(gate.STORE + '/fixture')
        self.assertEqual(raised.exception.code, 'SIGNED_TRANSPORT_MISSING_HEADERS')
        self.assertEqual(network.calls, [])
        self.assertEqual(report.data['signature']['status'], 'request_headers_missing')

    def test_gallery_never_uses_signed_factory_headers(self):
        seen = []
        def respond(request_url):
            return 200, {}, b'ok'
        transport, _, network, _, _ = self.signed_fixture(respond)
        # Inspect only synthetic fixture headers, never an actual signer/config.
        class HeaderProbe(urllib.request.BaseHandler):
            handler_order = 10001
            def https_request(self, request):
                names = {k.lower() for headers in (request.headers, request.unredirected_hdrs) for k in headers}
                seen.append((request.full_url, names))
                return request
        transport._plain.add_handler(HeaderProbe())
        transport._preview.add_handler(HeaderProbe())
        # Even an accidental default-header configuration is stripped late.
        transport._plain.addheaders = [(name, 'synthetic-test-fixture') for name in
                                      ('Signature', 'Signature-Input', 'Signature-Agent')]
        self.assertEqual(transport.get(gate.GALLERY), 'ok')
        self.assertEqual(transport.get(gate.STORE + '/fixture'), 'ok')
        self.assertFalse({'signature','signature-input','signature-agent'} & seen[0][1])
        self.assertTrue({'signature','signature-input','signature-agent'}.issubset(seen[1][1]))
        self.assertEqual(len(network.calls), 2)

    def test_signed_redirect_cannot_leave_authorized_origin(self):
        targets = [gate.GALLERY, 'https://example.test/final', 'http://www.toptik.co.il/final',
                   'https://www.toptik.co.il:8443/final', 'https://user@www.toptik.co.il/final']
        for target in targets:
            transport, _, network, _, _ = self.signed_fixture(lambda _url: (302, {'Location': target}, b''))
            with self.assertRaises(gate.SignatureConfigurationError) as raised:
                transport.get(gate.STORE + '/redirect')
            self.assertEqual(raised.exception.code, 'SIGNED_TRANSPORT_SCOPE_INVALID')
            self.assertEqual(len(network.calls), 1, target)
            self.assertEqual(network.calls[0][0], gate.STORE + '/redirect')

    def test_plain_gallery_redirect_cannot_send_unsigned_request_to_signed_origin(self):
        transport, _, network, _, _ = self.signed_fixture(lambda _url: (302, {'Location': gate.STORE + '/final'}, b''))
        with self.assertRaises(gate.SignatureConfigurationError) as raised:
            transport.get(gate.GALLERY)
        self.assertEqual(raised.exception.code, 'SIGNED_TRANSPORT_SCOPE_INVALID')
        self.assertEqual([call[0] for call in network.calls], [gate.GALLERY])

    def test_a_partial_signature_header_set_is_not_accepted(self):
        transport, _, network, _, _ = self.signed_fixture(lambda _url: (200, {}, b'ok'))
        transport._preview.addheaders = [('Signature', 'synthetic-test-fixture')]
        with self.assertRaises(gate.SignatureConfigurationError) as raised:
            transport.get(gate.STORE + '/fixture')
        self.assertEqual(raised.exception.code, 'SIGNED_TRANSPORT_MISSING_HEADERS')
        self.assertEqual(network.calls, [])

    def test_allowed_signed_redirect_remains_paced_and_functional(self):
        def respond(url):
            return (302, {'Location': gate.STORE + '/second'}, b'') if url.endswith('/first') else (200, {}, b'ok')
        transport, _, network, _, report = self.signed_fixture(respond)
        self.assertEqual(transport.get(gate.STORE + '/first'), 'ok')
        self.assertEqual([call[1] for call in network.calls], [0, 30])
        self.assertEqual(report.data['counters']['shopify'], 2)


if __name__ == '__main__':
    unittest.main()

