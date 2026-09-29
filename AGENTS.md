<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

<!-- BEGIN:deployment-workflow -->
# Deployment workflow — owner approval required

**Authority:** the owner's project instructions (`AGENTS.md` in the TopTik project folder) and the Drive master log `קובץ עדכון - toptik-iota.vercel.app/carousel` override this file. Read the master's latest entries before any change; if this file disagrees with them, they win.

**Production URLs:** the gallery lives on **`https://landing.toptik.co.il`** (the apex `toptik.co.il` is the Shopify store). The legacy `https://toptik-iota.vercel.app` serves the same production deployment. Vercel project: `https://vercel.com/toptik/toptik` (team `toptik`). Cutover record: `docs/LANDING-SUBDOMAIN.md`.

**Preview deployments** are protected by Vercel Authentication and currently lack gallery data configuration (GAL-005 in the master log). A Preview marked Ready proves the build, not that the catalog works.

Workflow for any code change:

1. **Branch.** Start a work branch (`claude/...`) from the exact current `origin/master` commit. Never build on a detached or dirty local folder, and never reset, clean or delete existing local work.
2. **Tests.** Run `npm test`, `npm run lint` and `npm run build`. All must pass.
3. **Preview.** Push only the work branch (never `master`, never force) and check its Vercel Preview.
4. **Acceptance.** On the Preview, repeat the exact user action for every requested item (desktop and mobile width) and record expected vs actual, URL, commit and evidence.
5. **Production.** Merge to `master` only after the owner explicitly approves that specific release. Completion then needs three separate proofs: the exact commit on `master`, the Vercel Production deployment Ready, and the public domain serving the change after a fresh load — followed by the same acceptance check on the live site.

Keep the gallery `noindex, follow` hold: do not remove it, submit a sitemap or request indexing without the owner's explicit approval.
<!-- END:deployment-workflow -->

<!-- BEGIN:figma-export-rules -->
# Figma Export — MANDATORY post-capture cleanup

After ANY `generate_figma_design` capture (web → Figma), you MUST immediately follow up with a `use_figma` script that frees ALL elements for unrestricted resizing, otherwise the user cannot edit them. Run BEFORE telling the user "done".

The script must do, recursively over EVERY descendant of the captured frame:

1. `node.locked = false` — unlock everything
2. If `node.layoutMode && node.layoutMode !== 'NONE'` → set `layoutMode = 'NONE'` (kills auto-layout)
3. `node.layoutPositioning = 'AUTO'` (no absolute-positioning lock)
4. `node.constraints = { horizontal: 'MIN', vertical: 'MIN' }` (no scale/stretch on resize of parent)
5. `node.layoutSizingHorizontal = 'FIXED'` and `node.layoutSizingVertical = 'FIXED'` (no FILL/HUG locks)
6. Clear `minWidth/maxWidth/minHeight/maxHeight` if present (set to `null`)
7. `node.clipsContent = false` on EVERY frame (else children get clipped when extending past parent)
8. For TEXT nodes: `node.textAutoResize = 'NONE'` (so user can drag-resize the bounding box freely)
9. **CRITICAL: Convert COMPONENT/COMPONENT_SET masters to plain FRAMEs.** `generate_figma_design` may emit nested `COMPONENT` nodes (not instances of any library — just bare masters embedded in the layout). Their children inherit instance-like edit restrictions and CANNOT be freely resized in the Figma UI. Algorithm:
   - First, detach all `INSTANCE` nodes via `inst.detachInstance()` (deepest-first to avoid stale IDs).
   - Then for every remaining `COMPONENT` / `COMPONENT_SET`: create a sibling `figma.createFrame()` at the same x/y/width/height with cloned fills, `parent.insertChild(idx, newFrame)`, move all children of the component into the new frame via `appendChild`, then `comp.remove()`.
   - Re-run the unlock pass after conversion (new frames need clipsContent=false, etc.).

10. **MOST CRITICAL — Parent-encloses-children fix (the REAL UI resize blocker).** `generate_figma_design` exports children with positions/sizes that often OVERFLOW their parent frame's bounds (e.g. Image 433×125 placed at x=-117 inside a 220×87 parent). When this happens, the Figma **UI hit-testing** treats clicks on the visible child as clicks on the parent, so the user can drag-MOVE but cannot drag-RESIZE the child — there are no corner handles in the clickable area. Fix:
    - For every non-auto-layout FRAME (post step 2), compute the bounding box of all its children in parent-local coords (`min(x), min(y), max(x+width), max(y+height)`).
    - If bbox extends outside parent: shift parent's `x/y` by `(minX, minY)`, compensate every child by `(-minX, -minY)`, then `parent.resize(maxX-minX, maxY-minY)`.
    - Also reset stale auto-layout-derived properties on the parent (residue from the original auto-layout state, even after `layoutMode='NONE'`): `primaryAxisSizingMode='FIXED'`, `counterAxisSizingMode='FIXED'`, `primaryAxisAlignItems='MIN'`, `counterAxisAlignItems='MIN'`, all paddings and `itemSpacing` to `0`.
    - Run TWO passes (children first, then parents) so bounds are stable.
    - Without this, ALL nested elements (logos, icons, text) become un-resizable in the Figma UI even though `node.resize()` works fine via the API.

Always wrap `try/catch` per property — some node types reject some props.
Return counts of what was modified.

This is the difference between a usable Figma file and an unusable one. Never skip it.
<!-- END:figma-export-rules -->

<!-- BEGIN:carousel-image-rules -->
# Carousel product images — CSS rules (DO NOT revert)

File: `src/app/globals.css`

The image area in each carousel card holds THREE absolutely-positioned things stacked over one image:
- the "להגדלה וזוויות נוספות" pill button at the top
- the product image (`.catalog-card-image`) — flex-centered, `object-fit: contain`
- the color swatches pill at the bottom

The image MUST NOT touch or visually crowd either pill. Required CSS:

`.catalog-card-image-wrap`:
- `overflow: hidden`
- `display: flex; align-items: center; justify-content: center` (not `stretch`)
- `padding: 52px 12px 44px` on desktop, `padding: 36px 8px 30px` on mobile (`@media max-width: 767px`).
- The padding is tuned to be the MINIMUM safe distance to the pills: button bottom is at y=46 (desktop) / y=32 (mobile), color pill top is ~38px (desktop) / ~26px (mobile) from the wrap bottom, so the padding sits ~4–6 px outside each pill. Horizontal padding equals the `box-shadow: inset` frame width (12 px desktop / 8 px mobile) so the image rides flush against the inner edge of the white frame.
- **DO NOT increase padding past these values.** The user explicitly asked for "the largest centered image that fits with only a few pixels gap to the pills". Smaller padding violates the pill safety zone; larger padding wastes image surface.

`.catalog-card-image`:
- `object-fit: contain`, `mix-blend-mode: multiply`, transparent background (cream wrap blends white product photo whitespace)
- **No `transform: scale()`** — scale overflows the wrap and crowds the pills. The multiply blend already removes the white halo around products; no extra zoom is needed.

**Do not add `transform: scale(...)` and do not reduce the wrap padding.** Both regressions cause the image to touch or cover the pill buttons. Historical AGENTS.md text mandating `transform: scale(1.4)` was wrong and produced exactly that bug — replaced with this rule on 2026-05-27.
<!-- END:carousel-image-rules -->
