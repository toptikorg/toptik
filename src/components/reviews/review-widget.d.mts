export type ReviewBranch = { id: string; name: string; address: string; reviewUrl: string; qrPath: string; verified: boolean };
export function validReviewBranches(branches: unknown): boolean;
export function mountReviewWidget(host: HTMLElement, branches: ReviewBranch[], options?: {assetOrigin?: string; qrSources?: Record<string,string>}): () => void;
