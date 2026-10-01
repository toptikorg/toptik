/** Cookies alone cannot authorize a cross-origin editor mutation. */
export function allowsGallerySessionRequest(
  method: string, requestOrigin: string, headers: Pick<Headers, "get">, sessionMutation = false,
): boolean {
  const site = headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return false;
  if (!sessionMutation && (method === "GET" || method === "HEAD")) return true;
  const origin = headers.get("origin");
  return Boolean(origin && origin !== "null" && origin === requestOrigin);
}

/** A supplied return URL never redirects credentials to an external site. */
export function galleryLoginDestination(value: unknown): "/admin" | "/dashboard" {
  return value === "/admin" ? "/admin" : "/dashboard";
}
