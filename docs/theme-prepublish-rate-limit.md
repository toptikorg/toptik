# Shopify theme gate: paced requests and HTTP 429

The Python HTML prepublication gate spaces Shopify request starts by at least
30 seconds, serializes requests through the same transport and waits until each
response body finishes before starting the next. Automatic redirects to a
Shopify host are counted as requests too. The preview opener has a cookie jar;
the separate live opener has no cookie processor. The existing User-Agent
remains unchanged.

By default the first HTTP 429 stops the entire gate with a non-zero result. If
supplied, `Retry-After` appears in the error. The optional `--retry-429-once`
allows one retry across the entire run only if `Retry-After` is a valid
non-negative integer number of seconds or an HTTP-date. The wait is measured
from response arrival, with the 30-second request-start spacing also enforced.
A missing or invalid value, or a subsequent 429, stops the gate immediately.
The optional `--report-json PATH` writes local request timings, status codes,
redirect hops, counters and brand/category results with validation errors.
The recorded response time means headers arrived; it is not a body-completion
time. URLs omit credentials and query strings except numeric `variant` and
`preview_theme_id`; request and response headers are not recorded.
The gate
does not bypass any access control, rejected authorization, signature rule,
network restriction or platform rate limit. Use an authorized route. Different
processes and other browsers are not coordinated by the in-process pacing.
The separate WebKit logo test in the workflow does not use this transport and
is not paced by this change. The whole workflow therefore does not yet enforce
30-second spacing for every request.

Run the offline regression tests with:

```sh
python -m unittest tests.test_shopify_theme_prepublish_gate -v
```

Tests use a simulated clock and simulated transport; they do not prove that
the production theme or Shopify's HTTP 429 has been fixed. A full gate run
requires 13 Shopify requests in the normal case, hence at least six minutes
of pacing alone, plus request and setup time. The manual workflow timeout is
20 minutes to allow for pacing, package installation and WebKit checks; slow
responses, redirects or installation may still cause a timeout. Do not infer a
passing release gate from an interrupted run.

The optional retry can extend the duration beyond the workflow timeout, and no
retry is proof that the underlying platform limitation is resolved. A normal
run has 13 Shopify requests; with the option it has at most 14 when there are no
redirects. Redirect hops are recorded separately and can increase that count.

The separate `--reuse-preview-session` opt-in activates preview with the theme
ID on the first preview request, then uses ordinary category URLs through the
same in-memory preview cookie jar. Live brand baselines still use the separate
cookie-free opener. Every preview brand and category HTML must contain the
requested `Shopify.theme.id`; a mismatch or missing ID stops immediately, with
no session reinitialization. The report records the opt-in and initialization
status and each preview page's observed theme ID. Cookies are never saved to
the report or disk. An explicitly enabled 429 retry may repeat the same failed
initial request once; no extra preview initialization occurs after mismatch or
an initialization error. This is an unverified protocol experiment, not a
resolution or a bypass of HTTP 429.

The original gate was tested with a fake gallery response and a simulated 429
on the first Shopify request: it made 10 transport calls instead of stopping
after two. The regression now verifies exactly two calls and the reported
`Retry-After`, without network access.

## Explicit signature preflight

HTTP 429 is reported as `RATE_LIMITED`, with the server's Retry-After when
available and `rate_limit_cause: unclassified`. It is never evidence by itself
that a signature is missing, expired or invalid. No signature value, credential
file or credential environment variable is read by this gate.

`--require-signature` enables a fail-closed preflight before any request,
including the Gallery API. `--signature-configured` is a non-secret operator
declaration, and `--signature-expires-at` accepts a timezone-aware ISO8601
expiry. These flags do not attach or cryptographically verify a signature.
The codes mean:

* `SIGNATURE_MISSING`: required configuration was not explicitly declared.
* `SIGNATURE_INVALID`: required expiry is missing, malformed or lacks timezone.
* `SIGNATURE_EXPIRED`: the declared expiry has passed, including while waiting
  for pacing, a retry or a redirect.
* `SIGNED_TRANSPORT_UNAVAILABLE`: metadata is present but no explicitly supplied
  external signed opener exists. The command-line gate has no built-in signer,
  so future expiry alone never causes an unsigned run in required mode.
* `SIGNED_TRANSPORT_MISSING_HEADERS`: an external opener did not attach all
  three signature header names before the request. Only names are checked;
  values are never inspected or reported. Presence is not validity proof.
* `SIGNED_TRANSPORT_SCOPE_INVALID`: a redirect would cross the boundary between
  plain and signed transports, or leave the authorized Shopify origin. It is
  blocked before reaching the redirect target, without an unsigned fallback.

An authorized programmatic integration may supply `SignatureContext` together
with `signed_opener_factory` to `run` or `ThemeGateTransport`. The factory must
retain every supplied urllib handler and attach its headers before the late
guard. Authentication remains the external adapter's responsibility; this API
does not implement a signer or authorize a previously denied operation.
Existing wrapper arguments remain compatible. A wrapper that does not opt into
this context still has no locally verified signature metadata in the report.

The external signed factory is used only for `https://www.toptik.co.il:443`,
with no userinfo and the default port or explicit443. Gallery and other direct
URLs use a separate plain opener. The plain opener strips the three signature
header names late, including accidentally inherited default headers. A signed
redirect to Gallery/another host/http/another port/userinfo is blocked; a plain
redirect into the signed Shopify origin is also blocked. This avoids silently
sending credentials elsewhere or silently entering Shopify unsigned.

Reports contain non-secret metadata only and label it operator metadata, not
signature verification. Invalid expiry inputs are not echoed. A signature
preflight block has `result: blocked`; it cannot be a passing release gate.
The CLI's optional retry remains off by default and globally limited to one
explicit opt-in retry. Existing DOM, series, product-link and filter checks
are unchanged. CI runs the offline Python regressions on pull requests; they
use fake clocks/openers and never run a storefront scan.
