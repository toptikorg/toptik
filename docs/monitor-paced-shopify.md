# Production monitor: paced Shopify requests

The existing monitoring behavior is unchanged unless the operator explicitly sets `MONITOR_SHOPIFY_SERIAL_30S=1`. In PowerShell:

```powershell
$env:MONITOR_SHOPIFY_SERIAL_30S = '1'
node scripts/production-visual-smoke.mjs
Remove-Item Env:MONITOR_SHOPIFY_SERIAL_30S
```

The opt-in mode serializes requests to the configured store host, its www/bare equivalent, and Shopify-owned CDN and store hosts. It reads the previous response before starting the next and spaces request starts by at least 30 seconds, including requests following redirects and retry attempts. The 20-second request timeout starts after a request has passed the queue. Other hosts are not throttled by this mode. Shopify response bodies are buffered in memory in this mode.

A Shopify HTTP 429 closes the Shopify request gate for the rest of that run. The failure includes the `Retry-After` header when supplied; it does not retry within the run. `Retry-After` is also respected for 503 responses and redirects. Start no new run before that period has elapsed and platform authorization permits it. Stopping on 429 means the run is incomplete, not a passing monitor.

This setting does not bypass access controls, an approval rejection, or network restrictions. It does not coordinate with other processes, runners, browsers or monitors, so operators must avoid concurrent runs if they need a global request interval. A scan can take many hours because it covers every collection and multicolor product. The scheduled workflow remains unchanged and has not been switched to paced mode.
