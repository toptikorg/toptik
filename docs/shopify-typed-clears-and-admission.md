# Explicit typed clears and automatic admission

Local code/SQL/theme candidate only. No live mutation, migration, flag or theme change was performed by this slice.

## Clear semantics

The ordinary typed editor offers an explicit clear checkbox; an untouched or blank input never becomes a delete. Server provenance binds the merchant request ID, exact field, prior public value and per-field Gallery version. The service RPC retains exact identity, owned lease, immutable request receipt and CAS checks. SQL JSON nulls cannot bypass producer/evidence validation.

For Shopify, `metafieldsSet` atomically writes the existing typed value with its observed `compareDigest` and a shared clear marker with the control digest. The native value is retained. An absent target writes only the control marker; any subsequently created native value invalidates that marker and is visible. No `metafieldsDelete`, quantity write, fake zero measurement, supplier fact, or absence-to-delete inference exists.

The marker carries a hash of semantic native value plus render evidence. Arrays preserve order; exact strings remain exact. JSON spacing/object-key order and numeric55 versus55.0 do not resurrect a fact. Parser rejects mismatched hash/render evidence. A later different Shopify value invalidates the marker. Setting the value through the Gallery removes its marker in the same atomic CAS batch. An accepted response loss is reconciled as an acknowledgement without another mutation.

Value-bound marker limitation: changing A→B→A outside this editor can match the earlier clear marker. Shopify Liquid exposes values, not `compareDigest`; this is not revision-level delete CAS. Explicit restoration through the Gallery also removes the marker and avoids that ambiguity.

The Gallery public projection adds only cleared field keys and prior additional-spec rows needed to match labels. It never exposes provenance, request IDs, revisions or private evidence. The display suppresses matching legacy labels; clearing a dimension axis hides the unsplittable legacy dimensions composite, while other typed axes remain available. Raw manufacturer metadata stays unchanged. Additional-spec clears suppress only the previous heading/label pairs. Clear-only overlays survive lazy manufacturer fetch.

## Consumer gate and theme artifact

Outbound explicit clears require both the existing Production typed flag and:

`SHOPIFY_TYPED_SPEC_CLEAR_CONSUMER=typed-spec-clear-aware-v2`

Keep this unset until root deploys and verifies the matching MAIN theme artifact. Ordinary set operations and independent admission use the existing typed flag only.

Candidate: `work/shopify-typed-spec-clear-renderer-20261001/` in the root workspace. `build.json` pins source/candidate hashes. Builder replaces only the reviewed typed-spec block in published sourcec8edd282. Prefix/suffix and legacy fallback bytes are retained. Current/expected values are hashed using the same Liquid serializer; measurements compare exact numeric value and unit. JSON comparison uses fixed semantic key order and refuses matching when section/row limits are exceeded. The display limits remain30/80. Wrapper exposes `data-toptik-clear-contract="typed-spec-clear-aware-v2"` for public live acceptance. No theme was applied here.

## Automatic independent admission

New additive migration `20261001_typed_spec_copy_admission.sql` permits the existing private work queue to reference an exact enabled copy approval before typed eligibility exists. The admission RPC rechecks actual binding, raw SKU uniqueness, variant/handle/publication and the owned product lease. Existing disabled typed approvals remain disabled.

Recovery queues missing approved identities; future copy-approval inserts/enabled updates also queue them. The existing worker claims a bounded job, fresh-reads the exact single published Shopify variant, creates typed eligibility, and stores all19 **independent** baselines: Gallery absent, Shopify observed. It never parses legacy dimension text and never performs initial cross-system writes. A following real merchant edit follows normal two-way merge. Failed identities use the existing finite queue attempts; there is no unbounded inline loop.

Migrations, after `20260930_verified_typed_spec_sync.sql`:

1. `20261001_typed_spec_explicit_clears.sql` (overrides editor/projection RPCs; old migration untouched).
2. `20261001_typed_spec_copy_admission.sql` (queue FK/admission/trigger/recovery; private RLS retained).

Migration application alone creates no approval, baseline or queue row. Activation/recovery remain runtime gated.

## Checks and live acceptance

- `node --test tests/typed-spec-*.test.mjs`: focused actual core/adapter/worker/route/display/deadline regressions, including clear response-loss recovery and independent auto admission.
- `node scripts/verify-typed-clears-admission-sql.mjs`:44 assertions against actual82/78 migration chain, real worker/SQL bridge, zero stubbed functions or external calls.
- Theme `node --test work/shopify-typed-spec-clear-renderer-20261001/renderer.test.mjs`:20 LiquidJS cases with real adapter marker fixtures, stale values, absent fields, partial composite handling,81st row/31st section, escaped HTML and exact consumer marker.

Root still must verify the deployed MAIN source hash and public marker, then a real exact-product clear and restoration through ordinary authenticated editor/webhook paths. Local LiquidJS is not Shopify production rendering proof. No live completion claim is made.

Official references checked: [Liquid metafield values](https://shopify.dev/docs/api/liquid/objects/metafield), [measurement value/unit](https://shopify.dev/docs/api/liquid/objects/measurement), [json](https://shopify.dev/docs/api/liquid/filters/json), [sha256](https://shopify.dev/docs/api/liquid/filters/sha256). These document consumer types/filters, not cross-runtime raw JSON byte equivalence.
