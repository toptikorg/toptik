# Verification record

Date: 2026-10-14. This is a review candidate, not a release.

* 2,134 local checks against captured live schema, all passed.
* 2,087 reproducible synthetic-fixture checks in verify.cjs, all passed. Run `npm ci && npm test` in this package.
* 66 parent schemas parsed as JSON, preserved native offer/identifier fields; 178 unique child canonical mappings.
* Explicit variant, collection-path and tag alternates preserved; unpublished/missing parent falls back to prior canonical.
* Both new snippets passed Shopify Theme Check. Full-layout lint has 37 errors, also present in the baseline with the same messages, including legacy blocking scripts and assets/locales absent from the partial theme snapshot. No new lint errors were introduced. The full theme is not lint-clean.
* Canonical-only rollback PowerShell syntax and local transformation passed. No rollback upload was executed.
* Before-change live reads: 244 of 244 returned 200; none contained a literal href ending in /tag. This is scoped evidence, not a sitemap/broken-page audit.
* NOT TESTED: Rich Results Test, published candidate, real desktop/mobile interaction after deployment. Browser policy rejected a local file URL; no bypass used.

Approval and live verification remain required. The branch's Vercel deploymentEnabled setting is false, so opening the PR must not create a preview deployment.
