import importlib.util
import pathlib
import unittest

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


if __name__ == '__main__':
    unittest.main()

