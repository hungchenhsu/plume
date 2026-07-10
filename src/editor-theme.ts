// Token-driven CodeMirror theme. Only imported by editor.ts, so it stays
// inside the CodeMirror isolation boundary (see ARCHITECTURE.md).
//
// Every color is a CSS custom property string ("var(--token)"), not a
// literal value. Light/dark switching is therefore handled entirely by the
// token cascade in styles.css (:root / prefers-color-scheme / data-theme) —
// there is nothing here to reconfigure in JS when the theme changes.
import { EditorView } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import type { Extension } from "@codemirror/state";

const baseTheme = EditorView.theme({
  "&": {
    color: "var(--fg)",
    backgroundColor: "var(--bg-base)",
  },
  ".cm-content": {
    caretColor: "var(--accent)",
  },
  ".cm-cursor, .cm-dropCursor": {
    borderLeftColor: "var(--accent)",
  },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
    {
      backgroundColor: "var(--accent-soft)",
    },
  ".cm-activeLine": {
    backgroundColor: "var(--accent-soft)",
  },
  ".cm-activeLineGutter": {
    backgroundColor: "var(--accent-soft)",
    color: "var(--fg-muted)",
  },
  ".cm-gutters": {
    backgroundColor: "var(--bg-surface)",
    color: "var(--fg-faint)",
    border: "none",
    borderRight: "1px solid var(--border)",
  },
  ".cm-searchMatch": {
    backgroundColor: "var(--accent-soft)",
    outline: "1px solid var(--accent)",
  },
  ".cm-searchMatch.cm-searchMatch-selected": {
    backgroundColor: "var(--accent)",
    color: "var(--accent-fg)",
  },
  ".cm-panels": {
    backgroundColor: "var(--bg-raised)",
    color: "var(--fg)",
  },
  ".cm-panels-top": {
    borderBottom: "1px solid var(--border)",
  },
  ".cm-panels-bottom": {
    borderTop: "1px solid var(--border)",
  },
  ".cm-panel.cm-search": {
    backgroundColor: "var(--bg-raised)",
  },
  ".cm-panel.cm-search input.cm-textfield": {
    color: "var(--fg)",
    backgroundColor: "transparent",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius-md)",
    padding: "3px 8px",
  },
  ".cm-panel.cm-search input.cm-textfield:focus-visible": {
    outline: "2px solid var(--accent)",
    outlineOffset: "2px",
  },
  ".cm-panel.cm-search button.cm-button": {
    color: "var(--fg)",
    backgroundColor: "transparent",
    backgroundImage: "none",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius-md)",
    padding: "3px 10px",
    cursor: "pointer",
  },
  ".cm-panel.cm-search button.cm-button:hover": {
    backgroundColor: "var(--accent-soft)",
    borderColor: "var(--accent)",
  },
  ".cm-panel.cm-search button.cm-button:focus-visible": {
    outline: "2px solid var(--accent)",
    outlineOffset: "2px",
  },
  ".cm-panel.cm-search label": {
    color: "var(--fg-muted)",
  },
});

const highlightStyle = HighlightStyle.define([
  { tag: t.keyword, color: "var(--syn-keyword)" },
  { tag: [t.controlKeyword, t.moduleKeyword, t.operatorKeyword], color: "var(--syn-keyword)" },
  { tag: [t.string, t.special(t.string), t.regexp], color: "var(--syn-string)" },
  { tag: [t.number, t.bool, t.atom], color: "var(--syn-number)" },
  {
    tag: [t.comment, t.lineComment, t.blockComment, t.docComment],
    color: "var(--syn-comment)",
    fontStyle: "italic",
  },
  {
    tag: [
      t.function(t.variableName),
      t.function(t.propertyName),
      t.definition(t.function(t.variableName)),
    ],
    color: "var(--syn-function)",
  },
  { tag: [t.typeName, t.className, t.namespace], color: "var(--syn-type)" },
  { tag: t.tagName, color: "var(--syn-keyword)" },
  { tag: t.attributeName, color: "var(--syn-function)" },
  { tag: [t.propertyName, t.variableName], color: "var(--fg)" },
  { tag: [t.operator, t.punctuation, t.bracket], color: "var(--fg-muted)" },
  { tag: t.meta, color: "var(--fg-faint)" },
  { tag: t.invalid, color: "var(--danger)" },
]);

/** Static, token-driven theme applied once at editor construction. */
export const editorTheme: Extension = [baseTheme, syntaxHighlighting(highlightStyle)];
