"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { assertSafeDescriptionHtml, descriptionTextFromHtml, plainDescriptionToHtml } from "@/lib/shopify/description-document";

type Props = {
  text: string;
  html: string | null | undefined;
  onChange: (description: { text: string; html: string }) => void;
};

// Never put product HTML in the parent admin DOM or interpolate it into srcdoc.
// Same-origin allows the parent to attach the editor's own event handlers;
// scripts remain forbidden by BOTH the sandbox and an immutable iframe CSP.
const EDITOR_DOCUMENT = `<!doctype html><html lang="he" dir="rtl"><head>
<meta charset="utf-8"><meta name="referrer" content="no-referrer">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src https:; font-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'">
<style>body{margin:0;padding:14px;font:16px/1.7 Arial,sans-serif;color:#201a14;background:#fff}#description-editor{min-height:160px;outline:none;overflow-wrap:anywhere}table{border-collapse:collapse;max-width:100%}td,th{border:1px solid #bbb;padding:6px}img{max-width:100%;height:auto}a{color:#624717;text-decoration:underline}p{margin:.4em 0 1em}</style>
</head><body><div id="description-editor" contenteditable="true" role="textbox" aria-label="תיאור מוצר מעוצב" aria-multiline="true" dir="auto"></div></body></html>`;

function setEditorHtml(editor: HTMLElement, nextHtml: string): boolean {
  try { assertSafeDescriptionHtml(nextHtml); }
  catch { return false; }
  editor.innerHTML = nextHtml;
  return true;
}

