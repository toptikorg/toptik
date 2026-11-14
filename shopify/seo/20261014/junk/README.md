# Junk URL rules, approval only

Adds four rules to the wildcard user-agent group while retaining every Shopify default group, rule and sitemap declaration. The requested constraint rule is included; a second rule also covers constraint after another query parameter. Existing cart/search/account rules are untouched.

## Findings, 2026-10-14

* Current MAIN theme: 186955038970. Read 134 Liquid files plus its JavaScript assets. No code generating a literal product `/tag` link was found. None of 244 scoped live product HTML responses contained an href ending in `/tag`. The GSC examples were last crawled in August. A removed generator cannot be identified as current code without evidence. No unrelated valid tag navigation was removed.
* `layout/theme.liquid:27` is an existing page-path `/tag` guard, not a link generator. This PR does not claim it removed the source of 35 historical URLs.
* `/products/` currently returns 200. Shopify reserves `/products` as a fixed path and redirects only broken URLs. A theme cannot emit a server 301. No JavaScript/meta-refresh substitute was added. This remains open.
* Platform restriction: https://help.shopify.com/en/manual/online-store/menus-and-links/url-redirect
* The 35 valid canonical alternates include some `/tag` URLs. Their canonical code stays unchanged; the explicitly requested robots pattern also matches those URLs. The existing 201 excluded URLs retain their default rules.

## Release gates

No upload, merge, deployment, URL Inspection or GSC validation performed. After Tal approves and publishes, compare the full live robots.txt with the baseline, check the four added rules, then use validation only in the 43-URL duplicate-without-canonical report. Do not validate unrelated reports.
