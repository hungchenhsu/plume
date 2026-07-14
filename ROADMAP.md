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

## v0.3 — feature cycle (approved 2026-07-11)

Scope approved by the user on 2026-07-11 as four parallel tracks. Tracks
are independent by design — they map to separable module areas (Rust
encoding core / editor module / UI chrome / community infra) so multiple
contributors can work concurrently without colliding. Within a track,
items are roughly ordered; across tracks, anything unblocked is fair
game. One coherent item per PR, as always.

**Track A — encoding tools** (the moat; all items are encoding danger
domain: failing-test-first, round-trip tests mandatory)
- [x] Mojibake repair wizard: detect common mis-decode round-trips
  (e.g. Big5 bytes once decoded as Windows-1252 and re-saved) and offer
  a previewed, reversible repair — never applied silently
- [x] Batch encoding conversion: convert a folder's files to a target
  encoding with a dry-run report first; atomic per-file saves
- [x] Batch line-ending conversion (rides on the same batch UI)
- [x] Side-by-side encoding preview: the same bytes decoded under two
  candidate encodings, read-only, for manual disambiguation

**Track B — large files**
- [x] Find/replace inside large-file windows via streaming Rust
  search/replace over the full file (atomic temp+rename; editor window
  refreshes after)
- [x] Line-offset index for huge files: fast go-to-line and bookmarks
  beyond the loaded window

**Track C — everyday editing comfort**
- [x] Code folding (CM6 fold gutter, wired per language)
- [x] Line operations under Edit menu: sort / unique / trim trailing
  whitespace / upper-lower case (vitest for the pure transforms)
- [x] Indent guides (token-driven color, all four themes)

**Track D — release & community**
- [x] Issue templates, labels, and a good-first-issue starter set
  (unblocked; do first — it is the interface for incoming contributors)
- [x] i18n dictionaries: ja and zh-CN (builds on the v0.2 i18n module)
- [ ] D1 official name — user decision, currently deferred (evidence
  archived in `.claude/archive/d1-naming-final.md`)
- [ ] D2 signing + auto-update — blocked on D1 and user-held keys
  (runbook: `.claude/archive/d2-updater-runbook.md`)
- [ ] D3 going-public sweep — includes purging `.claude/archive/`
  naming evidence before the repo turns public

## v0.4 — feature cycle (planned 2026-07-14, delegated)

Scope planned autonomously under the user's 2026-07-14 delegation (user
away; plan the cycle, merge on green CI, post-merge review). The plan
passed an adversarial review against the mission and non-goals before
work started. Same track model as v0.3; one coherent item per PR. Items
marked **[danger]** touch encoding/save-path danger domains:
failing-test-first, round-trip tests, and adversarial review before
commit (judgment overlay §1).

**Track A — character-level trust** (the moat, extended to the sneakiest
cases of "never misrepresent user text")
- [ ] Character inspector: status-bar codepoint readout (U+XXXX) for the
  character at the cursor, with a popup showing its byte sequence under
  the file's save encoding (bytes rendered in Rust; UTF-16 hand-encoded
  around the encoder dead end) [danger]
- [ ] Invisible/ambiguous character audit: curated highlighting of
  zero-width characters, bidi controls (U+202A–202E, U+2066–2069), NBSP
  variants, soft hyphens, and in-body BOMs, with a status-bar count and
  a View toggle
- [ ] Full-width ⇄ half-width conversion (selection-scoped, Edit menu):
  FF01–FF5E ⇄ ASCII plus ideographic space [danger]
- [ ] Unicode normalization: non-NFC detection plus Edit-menu Normalize
  to NFC / NFD with a previewed change count — validating
  representability under the file's save encoding first (NFD output can
  be unrepresentable in legacy encodings; normalize must never set up a
  lossy save) [danger]
- [ ] Lossy-save character preview: when a save is rejected as lossy,
  list *which* characters can't be encoded (char + position, capped),
  not just a count, before offering the lossy path [danger]
- [ ] UTF-8 BOM toggle gap check: verify whether add/remove BOM on an
  existing UTF-8 file has a user-level path; close the gap only if it
  is real [danger]

**Track B — large files & performance**
- [x] #107: transformLines computes line spans via lineAt instead of
  materializing the document
- [ ] Streaming encoding conversion for large files: >10 MB files
  converted via streaming decode→re-encode with atomic temp+rename and
  the same lossy two-stage gate as streaming replace; UTF-16 targets
  excluded (encoder dead end); fail-closed on external modification
  [danger]
- [ ] File-open latency budget script (local-only, like startup-bench;
  never CI — known runner dead end) *(optional)*

**Track C — everyday editing comfort**
- [ ] Multi-cursor: allowMultipleSelections plus select-next/all
  occurrence commands, Edit-menu entries, platform shortcuts
- [x] Line shuffle ops in the Edit menu: move line up/down, duplicate,
  delete (bindings may already exist via the default keymap — expose
  and complete them)
- [ ] Word/char/line count status-bar segment: selection-aware,
  CJK-aware word counting; computed without materializing the document;
  hidden in large-file windows
- [ ] Per-tab read-only mode (View menu + status-bar indicator, reusing
  the existing readOnly compartment; large-file preview read-only state
  cannot be lifted)
- [ ] Tab drag-to-reorder (pure reorder logic unit-tested in the tab
  store)
- [ ] Indentation tools: detected indentation (tabs/spaces + width) in
  the status bar, indentUnit wired to the detection, Edit-menu convert
  leading tabs ⇄ spaces

**Track D — robustness**
- [x] #113: save_document validates a commit-time file fingerprint before
  writing (size/mtime/Unix inode identity), fail-closing a stale-file
  overwrite instead of silently clobbering an externally-changed file;
  shared `fsguard.rs` module extracted from the streaming-replace guard
  (#94/#102), reused as-is. Frontend offers Reload/Overwrite/Cancel on
  conflict [danger]
- [ ] Encoding round-trip fuzz expansion: deterministic-PRNG
  representable-text round-trips across all supported encodings plus
  mojibake-wizard reversibility fuzz (no new dependencies; scheduled
  before the Track A content transforms land)
- [ ] Cycle close-out: version bump to 0.4.0, tag v0.4.0-alpha.1, draft
  release (publish remains user-gated)

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