export default function ProductDescriptionEditor({ text, html, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"visual" | "source">("visual");
  const [notice, setNotice] = useState("");
  const frameRef = useRef<HTMLIFrameElement>(null);
  const editorRef = useRef<HTMLElement | null>(null);
  const currentRef = useRef({ text, html });
  const onChangeRef = useRef(onChange);
  const selectionRef = useRef<Range | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const safeForVisualEditing = useMemo(() => {
    try { assertSafeDescriptionHtml(html ?? plainDescriptionToHtml(text)); return true; }
    catch { return false; }
  }, [text, html]);
  const visualMode = mode === "visual" && safeForVisualEditing;
  const visibleNotice = safeForVisualEditing ? notice
    : "התיאור מכיל תוכן שאינו נתמך בעורך המעוצב. המקור נשמר ללא שינוי; אפשר לתקן אותו במצב HTML.";

  useEffect(() => { onChangeRef.current = onChange; }, [onChange]);
  useEffect(() => {
    currentRef.current = { text, html };
    if (!safeForVisualEditing) {
      cleanupRef.current?.(); cleanupRef.current = null;
      return;
    }
    const editor = editorRef.current;
    // Input already changed the DOM; do not reset its selection/undo history.
    if (editor && editor.ownerDocument.activeElement !== editor) {
      const next = html ?? plainDescriptionToHtml(text);
      if (editor.innerHTML !== next) setEditorHtml(editor, next);
    }
  }, [text, html, safeForVisualEditing]);
  useEffect(() => () => cleanupRef.current?.(), []);

  const emitEdit = useCallback((nextHtml: string) => {
    try { assertSafeDescriptionHtml(nextHtml); setNotice(""); }
    catch { setNotice("התיאור מכיל תוכן שאינו נתמך. יש לתקן אותו במצב HTML לפני שמירה."); }
    onChangeRef.current({ text: descriptionTextFromHtml(nextHtml), html: nextHtml });
  }, []);

  const rememberSelection = useCallback(() => {
    const editor = editorRef.current;
    const selection = editor?.ownerDocument.getSelection();
    if (editor && selection?.rangeCount && editor.contains(selection.anchorNode) && editor.contains(selection.focusNode)) {
      selectionRef.current = selection.getRangeAt(0).cloneRange();
    }
  }, []);

  const initializeEditor = useCallback(() => {
    cleanupRef.current?.(); cleanupRef.current = null;
    const doc = frameRef.current?.contentDocument;
    const editor = doc?.getElementById("description-editor");
    if (!doc || !editor) return;
    if (!setEditorHtml(editor, currentRef.current.html ?? plainDescriptionToHtml(currentRef.current.text))) return;
    editorRef.current = editor;
    selectionRef.current = null;
    const input = () => { rememberSelection(); emitEdit(editor.innerHTML); };
    const preventNavigation = (event: Event) => {
      const target = event.target as Element | null;
      if (target?.closest?.("a,form")) event.preventDefault();
    };
    const preventDrop = (event: Event) => event.preventDefault();
    const paste = (event: ClipboardEvent) => {
      event.preventDefault();
      const clipboard = event.clipboardData;
      const next = clipboard?.getData("text/html") || plainDescriptionToHtml(clipboard?.getData("text/plain") || "");
      try { assertSafeDescriptionHtml(next); }
      catch {
        setNotice("ההדבקה לא בוצעה: התוכן כולל עיצוב או רכיבים שאינם נתמכים. התיאור הקיים לא השתנה.");
        return;
      }
      // Native editing keeps the browser's undo history. It only receives
      // validated passive markup or escaped plain text, never active HTML.
      doc.execCommand("insertHTML", false, next);
      input();
    };
    editor.addEventListener("input", input);
    editor.addEventListener("keyup", rememberSelection);
    editor.addEventListener("mouseup", rememberSelection);
    editor.addEventListener("paste", paste);
    doc.addEventListener("selectionchange", rememberSelection);
    doc.addEventListener("click", preventNavigation, true);
    doc.addEventListener("submit", preventDrop, true);
    doc.addEventListener("drop", preventDrop, true);
    cleanupRef.current = () => {
      editor.removeEventListener("input", input);
      editor.removeEventListener("keyup", rememberSelection);
      editor.removeEventListener("mouseup", rememberSelection);
      editor.removeEventListener("paste", paste);
      doc.removeEventListener("selectionchange", rememberSelection);
      doc.removeEventListener("click", preventNavigation, true);
      doc.removeEventListener("submit", preventDrop, true);
      doc.removeEventListener("drop", preventDrop, true);
      editorRef.current = null;
      selectionRef.current = null;
    };
  }, [emitEdit, rememberSelection]);

  function format(command: string) {
    const editor = editorRef.current;
    if (!editor) return;
    const doc = editor.ownerDocument;
    editor.focus();
    const selection = doc.getSelection();
    const range = selectionRef.current;
    if (selection && range && editor.contains(range.commonAncestorContainer)) {
      selection.removeAllRanges(); selection.addRange(range);
    }
    doc.execCommand(command, false);
    rememberSelection();
    emitEdit(editor.innerHTML);
  }

  function changeMode(next: "visual" | "source") {
    if (next === mode) return;
    cleanupRef.current?.(); cleanupRef.current = null;
    setMode(next);
    // Changing modes must not serialize or emit an edit to stored product HTML.
  }

  function toggleEditor() {
    if (open) { cleanupRef.current?.(); cleanupRef.current = null; }
    setOpen(!open);
  }

  return (
    <div style={{ gridColumn: "1 / -1" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <span>תיאור</span>
        <button type="button" onClick={toggleEditor} aria-expanded={open}>
          {open ? "סגירת העורך" : "עריכת תיאור"}
        </button>
      </div>
      {!open ? (
        <div style={{ whiteSpace: "pre-wrap", marginTop: 8, maxHeight: 160, overflow: "auto", padding: 12, border: "1px solid #d6cdbb", borderRadius: 6 }}>
          {text || "עדיין אין תיאור"}
        </div>
      ) : (
        <div style={{ marginTop: 8 }}>
          <div role="group" aria-label="מצב עריכת התיאור" style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 8 }}>
            <button type="button" aria-pressed={visualMode} disabled={!safeForVisualEditing} onClick={() => changeMode("visual")}>מעוצב</button>
            <button type="button" aria-pressed={!visualMode} onClick={() => changeMode("source")}>HTML</button>
          </div>
          {visualMode ? (
            <>
              <div role="group" aria-label="עיצוב טקסט" style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 8 }}>
                {[["bold", "מודגש"], ["italic", "נטוי"], ["insertUnorderedList", "רשימה"], ["insertOrderedList", "מספור"], ["undo", "ביטול"], ["redo", "ביצוע מחדש"]].map(([command, label]) => (
                  <button key={command} type="button" onMouseDown={event => event.preventDefault()} onClick={() => format(command)}>{label}</button>
                ))}
              </div>
              <iframe ref={frameRef} title="עריכת תיאור המוצר" sandbox="allow-same-origin" referrerPolicy="no-referrer"
                srcDoc={EDITOR_DOCUMENT} onLoad={initializeEditor}
                style={{ width: "100%", height: 300, border: "1px solid #d6cdbb", borderRadius: 6, background: "#fff" }} />
            </>
          ) : (
            <textarea aria-label="קוד HTML של תיאור המוצר" dir="ltr" rows={10} maxLength={200000}
              value={html ?? plainDescriptionToHtml(text)} onChange={event => { setMode("source"); emitEdit(event.target.value); }}
              spellCheck={false} style={{ width: "100%", resize: "vertical", fontFamily: "monospace" }} />
          )}
          {visibleNotice ? <p role="alert" style={{ color: "#a12620", fontSize: 13 }}>{visibleNotice}</p> : null}
        </div>
      )}
    </div>
  );
}
