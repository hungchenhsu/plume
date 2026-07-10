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
  // `basicSetup` enables @codemirror/view's drawSelection(), which installs
  // its own Prec.highest theme (`hideNativeSelection`, see
  // node_modules/@codemirror/view/dist/index.js) forcing
  // `.cm-line ::selection { background-color: transparent !important }` on
  // every browser, WebKit included. That means a rule targeting the native
  // `::selection` pseudo-element here can never paint anything — the only
  // thing that ever renders a selection highlight is `.cm-selectionBackground`
  // (a plain layer div drawSelection positions behind the text).
  //
  // Two independent bugs compounded here, confirmed by reading
  // @codemirror/view's own source and by instrumenting a live editor:
  //   1. CM6's `EditorView.baseTheme()` ships its own default for
  //      `.cm-selectionBackground`, and the *focused*-state variant
  //      (`&light.cm-focused > .cm-scroller > .cm-selectionLayer
  //      .cm-selectionBackground`) has higher CSS specificity than a plain
  //      `.cm-selectionBackground` rule from our own `EditorView.theme()`
  //      call. Without `!important` our override was silently losing to
  //      CM6's hardcoded `#d7d4f0` (light) / `#233` (dark) the entire time
  //      the editor had focus — i.e. whenever a user was actually
  //      selecting text. `#d7d4f0` is a very pale lavender that reads as
  //      near-white against this app's near-white light/paper
  //      backgrounds, which matches the "bright white, selected text
  //      unreadable" report exactly.
  //   2. Because `EditorView.theme()` was never called with `{ dark: true
  //      }`, CM6 always considers the editor "light" for its *own*
  //      base-theme purposes (see `EditorView.theme`'s doc comment) no
  //      matter which of this app's four token themes is active — so the
  //      `#d7d4f0`/`#d9d9d9` light defaults, not the `#222`/`#233` dark
  //      ones, leaked through in every theme, including dark and dusk.
  // `!important` (the same technique drawSelection's own hideNativeSelection
  // theme uses) makes the fix independent of both of those specificity
  // details rather than trying to out-specify CM6's selector shape.
  ".cm-selectionBackground": {
    backgroundColor: "var(--bg-selection) !important",
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
  // Show-invisibles (editor.ts `highlightWhitespace()` + the custom EOL
  // widget). CM6's default theme hardcodes gray (#aaa / #888); these
  // overrides swap in the token-driven "faint" color so invisibles theme
  // correctly across light/dark/paper/dusk. The tab arrow is an inline SVG
  // background-image with a baked-in stroke color, so it can't take a CSS
  // var directly — it's recolored via `mask-image` instead: the SVG shape
  // becomes a mask over a `background-color` that _is_ a var().
  ".cm-highlightSpace": {
    backgroundImage:
      "radial-gradient(circle at 50% 55%, var(--fg-faint) 20%, transparent 5%)",
    backgroundPosition: "center",
  },
  ".cm-highlightTab": {
    backgroundImage: "none",
    backgroundColor: "var(--fg-faint)",
    WebkitMaskImage:
      "url('data:image/svg+xml,<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"200\" height=\"20\"><path stroke=\"black\" stroke-width=\"1\" fill=\"none\" d=\"M1 10H196L190 5M190 15L196 10M197 4L197 16\"/></svg>')",
    maskImage:
      "url('data:image/svg+xml,<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"200\" height=\"20\"><path stroke=\"black\" stroke-width=\"1\" fill=\"none\" d=\"M1 10H196L190 5M190 15L196 10M197 4L197 16\"/></svg>')",
    WebkitMaskSize: "auto 100%",
    maskSize: "auto 100%",
    WebkitMaskPosition: "right 90%",
    maskPosition: "right 90%",
    WebkitMaskRepeat: "no-repeat",
    maskRepeat: "no-repeat",
  },
  ".cm-eol-marker": {
    color: "var(--fg-faint)",
    userSelect: "none",
    pointerEvents: "none",
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
  // Markdown (@lezer/markdown) tags. Cross-checked against the parser's own
  // `styleTags` call (node_modules/@lezer/markdown/dist/index.js) rather
  // than assumed from memory:
  //  - ATXHeading1..6 / SetextHeading1..2 all resolve to `heading1`..`heading6`,
  //    which @lezer/highlight defines as *subtypes* of `heading`
  //    (node_modules/@lezer/highlight/dist/index.js: `heading1: t(heading)`,
  //    etc.), so one rule for `t.heading` styles every level via tag
  //    inheritance — no need to enumerate heading1-6 separately.
  //  - `t.list` is intentionally NOT styled here: OrderedList/BulletList are
  //    tagged with the markdown parser's "/..." (inherit) mode, which means
  //    the list tag's class is added to *every* descendant span in addition
  //    to that descendant's own tag (see @lezer/highlight's
  //    `highlightRange`: `inheritedClass` accumulates, it does not get
  //    overridden by a child's own rule). A list-item's Paragraph text would
  //    inherit `t.list` alongside `t.content`, so coloring `t.list` would
  //    dim entire list bodies, not just the bullet/number marker — the
  //    marker itself is a separate `ListMark` node already tagged
  //    `processingInstruction` (a subtype of `meta`, styled above).
  { tag: t.heading, color: "var(--syn-keyword)", fontWeight: "700" },
  { tag: t.strong, fontWeight: "700" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: t.link, color: "var(--syn-function)", textDecoration: "underline" },
  { tag: t.url, color: "var(--syn-function)" },
  { tag: t.quote, color: "var(--syn-comment)", fontStyle: "italic" },
  { tag: t.monospace, color: "var(--syn-string)" },
  { tag: t.contentSeparator, color: "var(--fg-faint)" },
]);

/** Static, token-driven theme applied once at editor construction. */
export const editorTheme: Extension = [baseTheme, syntaxHighlighting(highlightStyle)];
