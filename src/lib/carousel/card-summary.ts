/** Short presentation copy only. The complete description remains available. */
export function productCardSummary(description: string, limit = 180): string {
  const first = description.trim().split(/\n\s*\n/)[0].replace(/\s+/g, " ");
  const characters = Array.from(first);
  if (characters.length <= limit) return first;
  const bounded = characters.slice(0, limit).join("");
  const word = bounded.lastIndexOf(" ");
  return `${(word > limit / 2 ? bounded.slice(0, word) : bounded).trimEnd()}…`;
}
