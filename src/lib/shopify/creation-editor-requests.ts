/** Ignore stale responses without cancelling an accepted save/mutation. */
export function createCreationEditorRequestGate() {
  let generation = 0;
  return {
    invalidate() { generation++; },
    async run<T>(request: () => Promise<T>, success: (value: T) => void,
      failure: (error: unknown) => void, settled: () => void) {
      const current = ++generation;
      try { const result = await request(); if (current === generation) success(result); }
      catch (error) { if (current === generation) failure(error); }
      finally { if (current === generation) settled(); }
    },
  };
}
