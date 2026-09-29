import { lookup as dnsLookup } from "node:dns/promises";
import { approvedSourceUrl, isPrivateAddress } from "./source-allowlist";

// Server-side fetch for manufacturer spec pages (admin/cron path only).
// Every hop, including each redirect target, must be an approved HTTPS host
// that resolves only to public addresses. Redirects are followed manually so a
// source cannot bounce the request to an unapproved or internal destination.
export class UnsafeSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeSourceError";
  }
}

type LookupFn = (hostname: string) => Promise<ReadonlyArray<{ address: string }>>;
type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

const MAX_REDIRECTS = 3;
const defaultLookup: LookupFn = (hostname) => dnsLookup(hostname, { all: true, verbatim: true });

export async function safeSourceFetch(
  rawUrl: string,
  init: RequestInit = {},
  deps: { fetch?: FetchFn; lookup?: LookupFn } = {},
): Promise<Response> {
  const doFetch: FetchFn = deps.fetch ?? ((input, options) => fetch(input, options));
  const lookup = deps.lookup ?? defaultLookup;
  let current = rawUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const target = approvedSourceUrl(current);
    if (!target) throw new UnsafeSourceError("Source is not an approved manufacturer HTTPS address");
    const addresses = await lookup(target.hostname);
    if (addresses.length === 0 || addresses.some((entry) => isPrivateAddress(entry.address))) {
      throw new UnsafeSourceError("Source host resolves to a non-public address");
    }
    const response = await doFetch(target.toString(), { ...init, redirect: "manual" });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new UnsafeSourceError("Redirect without a location");
      current = new URL(location, target).toString();
      continue;
    }
    return response;
  }
  throw new UnsafeSourceError("Too many redirects");
}
