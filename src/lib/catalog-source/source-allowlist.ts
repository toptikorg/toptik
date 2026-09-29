// Approved manufacturer sources for product tech specs (GAL-025).
// Only these exact HTTPS hosts may ever be fetched server-side, and only by the
// authenticated admin/cron path. The public route never fetches a URL at all.
// Hosts are the manufacturer sites already used by existing product records.
// huntleather.com (a retailer used by two BXL381 records) is deliberately not
// approved; those records keep their cached specs.
export const APPROVED_SOURCE_HOSTS: ReadonlySet<string> = new Set([
  "bricstore.com",
  "mandarinaduck.com",
  "www.samsonite.co.uk",
  "www.samsonite.com.au",
  "www.samsonite.com.sg",
  "www.samsonite.de",
  "www.samsonite.fi",
  "www.samsonite.se",
]);

const MAX_URL_LENGTH = 2048;

function isIpLiteral(hostname: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.startsWith("[") || hostname.includes(":");
}

// Returns a normalized URL (no fragment) when the input is an approved
// manufacturer HTTPS address on the default port without credentials; else null.
export function approvedSourceUrl(raw: unknown): URL | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_URL_LENGTH || raw.trim() !== raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port !== "") return null;
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!hostname || isIpLiteral(hostname) || !APPROVED_SOURCE_HOSTS.has(hostname)) return null;
  url.hash = "";
  return url;
}

function ipv4ToInt(address: string): number | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

const PRIVATE_V4: ReadonlyArray<[string, number]> = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 4], ["240.0.0.0", 4],
];

function isPrivateV4(address: string): boolean {
  const value = ipv4ToInt(address);
  if (value === null) return true;
  return PRIVATE_V4.some(([base, bits]) => {
    const size = 2 ** (32 - bits);
    const start = ipv4ToInt(base)!;
    return value >= start && value < start + size;
  });
}

// True for loopback, private, link-local, CGNAT, multicast, reserved and
// unparseable addresses. Unknown input is treated as unsafe.
export function isPrivateAddress(address: string): boolean {
  const a = address.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (a.includes(".") && !a.includes(":")) return isPrivateV4(a);
  if (!a.includes(":")) return true;
  const mapped = /^(?:0{0,4}:){0,5}(?:0{0,4}:)?ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(a) ?? /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(a);
  if (mapped) return isPrivateV4(mapped[1]);
  if (a === "::" || a === "::1") return true;
  const first = parseInt(a.split(":")[0] || "0", 16);
  if (Number.isNaN(first)) return true;
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((first & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (a.startsWith("2001:db8:") || a.startsWith("64:ff9b:")) return true; // documentation, NAT64
  return false;
}
