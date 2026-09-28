import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire, stripTypeScriptTypes } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

// Exercise production functions and the real schema without starting Next or
// importing server-only persistence. All fixtures and source fingerprints are
// local: the suite needs no Shopify/network access or private catalog snapshot.
const require = createRequire(import.meta.url);
const root = new URL("../", import.meta.url);
const dependencyRoots = [
  fileURLToPath(root),
  fileURLToPath(new URL("../../gallery-build-clean-20260928/", import.meta.url)),
];
const dataUrl = code => `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
const readSource = name => readFile(new URL(`../src/lib/carousel/${name}`, import.meta.url), "utf8");
const groupNames = ["curated", "samsonite", "other"];
const rawGroups = await Promise.all(groupNames.map(name => readSource(`editorial-${name}.json`)));
const seedGroups = rawGroups.map(raw => JSON.parse(raw));
const identities = JSON.parse(await readSource("editorial-identities.json"));
const projectionUrl = dataUrl(stripTypeScriptTypes(await readSource("storefront-projection.ts")));
const schemaUrl = dataUrl(stripTypeScriptTypes(await readSource("editorial-schema.ts")).replace(
  /from "zod"/,
  `from ${JSON.stringify(pathToFileURL(require.resolve("zod", { paths: dependencyRoots })).href)}`,
));
let editorialCode = stripTypeScriptTypes(await readSource("editorial.ts"));
for (const [name, value] of [...groupNames.map((name, index) => [name, seedGroups[index]]), ["identities", identities]]) {
  editorialCode = editorialCode.replace(
    new RegExp(`import ${name} from "\\./editorial-${name}\\.json";`),
    () => `const ${name} = ${JSON.stringify(value)};`,
  );
}
editorialCode = editorialCode
  .replace(/from "\.\/editorial-schema"/, () => `from ${JSON.stringify(schemaUrl)}`)
  .replace(/from "\.\/storefront-projection"/, () => `from ${JSON.stringify(projectionUrl)}`);
const { editorialSchema } = await import(schemaUrl);
const { applyEditorial, editorialSeeds, showroomPath } = await import(dataUrl(editorialCode));
const { catalogIdentity, projectStorefront } = await import(projectionUrl);

const checkedAt = "2026-09-28T16:00:00.000Z";
const legacyTranslation = "תרגום ישן של עגלה עם נתונים שלא אומתו";
const normalizeCopy = text => text.normalize("NFKC").replace(/<[^>]*>/g, " ")
  .replace(/&(?:nbsp|amp|quot|apos);|&#\d+;/g, " ")
  .replace(/[^\p{L}\p{N}]+/gu, " ").trim().toLowerCase();
const fingerprint = text => createHash("sha256").update(normalizeCopy(text)).digest("hex");
// SHA-256 of normalized body_html for all 95 public products in the read-only
// 2026-09-28 Shopify review snapshot. Updating editorial must not copy a complete
// storefront description verbatim. These hashes are not a factual-source audit.
const storefrontSourceFingerprints = new Set(
  "0443045809fbeefcfc7ad6672ae109ee455c8379558fe80836d45f3355b85b11 05754e7e2564d58dde13873e61743226dfcb15a99880c2434cce43dc25e3df44 09be1b7887138a2710189f934533c0bb980016988008a92d772c2e8c67e92c1f 0b9ed98b617e60c9354fbe2ad5d4c9601c79a8b5f13ad1cc6f7adf312188e7b4 1286459da1a5c46a58302c48386b8c8b5e47b9c7bc2ec4e0e068f7ed96c8e1d5 1472e76f9d7a7c84032bf506a1f558c876796c707f337ae1a2845f70130499db 165f7989d508bd1d96b7c175a35196b4a011b0cc00764dcbd571fb7ab0a4eca1 17b693a972ce5858ef4186b7a2cd773be1bfb2aa046fdca4333e6401cfd045be 1b5dd5ca6c935873622cd9505fe8f263fc75019adb4a28ccb58385a2b569fb10 1cc7a038c68c8ce151955c28b79a82512882cdaf230d390f35b15205c9d6a6d5 205f532f34f04266575e8000fd26f3aa4667eab6998873f8ed72b2823dbe85ce 206e7b1016c749e950400d566c434ee8d376f4bf4fae924228414aca817b0d34 213a9269969ed01205f0ca74f157a8586977ff6498732407a58fbf6c1bddc5bb 21409fc7046aa8346ab15fae067771d3a776a9c14eb732dce568b19cb2bee4ff 2240bd4cc92d701c5ea0e87ee4d2fde7fff79465b314d74573fe5fe0ed1a808c 24370326afff724a6e22c4131c3fbcf1203a387bebca3bbf9d038379c229343f 253cbf37fab433ffb233ed01c4c0f8309f059f6a50ea4d4dd06e80b73f0bd9d3 254b9c86027d6db8bc05d3261474ffe056138dd77c39790c5dbea1db7a930039 288b133efeab21014d48fdba32f5fc4f1ba2ebf619669f002eea245d45e8a2b2 2975a5ad76c63cabe489a16d5bec006fba6d872349838b0847b8702faba25478 2ac8be54c8ab550dd1c8cc442a33cac9ec73717c8cdda0f2d9dc4baa10a5aec8 2ca27e3c91d221b02e67f63e02284244268a01912d93c4ef909832616b7c09ae 2e4a8ea9d1244a0b24943efbb1aa97baf9db603104541fa177f2fc9787875be8 2fdc8673c3bb87da89a3c5b062d5d24b848b07a93c75feae5b2e6dda8cc59b1f 315d59fbed35fb51cd4925715c9347c54a4729ef90f41de912a7a2fc0f2f18dd 32c0f899f17eeb12125091994281989a098b6848215b09c9b7907a1e819b0fc5 3776002e2205f02b6e8d3ba0ed6db97d820af7ef9017ae104c0eb334a9af7732 38ddf21837d93d42a548b0ec3d1543c910c449d9d67534afd6be376d9317fdb3 4c149e8b167d738d3b00db7ff11a1a486fa448449fa0f7c52d8336ec88346cbd 504365b2a0ae430319f5fc07daf07b2891c0364ffb2195c638b0553beed707eb 5767582f63de0d15f5f5a2d19d888d10e2d4f6320883b9f0566985da578d5452 5f6eab02a753d65bb8ce18b6a261aaf7105a3a9b74b74b9d9bd9d9bd39e204a2 62ac2ce4b3693aa82f4b02ef702e1044287a06e21726f0bba0d5d8e995a039b0 62b51020f69b4bba56eb49f02443991e9ff529868650c9281c1cb5e9e90c4430 63cdb554bbb82550468056e0a19334a0b8d29ba01ac9a5ecc72577f1b287f140 66cc43d3a8c319e6b2ee9532bc58e560dd770b28e06f84409bbdfb5c714a684f 671cdbee0dba572cd578dd1e476dbf49048e4bc7a76352ea03487c030c72719e 67584c9a8eff7a2491e5e29e46dbcc93545d403637c7ac961c079f635b350536 677f80ef61b41628a134f863aafb7b16d54bebb3b47d9dc037b4e34250006b05 69151982a4c5eb3df38ed4197456724df0210ffecb49febee6c1726d7e99519d 6d731601f5292dd8d804ac71dd9c8757c9236e2e2b84567186b7e62c0917ae5c 71cd7de7b3b3b9c1c66326cc8e0e201ff03c6bcabd0f8803f85e217f33ece3d9 71d35b086cc6d915fea57adf02f94874ab7a3df61aa9131bac2791d51e512030 723d5626f073b5c5cb3b52c979677e38d51703b70db89ac53bfc88c29453d48f 7e06bdc731f030fdf7ac957c86176c875be8e0863879ed0e5b00cbe5157fd2e8 7fc8df7db1b2d74c48ae537b8f65e78778596576d7404bc1fe9f7d06492a4391 834fc0cafdf213559a70e41a828b4eafa522a14e6d3af51c1723b0b7bf7233cd 875e95dcf8519d00b70905ba768ea4a4bb0336b5892998618d2a1d2392b3fcca 877903133cb2653c15d03bcbff47b749b60a004b607c711e3a6a9558980536ba 8964276496f2483bfec1c3def9c97d307c33db0052c7495b9b0f428fc6e3ccd3 8d4539400a799dd031174cacc254faa4aacb91c5fe5e0e37a9d2dfd1fdcf9e97 8f34078187c5a882152535af04e81cda844e25cef4e2d1b22d82bea3e01738ea 8f52de6ad1f49c83aa2726cde66c9350bb3d77e8bc2f666d8171ba12a5dafc47 8f592689baf1e2f3cad4bc00b4074fe4edc19757a7bae51268042df8b6340620 9126bae00e29aec4e82c10a2cd01d852be723f108bce0ad7672924ede3d62178 9186004c6f77fa1c067f9a67caf6c8f5458a1e35ca5da47c244d99a9bbb6dbda 923e7915cf92a818075bed8b3de58e280b87a1dd02a09655932f0bed07c259c6 926e8b20cb4fa5eb5b4d0300479bba00b0511a8c569e38ebea7b3985319a0228 9547d7ba4345945a824b500d92bf44e7e497288a92285d9f00e90ac539caccd7 97db645c11122e37a998a684976bf0bd691c08cbd057adc5af2927a9fecd1f47 b03b90cc32f573aedd23d88f56d111f7a68efd405b4189e7991cf743a579bc04 b07c825f2c319c9b5c787e0b3d8a6407520d964d26a6e33cf7a0bb86ea7cc7af b0cdc1e7dd40cfe3b51dfcdc7fc6eedb857edb50dc8dec4304b89c29f3ca249e b7e28533c55c2547fbfc72727e7f5769d235e1c9fa6e9a37cf0b2270c5ae776c b7ffe4d1e6d1c6ad5c0925497cb00489770d8fbfe43061641febab8b788b5cc3 b8ade70461e2392b7001ac62578c332d6ecde0b30262dbcc9a43ae037f1db04b bb74ec1ec5d6c3837d78bd194785bc85bf581d465ffac95aeaf9fbeac36659d8 c096536b1b56d444be9559c369a51c792a55125efe86c6ac50206a0f9af1fcf3 c1ecb9f8df2fa61a5b0b03a3e465218a6cdb946aba21351dec388c8ccd553c55 c4474efd752779f21d316a267af212e30ff6a4adf229c77237f2258bf17a0524 c4d9319af533da58789a0596541a2e3a1bc6926d310324256083b271fa4e2c69 c5f6b4a547db1641770f93245e379f5e24661bf84a1edb7597c14f102e0111ee c6aae93479f6281832906d5a9fe60c736417fb44332d86d60605b7c6df27fcf5 cc2a48213bede31461395a5fc6707fa01b41686ed5b6d7bfbae32b8f7f255d13 d101e4b9015046c073626978fd2240c301e1be9f83a8299d9e4cd47ef0efdae0 d1178c31b7383afd9eabbb03c0e20b278c4ccb475f34813a543c0993cae9130d d5154a158e381e7536df42ce7afab0afcdde43de8e6d48d2e948f66802312dcb d63b920b26d6e232c0eace1b4df97be9f76730bb228a3f0a1bd71a4a8a3fe7ea d82b65e48b1edd7192c21b93593d43eb66eede58d4af3f2db2cda92dea70926a e32e207dee29d154b342ea792b468e08c7bb493dcd687b406c06744e31f42672 e34bd684d3a739af004f5b287741112c00da1737cda337322866682476f3ff77 e388f9b9854cd3ad4e52f98f62571aa440a9149a6a0c269d6d26ccad0319c53e e4eba439e6e79a66489985273074117c887b1419a3b14d72274255342fb94722 e84c27a38dbc22c443f3aab0955bda806b7b33ee8575383fff6fd287407238f2 e88ca39a878f34d36b14390f6078a28034dbf22a261f8c38efc0049e2325c84c ea56fbd055201f375cb443f07405c44382ae4fbc08601f53809fe987e3996c9a ed51583207d973e040d4d2d2b12ada7c3326b2459a19669f19f3dcb169d71974 f00581a67987271c653be5a8c76039015cbf34721f717766a8a028b2664ed491 f0846f02702a01544719beab1f7d2cb9081770f8c82312f97636a5838dfcc16e f0d6aca6f17d166da8a8a07d7795eaec3e74e258c86ec7761f6ab2af12edb6b6 f347de6ed5ac291d45c5b1d7beb727fe014881c0587dc6767914b4fa72e60778 f6319667334b2f5fff93fd4a6b18feb1648beeb50fa51d3a8a45bf0ce3b1b622 f700f3b47e32b6c9e77cdab5faa928d3d91e8ab8587ba124fd0d77308d2feaeb f70ceb31b7f3e8279fcfdfd39c48ecb387f9dbdefbe51776d8f7f4d0661241d6 f937c3a946864093960f499d7040bfd604a805848cc6d55671eb8fab7734edd5".split(" "),
);
const payload = items => ({ items, settings: { autoplayMs: 3500, transitionMode: "shatter-particle" } });
function item(overrides = {}) {
  return {
    id: "shopify-100", title: "דגם מתוך החנות", description: legacyTranslation,
    catalogNumber: "P10ABC01-465-TU", displayOrder: 1, isActive: true,
    coverImagePath: "/curated.jpg", angles: [],
    techSpecs: {
      category: "carryon",
      colors: [{ name: "כחול", hex: "#0000ff" }],
      specs: [{ heading: "תרגום ישן", items: [{ label: "תיאור", value: legacyTranslation }] }],
    },
    ...overrides,
  };
}
function copy(overrides = {}) {
  return {
    expectedSku: "P10ABC01465", title: "שם עברי מאומת לדגם",
    description: "תיאור עברי נפרד המבוסס על מידע שאומת עבור הדגם המסוים.",
    pageTitle: "שם מאומת של הדגם | טופ תיק",
    metaDescription: "פרטי הדגם המאומתים, תמונות ומידע שימושי לבחירה לפני המעבר לחנות.",
    indexable: true, sourceUrls: ["https://www.samsonite.co.uk/"],
    specs: [{ label: "תכונה מאומתת", value: "ערך מאומת" }],
    ...overrides,
  };
}
function storeProduct(variants) {
  return {
    id: "gid://shopify/Product/10", handle: "sample", title: "שם מוצר החנות",
    description: "זהו תיאור החנות המקורי ואין להעתיק אותו לתיאור אולם התצוגה.",
    vendor: "Samsonite", productType: "Luggage", onlineStoreUrl: "https://www.toptik.co.il/products/sample",
    availableForSale: true, updatedAt: checkedAt, collections: [],
    images: [{ url: "https://cdn.shopify.com/sample.jpg", altText: null }], variants,
  };
}
function variant(id, sku, amount, availableForSale = true) {
  return {
    id: `gid://shopify/ProductVariant/${id}`, sku, title: id === "100" ? "כחול" : "שחור",
    availableForSale, image: { url: "https://cdn.shopify.com/sample.jpg" },
    selectedOptions: [{ name: "Color", value: id === "100" ? "Blue" : "Black" }],
    price: { amount, currencyCode: "ILS" },
  };
}

