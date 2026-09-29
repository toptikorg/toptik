// DISABLED — GAL-009. Machine translation is forbidden for any public content
// (descriptions, titles, specs, metadata), including intermediate drafts.
// This hook is kept for history only: no runtime path imports it (import,
// sync, spec warm-up, product creation and admin save are all disconnected),
// it makes no network request, stores nothing and returns its input unchanged.
// tests/no-machine-translation.test.mjs fails if anything re-connects it.
export async function translateToHebrew(input: string | null) {
  return input;
}
