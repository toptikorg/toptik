import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const source = await readFile(new URL("../src/components/carousel/BrandPicker.tsx", import.meta.url), "utf8");
const css = await readFile(new URL("../src/components/carousel/BrandPicker.module.css", import.meta.url), "utf8");
const code = ts.transpileModule(source, { compilerOptions: {
  jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020,
} }).outputText;

// A focused hook/element harness exercises the actual component event handlers.
// Browser layout, pointer hit-testing and screen-reader output remain live QA gates.
function harness(initialProps = {}) {
  const slots = [];
  let cursor = 0;
  const effects = [];
  const listeners = new Map();
  const calls = [];
  let focused = null;
  const props = {
    brands: [{ key: "mandarina-duck", label: "Mandarina Duck" }, { key: "brics", label: "Bric's" },
      { key: "samsonite", label: "Samsonite" }],
    value: "mandarina-duck", onChange: value => calls.push(value), ...initialProps,
  };
  class FakeNode { }
  const hookReact = {
    useId: () => "brand-panel-test",
    useState: initial => {
      const i = cursor++;
      if (!(i in slots)) slots[i] = initial;
      return [slots[i], value => { slots[i] = value; }];
    },
    useRef: initial => {
      const i = cursor++;
      if (!(i in slots)) slots[i] = { current: initial };
      return slots[i];
    },
    useEffect: (effect, dependencies) => {
      const i = cursor++;
      const old = slots[i];
      if (!old || dependencies.some((value, index) => value !== old.dependencies[index])) {
        old?.cleanup?.();
        effects.push(() => { slots[i] = { dependencies, cleanup: effect() }; });
      }
    },
  };
  const compiledModule = { exports: {} };
  vm.runInNewContext(code, {
    module: compiledModule, exports: compiledModule.exports, Node: FakeNode,
    document: {
      addEventListener: (name, listener) => listeners.set(name, listener),
      removeEventListener: name => listeners.delete(name),
    },
    require: name => name === "react" ? hookReact : name.endsWith(".module.css")
      ? { default: { root: "root", wordmark: "wordmark", trigger: "trigger", panel: "panel", option: "option", check: "check" } }
      : require(name),
  });
  const component = compiledModule.exports.default;
  let tree;
  const nodes = [];
  function render() {
    cursor = 0;
    tree = component(props);
    nodes.length = 0;
    const walk = element => {
      if (!element || typeof element !== "object") return;
      if (Array.isArray(element)) { element.forEach(walk); return; }
      nodes.push(element);
      walk(element.props?.children);
    };
    walk(tree);
    for (const element of nodes) {
      if (!element.props.ref) continue;
      const node = new FakeNode();
      node.focus = () => { focused = element; };
      node.contains = target => target?.inside === true;
      const ref = element.props.ref;
      if (typeof ref === "function") ref(node); else ref.current = node;
    }
    while (effects.length) effects.shift()();
    return api;
  }
  const api = {
    render, props, calls, listeners,
    get root() { return tree; },
    get trigger() { return nodes.find(node => node.props?.className === "trigger"); },
    get panel() { return nodes.find(node => node.props?.role === "group"); },
    get options() { return nodes.filter(node => node.props?.className === "option"); },
    get focused() { return focused; },
    outside() { return new FakeNode(); },
  };
  return render();
}

const key = value => ({ key: value, prevented: false, stopped: false,
  preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } });

test("closed brand disclosure has a current label, help, matching controls and no OS popup", () => {
  const h = harness();
  assert.equal(h.trigger.props["aria-label"], "בחרו מותג: Mandarina Duck");
  assert.equal(h.trigger.props["aria-describedby"], "carousel-brand-help");
  assert.equal(h.trigger.props["aria-controls"], h.panel.props.id);
  assert.equal(h.trigger.props["aria-expanded"], false);
  assert.equal(h.panel.props.hidden, true);
  assert.doesNotMatch(source, /<select\b|<option\b|\btitle=/);
});

test("opening focuses the selected brand, selection closes, restores focus and changes only once", () => {
  const h = harness();
  h.trigger.props.onClick(); h.render();
  assert.equal(h.panel.props.hidden, false);
  assert.equal(h.trigger.props["aria-expanded"], true);
  assert.equal(h.focused.props["aria-pressed"], true);
  assert.equal(h.options[1].props["aria-pressed"], true);
  h.options[3].props.onClick();
  assert.equal(h.focused.props.className, "trigger");
  h.render();
  assert.deepEqual(h.calls, ["samsonite"]);
  assert.equal(h.panel.props.hidden, true);
  assert.equal(h.listeners.has("pointerdown"), false);
});

test("arrow keys open and navigate without selecting, Home/End work, Escape returns focus", () => {
  const h = harness();
  const down = key("ArrowDown");
  h.trigger.props.onKeyDown(down); h.render();
  assert.equal(down.prevented, true);
  assert.equal(h.focused.key, "all");
  h.options[0].props.onKeyDown(key("ArrowUp"));
  assert.equal(h.focused.key, "samsonite");
  h.options[3].props.onKeyDown(key("Home"));
  assert.equal(h.focused.key, "all");
  h.options[0].props.onKeyDown(key("End"));
  assert.equal(h.focused.key, "samsonite");
  assert.deepEqual(h.calls, []);
  const escape = key("Escape");
  h.root.props.onKeyDown(escape);
  assert.equal(escape.prevented, true);
  assert.equal(escape.stopped, true);
  assert.equal(h.focused.props.className, "trigger");
  h.render();
  assert.equal(h.panel.props.hidden, true);
});

test("outside pointer and focus leaving close without selecting or trapping focus", () => {
  const h = harness();
  h.trigger.props.onClick(); h.render();
  h.listeners.get("pointerdown")({ target: h.outside() }); h.render();
  assert.equal(h.panel.props.hidden, true);
  assert.deepEqual(h.calls, []);
  h.trigger.props.onClick(); h.render();
  h.root.props.onBlur({ currentTarget: { contains: () => false }, relatedTarget: null }); h.render();
  assert.equal(h.panel.props.hidden, true);
});

test("loading/unavailable disables both the trigger and any open options", () => {
  const h = harness();
  h.trigger.props.onClick(); h.render();
  h.props.disabled = true; h.render();
  assert.equal(h.trigger.props.disabled, true);
  assert.equal(h.panel.props.hidden, true);
  assert.ok(h.options.every(option => option.props.disabled));
  assert.equal(h.listeners.size, 0);
  h.trigger.props.onKeyDown(key("ArrowDown")); h.render();
  assert.equal(h.panel.props.hidden, true);
});

test("dropdown is bounded, brown and non-modal; exact global wordmark styles are reused", () => {
  assert.match(source, /brand-wordmark/);
  assert.match(css, /\.trigger\s*\{[^}]*height: 44px/s);
  assert.match(css, /\.option\s*\{[^}]*min-height: 44px/s);
  assert.match(css, /\.panel\s*\{[^}]*position: absolute[^}]*max-width: calc\(100vw - 32px\)[^}]*background: #211a15/s);
  assert.match(css, /\.panel\[hidden\]\s*\{\s*display: none/);
  assert.doesNotMatch(css, /position:\s*fixed|opacity:\s*0|backdrop-filter|background:\s*(white|#fff)/i);
  assert.doesNotMatch(source, /aria-modal|role="dialog"|createPortal/);
});
