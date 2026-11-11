/** Browser-side verification of the one fixed diagnostic download. No request or writes here. */
export async function verifyKlDiagnosticDownload(response: Response, cryptoApi: Pick<Crypto, "subtle"> = globalThis.crypto) {
  const h = response.headers, mime = h.get("content-type") ?? "";
  const formats: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/avif": "avif" };
  const sha256 = h.get("x-content-sha256") ?? "", length = h.get("content-length") ?? "";
  const fail = () => { throw new Error("MEDIA_DIAGNOSTIC_DOWNLOAD_INVALID"); };
  if (!response.ok || !formats[mime] || !/^[a-f0-9]{64}$/.test(sha256) || !/^[1-9]\d{0,7}$/.test(length) ||
      Number(length) > 8 * 1024 * 1024 || h.get("x-toptik-media-id") !== "gid://shopify/MediaImage/40701188604154" ||
      h.get("x-toptik-product-id") !== "gid://shopify/Product/9382883918074" ||
      h.get("x-toptik-variant-id") !== "gid://shopify/ProductVariant/50148815929594" ||
      h.get("x-toptik-observation") !== "new-capture-not-historical-recovery") {
    await response.body?.cancel().catch(() => {}); fail();
  }
  const width = Number(h.get("x-toptik-image-width")), height = Number(h.get("x-toptik-image-height"));
  if (![width, height].every(n => Number.isSafeInteger(n) && n > 0 && n <= 16000) || width * height > 25000000) {
    await response.body?.cancel().catch(() => {}); fail();
  }
  const reader = response.body?.getReader(); if (!reader) fail();
  const chunks: Uint8Array[] = []; let size = 0;
  const deadline = Date.now() + 40000;
  try {
    while (true) {
      const ms = deadline - Date.now(); if (ms <= 0) fail();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const part = await Promise.race([reader!.read(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("MEDIA_DIAGNOSTIC_DOWNLOAD_TIMEOUT")), ms);
      })]).finally(() => { if (timer) clearTimeout(timer); });
      if (part.done) break;
      size += part.value.byteLength;
      if (size > Number(length) || size > 8 * 1024 * 1024) fail();
      chunks.push(part.value);
    }
  } catch (error) { void reader!.cancel().catch(() => {}); throw error; }
  finally { reader!.releaseLock(); }
  if (size !== Number(length)) fail();
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  const digest = new Uint8Array(await cryptoApi.subtle.digest("SHA-256", bytes));
  if ([...digest].map(b => b.toString(16).padStart(2, "0")).join("") !== sha256) fail();
  const filename = `KL966005-image3-${sha256.slice(0, 12)}.${formats[mime]}`;
  return { bytes, filename, mime, receipt: { sku: "KL966005", sha256, byteLength: size, width, height,
    headers: Object.fromEntries([...h.entries()].filter(([key]) => /^(?:x-toptik-|x-content-sha256$|x-vercel-id$|date$|content-type$|content-length$|cache-control$)/.test(key))) } };
}
