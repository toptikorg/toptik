# Contact page links to the three published branch pages

This package adds exactly three links to the existing contact cards. Existing telephone, Maps links, styling and other consumers remain unchanged. `review.diff` is line-formatted for review; `after.liquid` is the exact candidate.

Affected shared component: sections/toptik-branch-links.liquid, consumed by templates/page.contact.liquid. The page body is commented out in that template, so changing Page.body does not display these links.

Deployment BLOCKED: Shopify connector prohibits MAIN file writes and publishing themes. No alternate route used. Apply the candidate only through a permitted merchant release, first compare current live content with before.liquid; stop on drift. Rollback: restore before.liquid through the same permitted release.

Acceptance: exactly three new anchors, all existing Maps/telephone URLs preserved, desktop/mobile layout and real clicks on all three links after merchant release. Source checks passed; post-release UI checks remain NOT TESTED.

The six page/article content objects are already published separately. Rich Results Test is blocked by Google reCAPTCHA service connection failure; no passing result claimed. Sitemap inclusion is not yet verified.
