// GAL-009: never send manufacturer copy through unattended machine translation.
// Retain the source verbatim for review when no exact-SKU reviewed copy exists.
export async function translateToHebrew(input: string | null) {
  return input;
}
