# Community page links on Contact

The two content pages are already published in Shopify:

- https://www.toptik.co.il/pages/מפת-השקילה
- https://www.toptik.co.il/pages/אתם-בוחרים

Their SEO titles and descriptions, testimonial submission, shared vote totals, and responsive layout were verified on the public storefront at 375×812. Main-menu links are already saved. Test submissions were removed before handoff.

## Theme change awaiting approval

The live contact template comments out `page.content`, so editing its Page body cannot add a visible contact-page content link. This PR copies `templates/page.contact.liquid` from the live MAIN theme 187028865274 and adds only one render line, before `contact_time_duration`. The new snippet provides two ordinary links with visible focus styles and mobile layout. Existing form and branch sections are preserved.

Copy `shopify/templates/page.contact.liquid` to theme `templates/page.contact.liquid` and `shopify/snippets/toptik-contact-community-links.liquid` to theme `snippets/toptik-contact-community-links.liquid` in an unpublished copy of the current theme, then review and publish manually after approval. Do not overwrite newer theme changes: compare the contact template with the live source first. This PR does not publish a Shopify theme. Merging this repository alone does not install the theme files.

Acceptance: on Contact, desktop and 375×812, follow both new links and verify the destination H1; test keyboard focus, ensure no horizontal overflow, and confirm the contact form and three branch sections still appear. The snippet was checked in a local browser fixture; Shopify Preview acceptance remains pending theme installation.

Rollback: remove the render line and the new snippet. The two community Pages and their saved votes remain separate Shopify/database content.

## Operational limitations at handoff

Google Rich Results Test returned its service error “משהו השתבש — צריך להתחבר ולנסות שוב”. No Google schema pass is claimed. The Shopify-generated sitemap still needs rechecking after regeneration. These limitations do not prevent the two published content URLs from loading or the vote/testimony forms from working.