test("all editorial seed IDs are unique across files and retain their schema fields", () => {
  const entries = seedGroups.flatMap(group => Object.entries(group));
  assert.ok(entries.length >= 97, "the reviewed seed set must not silently shrink");
  assert.equal(new Set(entries.map(([id]) => id)).size, entries.length, "duplicate IDs overwrite editorial silently");
  for (const raw of rawGroups) {
    const ids = [...raw.matchAll(/^\s*"((?:shopify-\d+|[a-f0-9-]{36}))"\s*:\s*\{/gm)].map(match => match[1]);
    assert.equal(new Set(ids).size, ids.length, "duplicate keys within a JSON source");
  }
  assert.equal(Object.keys(editorialSeeds).length, entries.length);
  for (const [id, value] of Object.entries(editorialSeeds)) {
    assert.deepEqual(editorialSchema.parse(value), value, id);
    assert.equal(typeof value.expectedSku, "string", `${id}: missing identity binding`);
    assert.equal(value.expectedSku, catalogIdentity(identities[id]), `${id}: non-normalized identity`);
  }
});

test("reviewed titles, descriptions and SEO text are unique and not copied source descriptions", () => {
  const entries = Object.entries(editorialSeeds);
  for (const field of ["title", "description", "pageTitle", "metaDescription"]) {
    const seen = new Map();
    for (const [id, value] of entries) {
      const normalized = normalizeCopy(value[field]);
      assert.ok(normalized, `${id}: empty ${field}`);
      assert.equal(seen.has(normalized), false, `${id}: duplicate ${field} of ${seen.get(normalized)}`);
      seen.set(normalized, id);
    }
  }
  assert.equal(storefrontSourceFingerprints.size, 95);
  for (const [id, value] of entries) {
    assert.equal(storefrontSourceFingerprints.has(fingerprint(value.description)), false, `${id}: copied Shopify body`);
    assert.doesNotMatch(value.description, /עגלה|עגלת|עגלות/, `${id}: retired trolley translation`);
  }
});

test("unknown imports remain visible, noindex and do not repeat storefront copy", () => {
  const original = payload([item()]);
  const result = applyEditorial(original).items[0];
  assert.equal(result.title, original.items[0].title);
  assert.notEqual(result.description, original.items[0].description);
  assert.equal(result.isActive, true);
  assert.equal(result.editorial.indexable, false);
  assert.deepEqual(result.editorial.sourceUrls, []);
  assert.equal(result.editorial.expectedSku, "P10ABC01465");
  assert.equal(result.showroomUrl, "/carousel/products/shopify-100");
});

test("matching normalized identity applies reviewed copy and only reviewed specifications", () => {
  const review = copy();
  const result = applyEditorial(payload([item()]), { "shopify-100": review }).items[0];
  assert.equal(result.title, review.title);
  assert.equal(result.description, review.description);
  assert.equal(result.editorial.indexable, true);
  assert.deepEqual(result.techSpecs.specs, [{ heading: "פרטי הדגם", items: review.specs }]);
  assert.equal(JSON.stringify(result.techSpecs).includes(legacyTranslation), false);
  assert.deepEqual(result.techSpecs.colors, item().techSpecs.colors);
});

test("a stable Shopify variant ID cannot retain old editorial when its SKU changes", () => {
  const result = applyEditorial(payload([item({ catalogNumber: "A-DIFFERENT-MODEL" })]), {
    "shopify-100": copy(),
  }).items[0];
  assert.equal(result.title, "דגם מתוך החנות");
  assert.equal(result.editorial.indexable, false);
  assert.notEqual(result.description, copy().description);
  assert.equal(result.techSpecs.specs[0].items.some(spec => spec.label === "תכונה מאומתת"), false);
});

test("an actual seed is rejected after its stable ID is rebound to a different SKU", () => {
  const [id, seed] = Object.entries(editorialSeeds).find(([key, value]) => key.startsWith("shopify-") && value.indexable && value.expectedSku);
  const accepted = applyEditorial(payload([item({ id, catalogNumber: seed.expectedSku })])).items[0];
  assert.equal(accepted.description, seed.description);
  const rejected = applyEditorial(payload([item({ id, catalogNumber: "REUSED-FOR-ANOTHER-MODEL" })])).items[0];
  assert.equal(rejected.editorial.indexable, false);
  assert.notEqual(rejected.description, seed.description);
});

test("missing SKU or missing override identity cannot approve an unrelated description", () => {
  for (const [row, override] of [
    [item({ catalogNumber: "" }), copy()],
    [item(), copy({ expectedSku: undefined })],
  ]) {
    const result = applyEditorial(payload([row]), { [row.id]: override }).items[0];
    assert.equal(result.editorial.indexable, false);
    assert.notEqual(result.description, override.description);
  }
});

test("an override takes precedence over its seed only for the reviewed identity", () => {
  const [id, seed] = Object.entries(editorialSeeds).find(([, value]) => value.expectedSku);
  const override = copy({ expectedSku: seed.expectedSku });
  const row = item({ id, catalogNumber: seed.expectedSku });
  assert.equal(applyEditorial(payload([row]), { [id]: override }).items[0].description, override.description);
  const stale = copy({ expectedSku: "OLDMODEL" });
  const rejected = applyEditorial(payload([row]), { [id]: stale }).items[0];
  assert.equal(rejected.editorial.indexable, false);
  assert.notEqual(rejected.description, stale.description);
});

test("retired source descriptions and unreviewed specs stay out of fallback and reviewed views", () => {
  for (const overrides of [{}, { "shopify-100": copy({ specs: undefined }) }]) {
    const result = applyEditorial(payload([item({
      commerce: { vendor: "Samsonite", price: "1190.00", currency: "ILS" },
    })]), overrides).items[0];
    assert.equal(result.description.includes(legacyTranslation), false);
    assert.equal(JSON.stringify(result.techSpecs.specs).includes(legacyTranslation), false);
    assert.deepEqual(result.techSpecs.specs[0].items, [
      { label: "מותג", value: "Samsonite" }, { label: "מק״ט", value: "P10ABC01-465-TU" },
    ]);
  }
});

test("each imported item's price and availability come from its own storeVariant", () => {
  const storeVariants = [
    variant("100", "P10ABC01465", "1190.00"),
    variant("101", "MODEL-BLACK", "879.90", false),
  ];
  const snapshot = { products: [storeProduct(storeVariants)], fetchedAt: checkedAt };
  const projected = projectStorefront(payload([]), snapshot);
  const reviews = Object.fromEntries(storeVariants.map(storeVariant => [
    `shopify-${storeVariant.id.split("/").at(-1)}`,
    copy({ expectedSku: catalogIdentity(storeVariant.sku) }),
  ]));
  const result = applyEditorial(projected, reviews);
  for (const storeVariant of storeVariants) {
    const variantId = storeVariant.id.split("/").at(-1);
    const row = result.items.find(entry => entry.id === `shopify-${variantId}`);
    assert.equal(row.commerce.price, storeVariant.price.amount);
    assert.equal(row.commerce.currency, storeVariant.price.currencyCode);
    assert.equal(row.commerce.availableForSale, storeVariant.availableForSale);
    assert.equal(row.commerce.variantId, variantId);
    assert.equal(row.editorial.indexable, true);
  }
  assert.equal(result.items.length, 2, "a public unavailable variant remains in the gallery");
});

test("a matched gallery item also uses the storeVariant price without mutating originals", () => {
  const storeVariant = variant("100", "P10ABC01465", "1259.95");
  const original = payload([item({
    id: "gallery-fixture", commerce: { price: "1.00", currency: "USD", vendor: "Old" },
  })]);
  const before = structuredClone(original);
  const snapshot = { products: [storeProduct([storeVariant])], fetchedAt: checkedAt };
  const snapshotBefore = structuredClone(snapshot);
  const projected = projectStorefront(original, snapshot);
  const result = applyEditorial(projected, { "gallery-fixture": copy() });
  assert.equal(result.items[0].commerce.price, storeVariant.price.amount);
  assert.equal(result.items[0].commerce.currency, storeVariant.price.currencyCode);
  assert.equal(result.items[0].coverImagePath, before.items[0].coverImagePath);
  assert.deepEqual(original, before);
  assert.deepEqual(snapshot, snapshotBefore);
  assert.notEqual(projected.items[0].description, result.items[0].description);
});

test("editorial rendering is deterministic and does not mutate payload or overrides", () => {
  const original = payload([item()]);
  const reviews = { "shopify-100": copy() };
  const before = structuredClone({ original, reviews });
  assert.deepEqual(applyEditorial(original, reviews), applyEditorial(original, reviews));
  assert.deepEqual({ original, reviews }, before);
  assert.equal(showroomPath("shopify-100"), "/carousel/products/shopify-100");
});

test("the actual schema retains identity and rejects malformed editorial", () => {
  assert.equal(editorialSchema.parse(copy()).expectedSku, "P10ABC01465");
  for (const invalid of [
    copy({ title: "x" }),
    copy({ description: "short" }),
    copy({ sourceUrls: ["http://example.com"] }),
    copy({ expectedSku: "x".repeat(101) }),
  ]) assert.equal(editorialSchema.safeParse(invalid).success, false);
});

test("public catalog must not convert transient read failures into partial/noindex content", async () => {
  const source = await readSource("public-catalog.ts");
  assert.doesNotMatch(source, /withoutVerifiedPurchases/);
  assert.doesNotMatch(source, /indexable\s*:\s*false/);
  assert.doesNotMatch(source, /\bcatch\b/, "source failures must propagate to temporary-error responses");
});

for (const failedSource of ["gallery", "storefront", "editorial"]) {
  test(`public catalog rejects a ${failedSource} failure instead of publishing a partial catalog`, async () => {
    const failure = `${failedSource} temporarily unavailable`;
    const stub = (name, source, result) => dataUrl(
      `export async function ${name}() { ${source === failedSource
        ? `throw new Error(${JSON.stringify(failure)});`
        : `return ${JSON.stringify(result)};`} }`,
    );
    const dependencies = {
      "./repository": stub("getCarouselPayload", "gallery", payload([item()])),
      "./storefront-reader": stub("getStorefrontSnapshot", "storefront", { products: [], fetchedAt: checkedAt }),
      "./editorial-repository": stub("readEditorialOverrides", "editorial", {}),
      "./storefront-projection": projectionUrl,
      "./purchase-links": dataUrl("export const LEGACY_VARIANT_IDS = {};"),
      "./editorial": dataUrl("export function applyEditorial(payload) { return payload; }"),
    };
    const code = stripTypeScriptTypes(await readSource("public-catalog.ts")).replace(
      /from "(\.\/[^"]+)"/g,
      (_match, dependency) => {
        assert.ok(dependencies[dependency], `unhandled public catalog dependency: ${dependency}`);
        return `from ${JSON.stringify(dependencies[dependency])}`;
      },
    );
    const { getPublicCatalog } = await import(dataUrl(code));
    await assert.rejects(getPublicCatalog(), error => error.message === failure);
  });
}

