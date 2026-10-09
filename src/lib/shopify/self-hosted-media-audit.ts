// Read-only reconciliation audit for the "self-hosted gallery media" glitch.
//
// Background. Every imported carousel item is born with its images re-hosted in
// the Supabase `carousel-media` bucket (see import-handler.ts). The gallery is
// meant to later point each angle at the matching Shopify store media so the two
// platforms stay in lockstep; the automatic adoption in media-planning-observation
// only fires once an angle already points at a store cdn URL, so a self-hosted
// angle is structurally invisible to it. A one-time backlog of items never made
// that transition. This audit is the standing guard so the condition can never
// again sit unnoticed: it FLAGS self-hosted angles as candidates for human review.
//
// It deliberately does NOT declare a glitch, link anything, or mutate either
// platform. The existence of store media for a product does not prove a given
// gallery photo exists there (different angle / crop / set), so every link stays
// human-verified against image, angle, SKU and colour. The audit only narrows
// where a reviewer should look.
//
// Exemptions are documented and explicit — see SELF_HOSTED_AUDIT_EXEMPTIONS.

export type SelfHostedAuditAngle = { angleOrder: number; angleKey: string; imagePath: string };
export type SelfHostedAuditItem = { id: string; catalogNumber: string | null; angles: SelfHostedAuditAngle[] };

export type SelfHostedAuditCandidate = {
  itemId: string;
  catalogNumber: string | null;
  selfHostedAngles: Array<{ angleOrder: number; angleKey: string }>;
};

export type SelfHostedAuditResult = {
  // Items a reviewer should check (self-hosted angles that are not exempt).
  candidates: SelfHostedAuditCandidate[];
  candidateAngleCount: number;
  // How many self-hosted angles were suppressed by a documented exemption.
  exemptAngleCount: number;
  scannedItems: number;
};

// Legitimately self-hosted, confirmed and exempt from the candidate list.
//
// `fullItem` — the Shopify store has no product/media to adopt from, so the
// gallery's own copy is correct (not a glitch):
//   ORI05500.024, ORI05500.909 — single-angle items with no store product.
//   P10ZJT06-24U-TU            — decision 5: the product is intentionally not
//                                published to the store; self-hosting is correct.
//
// `angles` — the item IS linked to the store for every angle that has a store
// counterpart, but these specific angles are unique gallery photos the store
// set does not contain (verified visually 2026-10-10), so they stay self-hosted:
//   P10JNV0508Q   angles 1,2,3 — straight front + two side profiles; the store
//                                set is 3/4 hero / backpack / open only.
//   P10JNV05465   angle 5      — a second front hero with no distinct store copy.
//   P10SZV24-05J-TU angles 1,2,3 — straight front + angled-handle-up + straight
//                                back; the store set for this colour differs.
export const SELF_HOSTED_AUDIT_EXEMPTIONS: ReadonlyArray<
  { catalogNumber: string; fullItem: true } | { catalogNumber: string; angles: number[] }
> = [
  { catalogNumber: "ORI05500.024", fullItem: true },
  { catalogNumber: "ORI05500.909", fullItem: true },
  { catalogNumber: "P10ZJT06-24U-TU", fullItem: true },
  { catalogNumber: "P10JNV0508Q", angles: [1, 2, 3] },
  { catalogNumber: "P10JNV05465", angles: [5] },
  { catalogNumber: "P10SZV24-05J-TU", angles: [1, 2, 3] },
];

// A gallery angle is self-hosted when it is served from our own Supabase
// `carousel-media` bucket rather than the Shopify store CDN.
export function isSelfHostedImagePath(imagePath: string): boolean {
  if (typeof imagePath !== "string") return false;
  if (imagePath.includes("cdn.shopify.com/")) return false;
  return /\.supabase\.co\/storage\/v1\/object\/public\/carousel-media\//.test(imagePath);
}

function exemptAngleSet(catalogNumber: string | null): { full: boolean; angles: Set<number> } {
  const angles = new Set<number>();
  if (!catalogNumber) return { full: false, angles };
  for (const rule of SELF_HOSTED_AUDIT_EXEMPTIONS) {
    if (rule.catalogNumber !== catalogNumber) continue;
    if ("fullItem" in rule) return { full: true, angles };
    for (const a of rule.angles) angles.add(a);
  }
  return { full: false, angles };
}

// Pure, deterministic, side-effect free. Flags candidates; never fixes.
export function auditSelfHostedMedia(items: ReadonlyArray<SelfHostedAuditItem>): SelfHostedAuditResult {
  const candidates: SelfHostedAuditCandidate[] = [];
  let candidateAngleCount = 0;
  let exemptAngleCount = 0;
  for (const item of items) {
    const selfHosted = (item.angles ?? []).filter(a => isSelfHostedImagePath(a.imagePath));
    if (selfHosted.length === 0) continue;
    const { full, angles: exemptAngles } = exemptAngleSet(item.catalogNumber);
    if (full) { exemptAngleCount += selfHosted.length; continue; }
    const flagged = selfHosted.filter(a => !exemptAngles.has(a.angleOrder));
    exemptAngleCount += selfHosted.length - flagged.length;
    if (flagged.length === 0) continue;
    candidateAngleCount += flagged.length;
    candidates.push({
      itemId: item.id,
      catalogNumber: item.catalogNumber,
      selfHostedAngles: flagged
        .map(a => ({ angleOrder: a.angleOrder, angleKey: a.angleKey }))
        .sort((x, y) => x.angleOrder - y.angleOrder),
    });
  }
  candidates.sort((a, b) => (a.catalogNumber ?? "").localeCompare(b.catalogNumber ?? ""));
  return { candidates, candidateAngleCount, exemptAngleCount, scannedItems: items.length };
}
