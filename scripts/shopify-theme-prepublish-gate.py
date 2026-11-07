#!/usr/bin/env python3
"""Check a Shopify draft before publication; this does not publish or enforce permissions."""
import argparse
import http.cookiejar
import json
import re
import sys
import urllib.parse
import urllib.request
from html.parser import HTMLParser

BRANDS = ('mandarina-duck', 'brics', 'samsonite', 'american-tourister')
STORE = 'https://www.toptik.co.il'
GALLERY = 'https://landing.toptik.co.il/api/carousel'


class Page(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.links = []
        self.series_links = []
        self.ids = set()
        self.images = 0
        self.in_series = False

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if a.get('id'):
            self.ids.add(a['id'])
        if tag == 'details' and 'tt-series-nav' in a.get('class', '').split():
            self.in_series = True
        if tag == 'a' and a.get('href'):
            href = urllib.parse.urlsplit(a['href']).path
            self.links.append(href)
            if self.in_series:
                self.series_links.append(href)
        if tag == 'img' and (a.get('src') or a.get('data-src')):
            self.images += 1

    def handle_endtag(self, tag):
        if tag == 'details' and self.in_series:
            self.in_series = False


def validate_page(html, theme_id, brand, expected_series):
    errors = []
    theme = re.search(r'Shopify\.theme\s*=\s*(\{[^;]+\})', html)
    try:
        actual_id = str(json.loads(theme.group(1))['id']) if theme else ''
    except (ValueError, KeyError):
        actual_id = ''
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


def run(theme_id):
    jar = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
    def get(url):
        with opener.open(urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0 TopTik-theme-gate/1.0'}), timeout=30) as response:
            return response.read().decode('utf-8')
    payload = json.loads(get(GALLERY))
    failures = []
    for brand in BRANDS:
        expected = {item['series']['key'] for item in payload['items'] if item.get('isActive') and (item.get('shopifyLink') or {}).get('isPublished') and (item.get('series') or {}).get('brand') == brand and item['series'].get('key')}
        if not expected:
            failures.append(brand + ': no active published gallery series, cannot verify')
            continue
        url = f'{STORE}/collections/{brand}?preview_theme_id={theme_id}'
        try:
            live_opener = urllib.request.build_opener()
            with live_opener.open(urllib.request.Request(f'{STORE}/collections/{brand}', headers={'User-Agent': 'Mozilla/5.0 TopTik-theme-gate/1.0'}), timeout=30) as response:
                live = Page()
                live.feed(response.read().decode('utf-8'))
            expected.update(path.removeprefix('/collections/') for path in live.series_links if path.startswith('/collections/'))
            errors = validate_page(get(url), theme_id, brand, expected)
        except Exception as exc:
            errors = [f'could not inspect preview: {exc}']
        if errors:
            failures.extend(brand + ': ' + error for error in errors)
        else:
            print(f'PASS {brand}: {len(expected)} series and filter structure')
    for failure in failures:
        print('FAIL ' + failure, file=sys.stderr)
    return 1 if failures else 0


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--theme-id', required=True, type=int)
    try:
        sys.exit(run(parser.parse_args().theme_id))
    except Exception as exc:
        print('FAIL gate could not complete: ' + str(exc), file=sys.stderr)
        sys.exit(1)

