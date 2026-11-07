# Shopify theme prepublication check

Run `Shopify theme prepublication gate` from GitHub Actions with the exact draft theme ID. Alternatively run `python scripts/shopify-theme-prepublish-gate.py --theme-id ID`. An unsuccessful or incomplete run is a stop: do not publish the draft.

The check confirms the requested preview theme identity on each brand collection, compares series navigation with active, published gallery series and existing live links, and checks product links, images, search, filters and sort controls in HTML. It fails if the gallery, live baseline or preview is unavailable. It does not test browser interactivity, appearance, every product, checkout, or inventory. Complete desktop and mobile preview checks and the normal release checks separately.

This workflow is manually initiated. It does not intercept Shopify's Publish button and does not restrict staff permissions. Run it again after every theme change, including editor changes, and immediately before publication. The previously published theme remains available in Shopify as a rollback.

