type Page<T> = { data: T[] | null; error: unknown; count: number | null };

/** Never return a truncated snapshot that an editor could save as deletion. */
export async function readCompletePages<T extends { id: string }>(
  fetchPage: (from: number, to: number) => PromiseLike<Page<T>>,
  maxRows = 100_000,
  pageSize = 500,
): Promise<T[]> {
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 1000) {
    throw new Error("GALLERY_READ_INCOMPLETE");
  }
  const rows: T[] = [];
  const ids = new Set<string>();
  let expected: number | null = null;
  for (let page = 0; page < 1000; page++) {
    const result = await fetchPage(rows.length, rows.length + pageSize - 1);
    if (result.error || !Array.isArray(result.data) || result.count === null ||
        !Number.isInteger(result.count) || result.count < 0 || result.count > maxRows ||
        (expected !== null && result.count !== expected)) {
      throw new Error("GALLERY_READ_INCOMPLETE");
    }
    expected = result.count;
    for (const row of result.data) {
      if (!row.id || ids.has(row.id)) throw new Error("GALLERY_READ_INCOMPLETE");
      ids.add(row.id);
      rows.push(row);
    }
    if (rows.length === expected) return rows;
    if (!result.data.length || rows.length > expected) throw new Error("GALLERY_READ_INCOMPLETE");
  }
  throw new Error("GALLERY_READ_INCOMPLETE");
}
