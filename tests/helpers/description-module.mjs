import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";

const source = readFileSync(new URL("../../src/lib/shopify/description-document.ts", import.meta.url), "utf8")
  .replace('from "parse5"', `from ${JSON.stringify(import.meta.resolve("parse5"))}`);
export const descriptionModuleUrl = `data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString("base64")}`;
export const descriptionHelpers = await import(descriptionModuleUrl);
