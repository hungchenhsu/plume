# Roadmap

This is the execution queue only. Strategy, decision gates, phase plan,
scenario playbook, and the pre-triage feature backlog live in
[DIRECTION.md](DIRECTION.md) — items are promoted from there into this
file once the user signs off.

This roadmap is deliberately narrow. The goal of v0.1 is a tool you can genuinely use every day to open, read, and edit text files — not half an IDE.

## North star

> Open a text file faster than an IDE. Handle legacy encodings more reliably than most modern editors. Feel native on macOS — and on Windows.

## v0.1 — MVP

**Editing**
- [x] Multi-tab open / save / save-as
- [x] Single-document open / save / save-as (skeleton)
- [x] Unsaved-changes indicator and close confirmation

**Encoding (the core identity)**
- [x] Automatic detection: BOM sniffing + statistical detection (UTF-8, UTF-8 BOM, UTF-16 LE/BE, Big5, Shift_JIS, GB18030, …)
- [x] Decode-error surfacing (never silently show mojibake as if it were fine)
- [x] Reopen with explicit encoding (UI)
- [x] Save with explicit encoding / BOM toggle (UI)
- [x] Line-ending detection (LF / CRLF / Mixed) and re-application on save
- [x] Line-ending conversion (UI)

**Editor basics**
- [x] Syntax highlighting for common languages
- [x] Find / replace with regex
- [x] Session restore (reopen last files on launch)

**Platform integration**
- [x] macOS native menu bar with standard shortcuts
- [x] Windows menu and Ctrl-based shortcuts
- [x] File association / "Open with" registration
- [x] Basic preferences (font, font size, theme, default encoding behavior)

## Post-MVP candidates

Ordered roughly by likelihood, not commitment:

- Large-file mode — phase 1 done (read-only 2 MB preview for files over
  10 MB, saving disabled). Phase 2a done: chunk paging via status-bar ◀ ▶
  (line-aligned chunks; UTF-16 excluded). Phase 2b done: continuous
  reading — scrolling near the end auto-appends the next chunk, up to a
  ~64 MB window; beyond that the jump pager takes over. Syntax
  highlighting is disabled in large-file windows by design.
- ~~Find in files (Rust search backend)~~ (done — encoding-aware; regex mode done)
- ~~Recent files / quick open~~ (done)
- ~~Column (rectangular) selection~~ (built into the editor surface: Alt+drag)
- ~~Drag-and-drop file opening~~ (done)
- ~~Auto-reload on external change (file watcher)~~ (done)
- ~~Printing~~ (done — native print dialog via a full-document print view; macOS/Windows)

## v0.2 polish candidates

Engineering-driven follow-ups; product-level decisions (naming, signing,
distribution) are tracked outside this list.

- [x] Regex mode for find in files
- [x] Word wrap toggle (View menu, persisted in preferences)
- [x] Editor zoom shortcuts (Mod+= / Mod+- / Mod+0 adjusting font size)
- [x] Save option in the close-tab confirmation (Save / Don't Save / Cancel)
- [x] Atomic saves (temp file + rename; a crash mid-save can no longer
  corrupt the target file)
- [x] Session restores cursor position per file
- [x] Window size/position persistence across launches
- [x] Hot exit: unsaved buffers (including untitled tabs) are backed up
  continuously and restored on launch; closing the window never asks
  about unsaved changes
- ~~Large-file phase 2c~~ (done — bidirectional continuous reading: the
  window slides through the file with chunk prepend/append plus trimming
  on the opposite edge, bounded at 8 chunks ≈ 16 MB; ◀ ▶ remain as jump
  controls)
- [x] Full visual refresh — semantic design-token system in styles.css
  (color, spacing, radius, shadow, type-scale tokens; light/dark via the
  existing three-layer mechanism) and a token-driven CM6 editor theme
  (`src/editor-theme.ts`) replacing `@codemirror/theme-one-dark`, so chrome
  and editor share one visual language

## v0.2 — feature cycle (approved 2026-07-10)

Scope approved by the user on 2026-07-10 (promoted from DIRECTION.md §6;
autosave-to-disk explicitly declined, multi-window still awaiting a design
conversation). One coherent item per PR.

**UI**
- [x] Full visual refresh: redesigned visual language (tab bar, status
  bar, dialogs, find/replace panel) on a CSS design-token foundation;
  light and dark modes both complete (delivered in #37 together with the
  polish-candidates token-system entry above)
- [x] Built-in theme system: a few curated themes (light / dark /
  eye-friendly) built on the design tokens; View-menu switching,
  persisted preference. Built-ins + CSS variables only — no custom
  theme import
- [x] UI i18n, zh-TW first: lightweight typed dictionary module (no
  runtime dependency), covering UI strings and native menus; language
  preference follows the system by default with English fallback

**Encoding & editing (Tier 1 promotions)**
- [x] Show invisibles toggle (spaces / tabs / EOL marks) — View menu,
  persisted pref
- [x] Hex/bytes preview for undecodable files — read-only view offered
  from the decode-warning UI; hex dump formatted as text in Rust (raw
  bytes never cross IPC)
- [x] Per-extension default encoding — prefs table ext→encoding;
  confident detection still wins; round-trip tests
- [x] Find/replace history dropdown
- [x] Startup-time budget test — scripted cold-start measurement with a
  tracked threshold (local `scripts/startup-bench.mjs` + env-gated probe
  mode; a CI job was attempted and removed — GitHub macOS runners never
  start loading the WebView, see the script header)
- [x] Encoding-detection diagnostics — status-bar popup showing the
  evidence behind the detection (BOM found, chardetng verdict)

## Explicit non-goals

These are out of scope — not "later", but **not what this project is**:

- Plugin system / scripting / macros
- Project panels, file trees, workspace management
- Integrated terminal, debugger, LSP-based intelligence
- FTP/SFTP browsing
- Trying to replace your IDE

## Platform tiers

- **Tier 1:** macOS, Windows — feature parity, CI-built and tested, platform-correct UX on each.
- **Tier 2:** Linux — kept compiling and functional via Tauri (WebKitGTK), but not UX-polished; community contributions welcome.
