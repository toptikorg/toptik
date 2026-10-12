# Live editorial product examples

The gallery resolves product examples in Server Components. Store articles use
`toptik-live-article-examples` in MAIN's article template. Publication is checked
at render time, independently of the product media/copy queues. No article body,
product, media file, price or specification is written by this mechanism.

The checked manifest contains exact Shopify IDs and compatible example families
(vendor, type, series and luggage size where known). Missing products may use an
available alternative from that family; the replacement has its own image, title
and link and is labelled as an alternative. Existing model-specific prose is not
silently reassigned to another model. Without a verified alternative the sales
example is omitted/replaced with an unavailable label. A gallery network error is
not interpreted as product deletion. Lifestyle illustrations are not product photos.

## Coverage and authoring

Gallery: product cards, authored product lists, model article inline photos,
linked hero photos, archive thumbnails, OpenGraph and Article image metadata.
Store: linked figures, product list entries and inline product anchors in article
content. The parser accepts standard quoted href attributes. Use one product per
figure/list example and a link to its exact `/products/<handle>`; unrelated
illustrations without a product link are intentionally untouched. Do not embed
unlinked product photos or multiple products in one replacement container.

New product families require a verified policy entry before automatic substitution;
absence of a policy cannot authorize guessing. Regenerate the Liquid policy with
`node scripts/build-article-example-policy.mjs` after updating the JSON. The current
store article audit covers 111 published articles, maximum 11 distinct product
handles per article. The Liquid resolver reserves original handles first and caps
its lookups at 18, leaving two slots for the existing article hero (Shopify limit20).
Authoring must keep this budget and include other all_products consumers in it.

## Acceptance

Run `npm test`, lint/build, and the optional full store fixtures via
ARTICLE_AUDIT_FIXTURE and ARTICLE_PRODUCT_FIXTURE. Fixtures test unchanged active
content and each referenced product's withdrawal separately. Check desktop and
mobile image load, exact click destination and metadata on the active deployments.
Do not withdraw a real saleable product merely to manufacture a live test.
Record separately simulated removal and an actual naturally occurring removal.

## Rollback

Restore `{{ article.content }}` in MAIN's article-template, leaving unused snippets;
revert the gallery release. Existing article bodies and Shopify product records
remain unchanged throughout. Do not delete product media.
