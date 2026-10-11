// Store policy (owner, 2026-10-11): shelf prices are whole shekels, no agorot.
// Any fractional price is rounded UP to the next whole shekel. Cents are
// compared as integers first so binary float noise (e.g. 1690.0000000001)
// cannot push an already-whole price up by one.
export function roundUpToWholeShekel(price: number): number {
  const cents = Math.round(price * 100);
  return Math.ceil(cents / 100);
}
