import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('prepublish_gate', Path(__file__).parents[1] / 'scripts/shopify-theme-prepublish-gate.py')
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)

class CategoryPrepublishGateTest(unittest.TestCase):
    def test_missing_and_unrelated_links_fail(self):
        html = '<div class="tt-side__list"><a href="/collections/wallets">ארנקים</a></div>'
        errors = gate.validate_category_links(html, ['/collections/backpacks'], ['/collections/wallets'])
        self.assertEqual(len(errors), 2)

    def test_expected_link_passes(self):
        html = '<div class="tt-side__list"><a href="/collections/backpacks">תיקי גב</a></div>'
        self.assertEqual(gate.validate_category_links(html, ['/collections/backpacks'], ['/collections/wallets']), [])

if __name__ == '__main__':
    unittest.main()

