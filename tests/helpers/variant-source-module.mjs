import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
export const variantPolicySource = stripTypeScriptTypes(readFileSync("src/lib/shopify/variant-source-policy.ts", "utf8")).replace(/^export /gm, "");
