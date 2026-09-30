import { parse, parseFragment, serialize, type DefaultTreeAdapterTypes } from "parse5";

type Node = DefaultTreeAdapterTypes.ChildNode;
type Element = DefaultTreeAdapterTypes.Element;
const HTML_NAMESPACE = "http://www.w3.org/1999/xhtml";
const BLOCKS = new Set(["p", "div", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "pre", "section", "article", "header", "footer", "ul", "ol", "dl", "table", "figure", "figcaption", "details", "summary"]);
const NON_CONTENT = new Set(["script", "style", "template", "noscript", "iframe", "object", "embed", "svg", "math", "form", "input", "textarea", "select", "button"]);
const SAFE_TAGS = new Set(["a", "abbr", "address", "article", "aside", "b", "bdi", "bdo", "blockquote", "br", "caption", "center", "cite", "code", "col", "colgroup", "dd", "del", "details", "dfn", "div", "dl", "dt", "em", "figcaption", "figure", "font", "footer", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "i", "img", "ins", "kbd", "li", "main", "mark", "ol", "p", "pre", "q", "rp", "rt", "ruby", "s", "samp", "section", "small", "span", "strike", "strong", "sub", "summary", "sup", "table", "tbody", "td", "tfoot", "th", "thead", "time", "tr", "u", "ul", "var", "wbr"]);
const URL_ATTRIBUTES = new Set(["href", "src", "cite", "longdesc", "poster", "background"]);

function isElement(node: Node): node is Element {
  return "tagName" in node;
}

export function plainDescriptionToHtml(text: string): string {
  if (!text) return "";
  const escape = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
  return text.replaceAll("\r\n", "\n").split(/\n{2,}/)
    .map(paragraph => `<p>${escape(paragraph).replaceAll("\n", "<br>")}</p>`).join("");
}

/** Display text is derived from a real HTML parser, including entities/tables. */
export function descriptionTextFromHtml(html: string): string {
  const read = (node: Node): string => {
    if (node.nodeName === "#text") return (node as DefaultTreeAdapterTypes.TextNode).value;
    if (!isElement(node)) return "";
    if (NON_CONTENT.has(node.tagName) || node.attrs.some(attr => attr.name === "hidden")) return "";
    if (node.tagName === "br") return "\n";
    const text = node.childNodes.map(read).join("");
    if (node.tagName === "td" || node.tagName === "th") return text + "\t";
    if (node.tagName === "tr" || node.tagName === "li" || node.tagName === "dt" || node.tagName === "dd") return text.trimEnd() + "\n";
    return text + (BLOCKS.has(node.tagName) ? "\n\n" : "");
  };
  return parseFragment(html).childNodes.map(read).join("")
    .replaceAll("\u00a0", " ").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Compare equivalent HTML without changing the original stored string. */
export function canonicalDescriptionHtml(html: string): string {
  const fragment = parseFragment(html);
  const canonicalize = (children: Node[], preserveWhitespace = false, parentTag?: string) => {
    // Shopify pretty-prints list children. Ignore only ASCII whitespace nodes
    // directly between li elements. Inline word spacing and block boundaries
    // stay significant. CSS hooks and whitespace-sensitive elements fail closed.
    const plainList = !preserveWhitespace && (parentTag === "ul" || parentTag === "ol") &&
      children.every(node => node.nodeName === "#comment" ||
        (isElement(node) && node.tagName === "li") ||
        (node.nodeName === "#text" && /^[\t\n\f\r ]+$/.test((node as DefaultTreeAdapterTypes.TextNode).value)));
    for (let i = children.length - 1; i >= 0; i--) {
      const node = children[i];
      if (node.nodeName === "#comment") { children.splice(i, 1); continue; }
      if (plainList && node.nodeName === "#text") { children.splice(i, 1); continue; }
      if (!isElement(node)) continue;
      node.attrs.sort((a, b) => `${a.namespace ?? ""}:${a.name}`.localeCompare(`${b.namespace ?? ""}:${b.name}`));
      const sensitive = preserveWhitespace || node.tagName === "pre" || node.tagName === "code" ||
        node.attrs.some(attr => ["class", "id", "style"].includes(attr.name));
      canonicalize(node.childNodes, sensitive, node.tagName);
    }
  };
  canonicalize(fragment.childNodes);
  return serialize(fragment).trim();
}

/** Equivalent rich pairs may derive different plain line spacing from Shopify's
 * list indentation. Accept that only when BOTH plain strings are exact
 * projections of their own HTML. Never normalize stored strings or legacy text.
 */
export function descriptionPairsEquivalent(
  left: { description: string; descriptionHtml?: string | null },
  right: { description: string; descriptionHtml?: string | null },
): boolean {
  const leftHtml = left.descriptionHtml ?? plainDescriptionToHtml(left.description);
  const rightHtml = right.descriptionHtml ?? plainDescriptionToHtml(right.description);
  if (canonicalDescriptionHtml(leftHtml) !== canonicalDescriptionHtml(rightHtml)) return false;
  if (left.description === right.description) return true;
  return typeof left.descriptionHtml === "string" && typeof right.descriptionHtml === "string" &&
    descriptionTextFromHtml(leftHtml) === left.description && descriptionTextFromHtml(rightHtml) === right.description;
}

function safeUrl(value: string, allowContact: boolean): boolean {
  // parse5 has already decoded numeric/named entities in attribute values.
  const compact = value.replace(/[\u0000-\u0020\u007f]/g, "").trim();
  if (!compact) return true;
  const scheme = /^([a-z][a-z\d+.-]*):/i.exec(compact)?.[1].toLowerCase();
  return !scheme || scheme === "https" || scheme === "http" || (allowContact && (scheme === "mailto" || scheme === "tel"));
}

/** Validate deliberate rich edits; never sanitize away data silently. */
export function assertSafeDescriptionHtml(html: string): void {
  const fail = () => { throw new Error("SYNC_DESCRIPTION_HTML_UNSAFE"); };
  if (html.length > 200_000 || html.includes("\u0000")) fail();
  const inspect = (nodes: Node[], documentWrappers = false) => {
    for (const node of nodes) {
      if (!isElement(node)) continue;
      const wrapper = documentWrappers && ["html", "head", "body"].includes(node.tagName);
      if (node.namespaceURI !== HTML_NAMESPACE || (!SAFE_TAGS.has(node.tagName) && !wrapper)) fail();
      for (const attr of node.attrs) {
        const name = attr.name.toLowerCase();
        if (attr.namespace || /^on/i.test(name) || ["srcdoc", "autofocus", "is", "nonce", "form", "formaction"].includes(name)) fail();
        if (URL_ATTRIBUTES.has(name) && !safeUrl(attr.value, node.tagName === "a" && name === "href")) fail();
        if (name === "srcset" && attr.value.split(",").some(candidate => !safeUrl(candidate.trim().split(/\s+/)[0], false))) fail();
        // Passive inline presentation is preserved. External-resource CSS,
        // escaped identifiers and legacy script-capable CSS are not accepted.
        if (name === "style" && /\\|\/\*|@|url\s*\(|expression\s*\(|behavior\s*:|-moz-binding/i.test(attr.value)) fail();
      }
      inspect(node.childNodes, documentWrappers);
    }
  };
  inspect(parseFragment(html).childNodes);
  // Fragment parsing omits html/body wrappers and their attributes. Inspect a
  // full document too so wrapper event handlers cannot bypass validation.
  inspect(parse(html).childNodes, true);
}
