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
- [ ] D1 official name — user decision; shortlist re-verified 2026-07-15
  (evidence lives in the maintainer's local private storage since the
  repo went public — see DIRECTION §3/D1)
- [ ] D2 signing + auto-update — blocked on D1 and user-held keys
  (runbook in the maintainer's local private storage)
- [x] D3 going-public sweep, archive part: internal decision material
  (naming evidence, updater runbook) relocated out of the repo to the
  maintainer's local private storage (2026-07-15, user-approved; note
  the files remain reachable in git history — accepted). Remaining D3
  items (D1 naming, README pass, signing) tracked in DIRECTION §2

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
- [x] Character inspector: status-bar codepoint readout (U+XXXX) for the
  character at the cursor, with a popup showing its byte sequence under
  the file's save encoding (bytes rendered in Rust; UTF-16 hand-encoded
  around the encoder dead end) [danger]. Semantics: the character
  *immediately before* the cursor (what Backspace would delete), not
  under it — chosen because it's the one option under which "empty
  document / line start shows nothing" falls out naturally (the char
  before a line start is the *previous* line's own newline, which would
  be misleading to show), documented on `characterBeforeCursor`
  (editor.ts). Wired into the existing `onCursorMoved` path (no new
  update hook): reads up to the last 2 UTF-16 code units before the
  cursor, clamped to the line start, and splits with `Array.from`
  (code-point iteration, i.e. `codePointAt` semantics) so a supplementary
  character split across a surrogate pair (e.g. U+1F600) is read back
  whole — O(log n) via `Text.lineAt` plus an at-most-2-unit slice, the
  same cost class as `updateCursor`'s own line/column math, so — unlike
  the whole-document `textStatsOf` segment — it needs no debounce and
  runs unconditionally in large-file (truncated) windows too (segment
  and popup both stay meaningful within whatever window is loaded).
  New Rust IPC `encode_char(ch, encoding) -> {bytesHex, lossy}`
  (`src-tauri/src/charinspect.rs`): failing-test-first round-trip table
  (ASCII, Big5 "中", GB18030 "中", Shift_JIS "あ", UTF-16LE/BE surrogate
  pair for U+1F600, unmappable "é" in Big5) with every expected byte
  sequence hand-verified against Python's own (encoding_rs-independent)
  codec tables rather than encoding_rs self-certifying its own answer;
  the naive first-draft (calling encoding_rs's whole-buffer `encode()`
  unconditionally, no UTF-16 special case) failed exactly the two
  UTF-16 tests — producing the character's *UTF-8* bytes instead,
  the precise known dead end (`new_encoder()`'s/`encode()`'s output
  encoding for UTF-16LE/BE is UTF-8, judgment-overlay.md §4) — plus the
  unmappable-character test, which got back the literal bytes for
  encoding_rs's own HTML numeric-character-reference fallback
  ("&#233;") instead of the empty/lossy signal. Fixed by special-casing
  UTF-16LE/BE to reuse `encoding::encode_utf16` (bumped to `pub(crate)`),
  the same hand-rolled code-unit encoder the real save path already
  uses, and by discarding (never surfacing) encoding_rs's fallback bytes
  on an unmappable character: `lossy: true` with an empty `bytesHex`,
  since showing "&#233;"'s bytes as if they were "é in Big5" would
  misrepresent a character Big5 cannot represent at all. No `withBom`
  parameter — a BOM is a file-level, offset-0-only marker, not a
  property of one character's bytes. Bytes cross IPC only as an
  uppercase, space-separated hex string (e.g. "E4 B8 AD"), the same
  "bytes formatted as text in Rust" precedent hexdump.rs established for
  the raw-bytes-never-cross-IPC constraint. Popup (`src/charinspect.ts`)
  mirrors the encoding-detection diagnostics status-bar popup
  (detectcard.ts) — same anchored-panel positioning, same away-click/
  Escape close handling, same `.detectcard-header`/`.detectcard-rows`
  inner CSS classes reused verbatim — but keeps its own outer panel
  class (`.charinspect-panel`, sharing `.detectcard-panel`'s rule via a
  combined CSS selector rather than the DOM element carrying both
  classes) so the two features' "already open" guards can never see
  each other's popup. Rows: character, code point, UTF-8 bytes always,
  and a fourth "{encoding} Bytes" row only when the save encoding isn't
  UTF-8 (two `encode_char` calls total) — showing either the hex or,
  when lossy, a "cannot be represented in {encoding}" message in place
  of bytes, styled with the existing `--warning` token. i18n across en/
  zh-TW/ja/zh-CN.
- [x] Invisible/ambiguous character audit: curated highlighting of
  zero-width characters, bidi controls (U+202A–202E, U+2066–2069), NBSP
  variants, soft hyphens, and in-body BOMs, with a status-bar count and
  a View toggle. A single 20-entry curated table (`src/suspiciouschars.ts`)
  is the one source of truth for what's audited, split into bidi (LRE/RLE/
  PDF/LRO/RLO/LRI/RLI/FSI/PDI/ALM/LRM/RLM), zeroWidth (ZWSP/ZWNJ/ZWJ/WJ/
  in-body BOM), and whitespace (NBSP/NNBSP/soft hyphen — U+3000 ideographic
  space deliberately excluded, routine CJK spacing) categories, each with a
  pure `scanSuspiciousChars(text)` (offset/char/label/name/category per
  hit) fully vitest-covered (every category, mixed, none, and
  surrogate-pair-adjacent cases — all 20 code points are single-UTF-16-unit
  BMP characters, so unlike textstats.ts's word counter this needs no
  cross-chunk carry state at all). CM6 wiring
  (`editor.ts`'s `suspiciousCharsExtension`) *overlays* rather than
  replaces `basicSetup`'s own bare `highlightSpecialChars()` (which already
  highlights a subset — SHY/ALM/ZWSP/LRM/RLM/LRO/RLO/LRI/RLI/PDI/in-body
  BOM — as a generic "•" placeholder): verified from
  @codemirror/view/state source that `addSpecialChars` is the documented
  extension point for exactly this, and that basicSetup's own
  parameterless call contributes zero keys to the `specialCharConfig`
  facet's `combineConfig`, so this module's own `addSpecialChars`/`render`
  can never hit its "Config merge conflict" error regardless of extension
  order — pinned by a dedicated `EditorState.create` regression test
  (editor.test.ts) alongside a real `basicSetup`. The custom `render`
  callback labels curated hits `[RLO]`/`[ZWSP]`/etc. (`.cm-suspicious-char`,
  editor-theme.ts, reusing the `--warning`/`--warning-soft` tokens the
  status-bar decode-error/read-only badges already use) and returns `null`
  for anything else, falling back to CM6's stock rendering unchanged for
  its own baseline control-character set — a deliberate `as` cast bridges
  `@codemirror/view`'s `render` type (declared non-nullable `HTMLElement`)
  against its own documented falsy-fallback runtime behavior. View menu
  toggle (`suspicious_chars`, default **on** — a trust/security signal,
  not a convenience default like indent guides) only gates the inline
  highlight; the whole-document status-bar count
  (`suspiciousCharCountOf`, chunked via `Text.iterRange` like
  `textStatsOf`, no cross-chunk state needed for the same reason as
  above) is intentionally independent of that toggle — no other
  status-bar badge (decode error, read-only) is gated by a View-menu
  display preference either, and hiding a trust signal behind an
  easy-to-forget toggle would work against the feature's own purpose.
  Truncated (large-file) windows hide the count entirely rather than
  showing a "window"-qualified partial total, matching the Track C
  text-stats precedent exactly (`computeAndShowSuspiciousChars` in
  main.ts) — inline highlighting still applies as usual within whatever
  window is loaded, unaffected, same as indent guides/EOL marks. i18n
  across en/zh-TW/ja/zh-CN (`statusbar.suspiciousChars`, menu.rs `LABELS`
  with a dedicated pinned-translation test mirroring `read_only`'s).
- [x] Full-width ⇄ half-width conversion (selection-scoped, Edit menu):
  FF01–FF5E ⇄ ASCII plus ideographic space [danger]. `toHalfWidth`/
  `toFullWidth` (lineops.ts) are a straight +/-0xFEE0 offset over
  U+FF01–FF5E ⇄ U+0021–007E plus a dedicated U+3000 ⇄ U+0020 case;
  everything else (halfwidth katakana U+FF61–FF9F, CJK ideographs, tabs,
  newlines) passes through untouched, which is what makes the two exact
  inverses of each other. Iterates by code point (the same technique
  `compareCodePoints` uses), so an adjacent surrogate pair is never split.
  Wired as `editor.transformSelection` (like uppercase/lowercase, not
  `transformLines`: this is a character substitution with no per-line
  meaning, so a partial-line selection must stay verbatim) — no selection
  means whole-document, same precedent. Two new Edit > Line Operations
  items beside the case-conversion pair, `to_full_width`/`to_half_width`,
  i18n across en/zh-TW/ja/zh-CN with a pinned-translation test mirroring
  `convert_leading_tabs_to_spaces`'s. vitest: full ASCII 0x21–0x7E table
  round-tripped bidirectionally in a for loop, boundary characters (U+FF01/
  U+FF5E inclusive, U+FF5F just outside), ideographic-space pair, mixed CJK/
  halfwidth-kana/ASCII text, empty string, adjacent-surrogate-pair safety,
  and idempotence, both directions (101 lineops.test.ts cases total).
  Representability note: both directions only ever produce characters
  representable in Big5/legacy CJK encodings (fullwidth forms sit in
  Big5's mapped range, ASCII is universal), so no new lossy-save risk —
  the existing save-time lossy gate is untouched and sufficient.
- [x] Unicode normalization: non-NFC detection plus Edit-menu Normalize
  to NFC / NFD with a previewed change count — validating
  representability under the file's save encoding first (NFD output can
  be unrepresentable in legacy encodings; normalize must never set up a
  lossy save) [danger]. Detection (`normalize.ts` `isNfcChunked`) walks
  CM6's `Text.iter()` chunk by chunk instead of materializing
  `doc.toString()`, carrying the tail back to the last *normalization
  boundary* (UAX #15 `hasBoundaryBefore`) across each chunk cut: `\p{M}`
  marks plus the non-Mark canonical-composition second elements —
  conjoining Hangul V/T jamo and U+16D67 (Kirat Rai, Unicode 16.0), both
  category Lo, which a `\p{M}`-only proxy misjudged (NFD Hangul open
  syllables read as already-NFC even single-chunk; caught by adversarial
  review) — and never cutting at a trailing lone high surrogate (astral
  marks like U+110BA would otherwise have their base flushed away when a
  chunk cut lands mid-surrogate-pair). Proven failing-test-first at each
  step, and pinned by an exhaustive sweep: the NFD expansion of every
  decomposable code point in planes 0-2 (Hangul sampled), every split
  point, against whole-string ground truth — which is also the
  maintenance contract for the hardcoded jamo/Kirat list (a future
  Unicode version adding another non-Mark second element fails the sweep
  naming the exact code point). Status shown as a new small, hidden-until-
  relevant status-bar segment (`#status-nonnfc`, statusbar.ts
  `updateNormalizationStatus`), mirroring the existing suspicious-chars/
  indent segments' debounce-and-hide-when-truncated pattern, rather than
  a new always-visible segment or a diagnostics popup. Edit > Line
  Operations gains `normalize_nfc`/`normalize_nfd` (menu.rs `LABELS`,
  i18n across en/zh-TW/ja/zh-CN with a pinned-translation test), wired
  through `runLineOperation` — the same truncated/userReadOnly guard
  sort/unique/trim use, which also covers the large-file-preview-
  disabled requirement with no separate native-menu-enabled wiring
  needed. Always whole-document (`editor.content()`/
  `editor.replaceContent`), never selection-scoped. Confirm flow
  (main.ts `runNormalizeFlow`): a no-op (already the target form — the
  common case for plain CJK text, which has no canonical decomposition)
  applies nothing and shows no dialog, matching the existing line-
  operations' no-op-dispatches-nothing precedent; otherwise a confirm
  dialog names the affected sequence count (`normalize.ts`
  `countChangedSequences`, a normalization-boundary-sequence diff — not
  a raw code-point count, which would misalign or double-count once
  composition/decomposition changes how many code points encode one
  character; the boundary-based split keeps NFD and NFC Hangul at the
  same per-syllable sequence count, so this figure stays consistent
  with the representability dialog's own character count). The
  representability guard — the actual point of the feature — is a new
  Rust IPC command, `check_representable`
  (src-tauri/src/normalize.rs), reusing charinspect.rs's per-character
  `encoding_rs::Encoding::encode()` probing technique (encoding_rs only
  reports one whole-string bool, never which characters) to report an
  uncapped per-occurrence unmappable count plus up to 20
  distinct-character samples and a `samplesTruncated` flag (the dialog
  appends "and more" only when distinct characters overflowed the cap —
  repeats alone never imply an incomplete list); UTF-8/UTF-16 targets
  are skipped on both the frontend and the Rust side (every Unicode
  scalar value is representable in either). A non-zero count surfaces a
  second, explicit warning naming the encoding, the count, and the
  samples before the user can still choose to proceed — and
  `save_document`'s own lossy gate remains a second, independent line
  of defense at actual save time regardless. Rust tests: Big5/
  Shift_JIS + an NFD combining sequence → unmappable > 0
  (failing-test-first: a stubbed always-zero implementation fails these
  first), plain Traditional Chinese text and UTF-8/UTF-16 → 0, sample
  cap/dedup/truncated-flag semantics, unknown encoding → `Err`.
- [x] Lossy-save character preview: when a save is rejected as lossy,
  list *which* characters can't be encoded (char + position, capped),
  not just a count, before offering the lossy path [danger]. Previously
  `save_document`'s two-phase lossy gate returned only a bare `unmappable:
  bool` -- not even a count, let alone which characters. The scan-and-
  sample machinery already existed one item up: A3's
  `check_representability` (`src-tauri/src/normalize.rs`) probes each
  character's representability via `encoding_rs::Encoding::encode()` and
  collects up to `SAMPLE_CAP` (20) deduped samples plus a
  `samples_truncated` flag. This item extracts that scan into a shared
  `scan_unmappable` helper (`(count, hits, truncated)`, `hits:
  Vec<UnmappableHit>` carrying each first-encountered character's
  position) so `check_representability` and the new `lossy_save_report`
  are the same source rather than two implementations of the same cap/
  dedup/truncation logic -- `check_representability`'s own 13 tests are
  unchanged (pure refactor). `lossy_save_report(text, label)` returns
  `LossySaveReport { unmappable_count, samples: Vec<UnmappableSample>,
  samples_truncated }`, where `UnmappableSample` adds `line`/`column`
  (1-based) to `RepresentabilityReport`'s plain formatted-string samples.
  Position is computed by scanning `save_document`'s `content` parameter
  (the LF-normalized buffer as sent by the frontend) -- deliberately never
  the line-ending-converted `text` that `encoding::encode` actually
  writes, since a CR-only (classic Mac) conversion replaces every `\n`
  with a bare `\r`, which would silently collapse every reported line to
  "line 1"; a dedicated regression test saves multi-line content with
  `line_ending: "CR"` and asserts the reported line/column still match the
  LF buffer. Column counts UTF-16 code units, not Unicode scalar values --
  matching `editor.ts`'s `onCursorMoved` (`head - line.from`), the same
  convention `statusbar.cursor` already displays with, so an astral
  character (e.g. an emoji) earlier on the same line advances the column
  by 2, not 1; pinned by a dedicated test (rocket emoji followed by "é" on
  one line). `SaveResult` gains `lossy_report: Option<LossySaveReport>`,
  populated only on the lossy-rejection branch (`unmappable: true,
  written: false`) -- `None` on a successful write and on a `stale`
  rejection (issue #113's retry never needs a fresh sample list there).
  Failing-test-first: a stubbed always-clean `lossy_save_report`/always-
  `None` `lossy_report` wiring landed first, the new tests expecting real
  samples/positions failed against it, then the real scan/wiring replaced
  the stub -- 14 new Rust tests (11 in normalize.rs, 3 in lib.rs), full
  suite 299 passed (2 pre-existing `#[ignore]`d fuzz variants unaffected).
  Frontend: the lossy-save confirm outgrew the native `confirm()` dialog
  plugin (main.ts's `saveFlow` used to call directly) -- a native dialog
  can only show a flat string with no way to make a capped 20-line sample
  list scrollable -- so it gets its own in-DOM modal, `src/lossysave.ts`,
  mirroring confirm.ts's `showCloseConfirm`/stalefile.ts's
  `showStaleFileConfirm` (same `.confirm-overlay`/`.confirm-dialog`/
  `.confirm-buttons` classes, Escape cancels, initial focus on Cancel --
  irreversible once confirmed, so, like the stale-file dialog, there is no
  global Enter shortcut). A pure `buildLossySaveDialogContent` (vitest-
  covered, no WebView) composes the title/summary/per-sample lines/
  truncation note from `t()` calls; the DOM builder itself is untested,
  matching the existing confirm.ts/stalefile.ts precedent. i18n:
  `dialog.lossyEncodingMessage` gained a `count` parameter (replacing the
  old vague "some characters"); new `dialog.lossySampleLine` (reusing
  `statusbar.cursor`'s own per-locale Ln/Col phrasing convention verbatim)
  and `dialog.lossySamplesTruncated`, across en/zh-TW/ja/zh-CN. New
  styles.css: `.confirm-dialog-title` (a small heading the two existing
  confirm-style modals didn't need) and `.lossy-samples` (max-height/
  overflow-y: auto, same scrollable-list idiom as
  `.batchconvert-scan-errors-list`). Batch conversion's own lossy
  classification (`batch.rs`'s scan report) is untouched -- out of scope;
  per-file lossy flags already exist there and this item only concerns the
  single-document save dialog.
- [x] UTF-8 BOM toggle gap check: verified no gap, no code change needed.
  The status bar's encoding indicator already opens a "Save with
  Encoding" submenu (`main.ts` `showEncodingMenu`, `menu.saveWithEncoding`)
  listing "UTF-8" and "UTF-8 with BOM" as two distinct, independently
  checkable entries (`encodings.ts` `encodingChoices` — `{value: "UTF-8",
  withBom: false}` vs `{value: "UTF-8", withBom: true}`, localized in all
  four locales); picking either sets `doc.withBom` and immediately saves
  through it, so an existing UTF-8 file's BOM can be added or removed
  today without reopening. This reaches `save_document`'s `with_bom`
  param unchanged and `encoding::encode`, which prepends `EF BB BF` only
  when `with_bom && encoding == UTF_8` — confirmed live via the existing
  `cargo test --lib bom` (19 tests) and `npm test` (565 tests) suites,
  both green with no changes. UTF-16 choices stay BOM-only (no `false`
  variant offered, so the UI can't write a BOM-less UTF-16 file) and
  single-byte/legacy encodings offer no BOM entry at all — both already
  correct, not touched.

**Track B — large files & performance**
- [x] #107: transformLines computes line spans via lineAt instead of
  materializing the document
- [x] Streaming encoding conversion for large files: >10 MB files
  converted via streaming decode→re-encode with atomic temp+rename and
  the same lossy two-stage gate as streaming replace; UTF-16 targets
  excluded (encoder dead end); fail-closed on external modification
  [danger]. New `stream_convert_file` (src-tauri/src/streamconvert.rs)
  mirrors `streamreplace.rs`'s architecture exactly (same atomic
  temp+rename commit, same `fsguard.rs`-backed fail-closed external-
  modification guard captured right after opening the source and
  re-checked immediately before rename) but is a genuinely different loop:
  source and target encodings are independent parameters rather than one
  encoding reused for both directions, so there is no cross-chunk *search*
  carry to track — each decoded chunk is scanned and encoded independently,
  with the streaming `Decoder` alone responsible for resolving a multi-byte
  or surrogate-pair sequence split across the raw 8 MiB read boundary. The
  per-chunk decode/encode primitives (`decode_chunk`/`encode_chunk`/
  `read_chunk`/`CHUNK_BYTES`) were extracted out of `streamreplace.rs` into
  a new shared `streamcodec.rs` (a pure, test-verified refactor — all 18
  pre-existing `streamreplace.rs` tests still pass unchanged) rather than
  forking that buffer-growth-loop logic a second time, the same
  "extract for a second caller" precedent `fsguard.rs` itself set. UTF-16 is
  asymmetric here, unlike streaming replace: only a UTF-16 *target* is
  rejected (`new_encoder()`'s dead end is encode-side only); a UTF-16
  *source* decodes through the ordinary streaming `Decoder` with no dead end
  at all and is fully supported, pinned by a dedicated fixture with a
  surrogate pair's two code units landing on opposite sides of the exact
  8 MiB chunk boundary. Two-stage lossy gate mirrors `save_document`'s
  own two-phase gate (call once with `allowLossy: false`, get a report; call
  again with `true` to commit) rather than a separate up-front dry-run
  command: a single streaming pass always fully encodes to a temp file
  while aggregating an unmappable-character report via
  `normalize::UnmappableScanner`, fed one already-decoded chunk at a time;
  a `written: false` result (unmappable found, not yet allowed) discards
  the temp file without any fingerprint check (nothing was written). The
  scanner's own sample-cap/dedup/position machinery (previously private to
  `scan_unmappable`, now a `pub(crate)` incremental struct so it can be fed
  in pieces) is unchanged in its whole-string callers, `check_representability`
  and `lossy_save_report` — a pure refactor, both callers' full existing test
  suites pass unmodified, plus a new chunked-vs-whole-string equivalence
  test. Performance: the naive version (always running the O(n)
  per-character representability probe alongside the bulk encode) measured
  over two minutes for a single ~13 MiB fixture with only 3 unmappable
  characters; `encode_chunk`'s own bulk `had_unmappable` flag (needed
  regardless, to produce output bytes) now gates the expensive per-character
  scan per chunk — a chunk the bulk encode already reports clean only pays
  for cheap line/column bookkeeping (`UnmappableScanner::advance_position_only`),
  cutting that same test to under 80s and, more importantly, keeping a
  realistic large file with only scattered unmappable characters cheap
  rather than paying the full per-character cost across its entirety.
  Frontend: truncated tabs get a new "Convert File to Encoding" entry in the
  status-bar encoding menu (`main.ts`'s `showEncodingMenu`), alongside the
  existing "Save with Encoding" (left untouched — it already is a dead
  end for a truncated tab, blocked by the read-only-preview dialog, since
  the buffer is only a preview slice; this adds the real capability rather
  than retrofitting that entry), listing `encodings.ts`'s new
  `streamConvertEncodingChoices()` (the existing `encodingChoices()`, minus
  the two UTF-16 target entries — each remaining choice already carries its
  own correct `withBom`, e.g. plain "UTF-8" is `withBom: false`, so picking
  one *is* the BOM decision, matching how batch conversion's own
  `target_with_bom` is a caller-supplied flag with no separate default
  computed on the Rust side). New `src/streamconvert.ts` orchestrates the
  flow with no persistent input panel (the target is already chosen from
  the menu) — a minimal non-dismissable busy overlay reusing the existing
  `.confirm-overlay`/`.confirm-dialog` classes (mirroring streaming
  replace's "cannot be cancelled mid-run" precedent) during each IPC call,
  and the *same* `showLossySaveConfirm` dialog (`lossysave.ts`) the regular
  save path's lossy gate uses for the two-stage confirm, since the Rust
  report reuses `normalize::LossySaveReport` verbatim. On success,
  `doc.encoding`/`doc.withBom` are set to the new target *before*
  `reloadFromDisk` (which reopens with whatever `doc.encoding` already holds) and a
  confirmation dialog names the result before reloading, mirroring streaming
  replace's "the result must actually be seen" precedent. i18n across en/
  zh-TW/ja/zh-CN (`menu.convertFileToEncoding`, `streamConvert.*`). Rust
  tests (failing-test-first): a >12 MiB Big5→UTF-8 round trip with a filler
  unit deliberately sized so a CJK character straddles the exact chunk
  boundary; a small fast test for the dry-run rejection report (count/dedup/
  position) plus a separate >12 MiB UTF-8→Big5 test committing exactly an
  independently-built byte oracle under `allowLossy: true` (split from the
  rejection test so the expensive large-scale encode only runs once, not
  twice); the UTF-16LE cross-boundary surrogate-pair fixture; UTF-16 target
  rejection (both LE and BE); external-modification fail-closed (real
  `rename`-based race plus fingerprint-mismatch unit tests); malformed-source
  abort; BOM semantics (no BOM by default even when the source had one, an
  explicit BOM request honored for a UTF-8 target, a source BOM stripped
  when converting to an encoding with no BOM concept, a legacy target
  ignoring a BOM request); unknown-encoding-label errors; an empty-file edge
  case; two more added directly against an opus `critic` adversarial review
  of this diff (which otherwise agreed the design and the riskiest
  assumption — encoding_rs's bulk per-chunk `had_unmappable` flag matching
  the scanner's own per-character probe exactly, since every supported
  target encoding is a stateless per-character mapping — both hold):
  a >8 MiB fixture with the *first* chunk entirely clean and only the
  *second* containing the one unmappable character, proving the aggregated
  count and position survive a real per-chunk fast-path switch (not just a
  direct unit-level scanner call), and a second fixture with an unmappable
  character's own 4 UTF-8 bytes split exactly 2/2 across the raw chunk
  boundary. 331 Rust tests total (up from 299), 572 frontend tests (up from
  565).
- [x] File-open latency budget script (local-only, like startup-bench;
  never CI — known runner dead end) *(optional)* — new
  `scripts/openfile-bench.mjs` mirrors startup-bench's env-gated probe
  pattern with its own separate probe rather than reusing the cold-start
  one, so open latency is isolated from WebView/prefs/session-restore
  overhead instead of folded into it: `PLUME_OPENFILE_PROBE=<path>` plus
  new `openfile_probe_path`/`report_openfile_ready` commands
  (`src-tauri/src/openfile_probe.rs`), hooked right after the existing
  cold-start probe at the end of the init IIFE in `src/main.ts`. Both
  timing endpoints (trigger, post-paint) live in the frontend, so elapsed
  is measured there with `performance.now()` around the real `openPath()`
  codepath a drag-drop/file-association open already uses (a
  `requestAnimationFrame` wait after it stands in for "content rendered").
  The script generates its own synthetic UTF-8 fixtures in a temp dir,
  cleaned up after — 1 MiB (full open) and 50 MiB (crosses
  `LARGE_FILE_THRESHOLD`, exercises the read-only preview path) — and
  reports median/p95 over a parameterizable run count, with optional
  independent thresholds per size. Verified via `node --check`, `--dry-run`
  (fixture generation/cleanup, no binary spawn — confirmed clean, no temp
  dirs left behind), a standalone import-based check of the pure
  median/percentile/synthDoc helpers, and the usual app-code gate (`npm
  run build`/`npm test`, `cargo fmt`/`clippy`/`test`: 333 Rust tests, up
  from 331; 572 frontend tests, unchanged — this addition has no unit-level
  surface of its own, same as the pre-existing startup probe hook).
  Actually launching the script spawns a real GUI window, which agents in
  this repo must never do (TCC-incident rule), so real `openfile_ms`
  numbers were not gathered in this change; a human should run
  `node scripts/openfile-bench.mjs` on an unlocked desktop after
  `cargo build --release` to get them.

**Track C — everyday editing comfort**
- [x] Multi-cursor: allowMultipleSelections plus select-next/all
  occurrence commands, Edit-menu entries, platform shortcuts (verified
  from source: `basicSetup` already sets `allowMultipleSelections` and
  bundles `searchKeymap`'s Mod-d/Mod-Shift-l for select-next/all-occurrence
  — this cycle's actual work was Edit-menu exposure; CM6's own
  Cmd/Ctrl-click already adds a cursor and does not conflict with the
  existing Alt-drag rectangular selection, so that gesture was left as-is
  rather than remapped to Alt-click)
- [x] Line shuffle ops in the Edit menu: move line up/down, duplicate,
  delete (bindings may already exist via the default keymap — expose
  and complete them)
- [x] Word/char/line count status-bar segment: selection-aware,
  CJK-aware word counting; computed without materializing the document;
  hidden in large-file windows. Pure counting (`textstats.ts`) is split
  from the CM6 walk (`editor.ts`'s `textStatsOf`): a streaming accumulator
  fed one `Text.iterRange` chunk at a time, never `doc.toString()`/a
  whole-range `sliceDoc` (issue #107's anti-pattern) — verified against
  `@codemirror/state`'s own source that a chunk is always a whole line, a
  line break, or (only at the caller's own from/to) a boundary-trimmed
  partial line, so a word or UTF-16 surrogate pair is never split by an
  *internal* chunk boundary; the accumulator still carries a trailing
  high surrogate and an in-word-run flag across chunks defensively. CJK
  word counting: CJK Unified Ideographs (U+4E00-U+9FFF) + Extension A
  (U+3400-U+4DBF), Hiragana (U+3040-U+309F), Katakana (U+30A0-U+30FF), and
  Hangul syllables (U+AC00-U+D7A3) each count as one word per character;
  everything else groups into `\p{L}\p{N}` runs. No selection shows
  whole-document stats; one or more non-empty selection ranges show
  selection stats instead, summed across every range (including "lines,"
  per spec — two single-line ranges on the same physical line sum to 2,
  a deliberate, documented trade-off over tracking distinct line numbers
  touched). Performance: cursor-position updates (`onCursorMoved`) have no
  existing throttle to piggyback on (called synchronously on every CM6
  transaction, but O(log n) via `Text.lineAt`) — text stats are O(document
  length), so they get their own 300ms `setTimeout` debounce
  (`scheduleTextStatsUpdate` in main.ts, mirroring the existing hot-exit
  backup debounce), while tab switch/open/reload/large-file jump compute
  immediately via the same `showActive` choke point everything else
  already uses. Hidden entirely (`updateTextStats(null)`) for
  `doc.truncated` large-file windows. i18n: `statusbar.textStats` /
  `statusbar.textStatsSelection` across en/zh-TW/ja/zh-CN, English
  pluralizing each noun independently per the `resultSummary` precedent.
- [x] Per-tab read-only mode (View menu + status-bar indicator, reusing
  the existing readOnly compartment; large-file preview read-only state
  cannot be lifted): `Doc.userReadOnly` (tabs.ts) is a second, independent
  read-only source alongside `truncated` — `isEffectivelyReadOnly(doc)` =
  `truncated || userReadOnly` is the one formula every call site (CM6
  enforcement, the View menu's checked/enabled sync, the status-bar badge,
  the Save/line-ops rejection guard) derives from, so none of them can
  drift out of sync. editor.ts's `newBuffer` already baked
  `EditorState.readOnly`/`EditorView.editable` in fixed at construction for
  a truncated preview (unchanged, still unlifted); the toggle itself is a
  new `Compartment` (`setReadOnly`), reconfigured per-buffer after every
  `swap` from that doc's own effective value — mirroring `setLanguage`'s
  per-buffer pattern, not the global-pref compartments (wrapping/
  invisibles/indentGuides), since read-only is per-tab. CM6's `readOnly`
  facet ORs every source together, so the two mechanisms layer safely.
  Verified from source (editor.test.ts): CM6's own commands
  (moveLineUp/Down, duplicate/deleteLine, Undo/Redo, search's Replace)
  self-no-op on `state.readOnly` and never dispatch; `transformLines`/
  `transformSelection` (sort/unique/trim/case, a raw `view.dispatch` with
  explicit changes) do not consult it on their own, so `runLineOperation`'s
  JS-level guard is their only protection — extended from `truncated` to
  `isEffectivelyReadOnly`. Native menu: a new `read_only` CheckMenuItem
  (menu.rs, LABELS across all four languages) with a new
  `sync_read_only_menu(checked, enabled)` command — `enabled: false` for a
  truncated tab (its lock can never be lifted, so the item is shown checked
  but disabled, the only existing `CheckMenuItem::set_enabled` use in this
  codebase) — called from main.ts's `syncReadOnlyState` on every tab switch
  (`showActive`) and on the toggle itself (`toggleReadOnly`), since a plain
  click's native auto-checkmark-toggle alone can't track switching to a
  different tab. Status bar: the existing `#status-readonly` badge is
  reused (not duplicated) — truncated's own sized message wins when both
  are true, otherwise a plain locale'd "Read-only" label. Session: a new
  `userReadOnly`/`user_read_only` field (ipc.ts/session.rs) round-trips a
  locked tab's state across a relaunch, `#[serde(default)]`/`??`-guarded
  for old sessions. Save on a read-only tab shows the same blocking dialog
  large-file preview already used (mirrored, not replaced, per existing
  "action rejected" precedent), with a distinct message telling the user
  how to unlock (View > Read-Only) instead of the large-file wording.
- [x] Tab drag-to-reorder (pure reorder logic unit-tested in the tab
  store): `TabStore.moveTab(fromIndex, toIndex)` is a plain splice-out/
  splice-in array move — `activeId` tracks a doc's id, not its array
  position, so the active tab is untouched by any reorder whether or not
  it's the tab being moved. Interaction is Pointer Events, not the HTML5
  DnD API (WKWebView/WebView2 drag-image/drop-effect inconsistencies) —
  pointerdown arms a potential drag on the tab (primary button only
  graduates past the threshold; any button still selects, matching the
  pre-drag mousedown behavior); pointerup resolves it as a select (no/
  below-threshold movement, including every middle/right-click gesture)
  or a reorder (moveTab + one render() + persistSession, mirroring every
  other order-affecting tab op's persist timing). The close button's own
  pointerdown stopPropagation keeps it immune to both. Selection resolves
  on release rather than eagerly on press specifically to dodge a
  reentrancy hazard: onSelect can cascade synchronously into main.ts's
  activate() -> showActive() -> tabs.render(), which rebuilds every tab
  element — resolving it only after this gesture's own teardown means
  that cascade never finds in-flight drag state pointing at a
  soon-to-be-detached node. Visual feedback is the dragged tab itself
  (translateX + existing --shadow-1/--bg-base tokens), not a separate
  placeholder element.
- [x] Indentation tools: detected indentation (tabs/spaces + width) in
  the status bar, indentUnit wired to the detection, Edit-menu convert
  leading tabs ⇄ spaces. Detection (`indentdetect.ts`, pure) is the
  classic heuristic: skip blank lines, classify each remaining line's
  leading run as tabs-only/spaces-only/mixed-within-a-line; any mixed
  line, or both tabs-only and spaces-only lines present, is "mixed"; only
  tabs-only is "tabs" (no width — a tab's display width isn't inferrable
  from the characters themselves); only spaces-only (including depth-0
  anchor lines) is "spaces", width = the *mode* of adjacent depth diffs
  in document order (not the first or largest — a lone deeper jump, e.g.
  a pasted nested block, doesn't outvote a consistent step; ties break to
  the smaller width), falling back to the smallest observed depth when no
  diff is computable at all (one indented line, or uniform depth with no
  baseline); no indentation anywhere is "none". `editor.ts`'s
  `detectIndentationOf` samples at most `INDENT_DETECTION_SAMPLE_LINES`
  (1000) lines from the start via `Text.iterLines` (never
  `doc.toString()`/a whole-document `sliceDoc`) — indentation style is
  established early and doesn't need the whole file, mirroring
  `encoding.rs`'s own bounded-sample detection. Status bar: "Spaces: N" /
  "Tabs" / "Mixed", hidden for "none" or no active doc — deliberately NOT
  hidden for a truncated large-file window (unlike text stats/suspicious
  chars): indentation is a "whatever's currently loaded" question, not a
  whole-file total a partial window would misrepresent. Computed
  immediately on tab switch/open/reload (`showActive`) and, debounced
  300ms (mirroring `scheduleTextStatsUpdate`), after edits/selection
  changes. CM6 wiring: a new per-buffer `indentation` Compartment
  (`EditorHandle.setIndentation`, mirroring `setReadOnly`/`setLanguage` —
  not auto-reapplied inside `swap`) sets `indentUnit`
  (`@codemirror/language`) and `EditorState.tabSize` from the detected
  style, falling back to a new `indentWidth`/`indent_width` preference
  (default 4, no dialog control yet — detection covers the common case)
  for "tabs" (tabSize only; indentUnit is still confidently `"\t"`) and
  "mixed"/"none" (both). Edit menu: "Convert Leading Tabs to Spaces" /
  "Convert Leading Spaces to Tabs" (`lineops.ts`, pure, bidirectional
  round-trip tested), added to the Line Operations submenu and routed
  through `runLineOperation`'s guard like Sort/Unique/Trim; both only
  touch each line's leading whitespace run (tab-stop-aware expansion /
  integer-division grouping with the remainder kept as spaces), using
  CM6's own live `tabSize` as "current effective width". `menu.rs` LABELS
  gained the two new ids across en/zh-TW/ja/zh-CN with pinned tests.

**Track D — robustness**
- [x] #113: save_document validates a commit-time file fingerprint before
  writing (size/mtime/Unix inode identity), fail-closing a stale-file
  overwrite instead of silently clobbering an externally-changed file;
  shared `fsguard.rs` module extracted from the streaming-replace guard
  (#94/#102), reused as-is. Frontend offers Reload/Overwrite/Cancel on
  conflict [danger]
- [x] #114: batch conversion's per-file commit (`convert_one` in
  `batch.rs`) validates the same commit-time fingerprint immediately
  before its `atomic_write`, fail-closing a stale-file overwrite instead of
  silently clobbering an externally-changed file mid-batch; reuses
  `fsguard.rs` (#113) unchanged, fingerprint tied to the same open handle
  the file is read through. One raced file fails independently and reports
  "changed on disk during conversion" — the rest of the batch still
  converts normally [danger]
- [x] #112: save completion is gated on a per-document revision snapshot —
  edits made while a save is in flight keep the tab dirty and keep the
  hot-exit backup instead of being silently marked as saved (pure
  decision table in `savecompletion.ts`, exhaustively unit-tested)
  [danger]
- [x] #115: reload-from-disk and reopen-with-encoding now drop the doc's
  hot-exit backup once its buffer is replaced by on-disk content —
  previously left behind, the stale backup was resurrected by the next
  launch's orphan recovery as a spurious dirty tab, reviving content the
  user had just explicitly discarded. `dropBackup` extracted out of
  main.ts (not unit-testable directly) into its own tested `backup.ts`
  module, mirroring the `savecompletion.ts` (#112) extraction [danger]
- [x] #117: batch conversion's 10 MiB size guard was a TOCTOU — the
  metadata size check and the full `read_to_end` were separate steps, so
  a file that grew past the cap between them still got read in full.
  `read_for_conversion` (`batch.rs`) is now split into
  `open_for_conversion` (metadata fast-path check + fingerprint) and
  `bounded_read`/`take_bounded` (the real guard: `Read::take(MAX_FILE_SIZE
  + 1)`, same technique as the #59/#69 large-file preview read), so the
  actual bytes pulled into memory are capped regardless of what the file
  grows to after the metadata check. Regression test grows the file
  through a second handle after the check passes and asserts the read
  stops at the take-limit sentinel, not the file's real (larger) size
  [danger]
- [x] #116: batch scan's folder walk (`collect_files` in `batch.rs`) used
  to silently `continue`/return `Ok(())` past an unreadable subdirectory or
  an entry whose metadata failed — the dry-run report looked complete
  while quietly missing whatever that subtree contained, risking a
  destructive convert over a report the user wrongly believed was
  exhaustive. The root folder failing to open now fails
  `scan_batch_conversion` closed (`Err`) instead of returning an
  empty-looking report; a subdirectory or entry failing mid-walk is
  instead recorded in a new `BatchScanReport.scan_errors` field and the
  walk continues with whatever it can still read. The batch panel shows a
  collapsible "N items could not be scanned" disclosure above the report
  (i18n'd across en/zh-TW/ja/zh-CN) and switches the Convert confirm
  dialog to a stronger, scan-error-count-naming message — the native
  confirm dialog covers the panel itself, so this is the only warning left
  at the actual moment of the destructive action. `execute_batch_conversion`
  semantics are unchanged: it still only converts the scanned, checked
  subset. Regression tests: a nonexistent root directory fails closed; a
  chmod 000 subdirectory and a chmod 0600 (no execute bit) parent both
  reproduce the two previously-silent failure modes deterministically and
  assert they land in `scan_errors` while the readable sibling still
  scans normally [danger]
- [x] #119 + #132: large-file line handling previously only recognized
  `0x0A` (LF) as a line terminator — the same blind spot #92 fixed in
  `encoding::detect_line_ending` — in two coupled places: the line index
  (`lineindex.rs`) counted a CR-only (Classic Mac) file as a single line,
  breaking Go to Line and bookmarks beyond the loaded chunk window
  (#119), and `chunk.rs`'s page alignment (`align_start`,
  `cut_tail_at_newline`, the prev-byte `at_line_start` check) shifted a
  correct lone-CR line-start offset to the next LF-line, so fixing the
  index alone would have made goto/bookmarks silently land on the wrong
  line in mixed-endings files (#132). Both now share one byte-level
  semantics module, `linebreak.rs`: LF, CRLF (counted once, never split),
  and lone CR all terminate a line, matching #92's three-way split. The
  streaming scanner's `pending_cr` flag carries across reads so a `\r\n`
  pair split across a chunk boundary stays one boundary; alignment treats
  an unresolved trailing CR as "not a complete terminator" (cut before
  it, or keep the whole chunk when it is the only candidate), so a page
  cut can never strand half a CRLF. Line-start checks now consult the
  neighbor pair (prev byte + first byte) because a CR directly followed
  by LF is a CRLF's interior, not a boundary. Regression tests: CR-only
  multi-line index and paging (every page starts and ends on a real line
  boundary, lossless), CRLF not double-counted, mixed LF/CRLF/CR file,
  trailing lone CR at EOF (no phantom line), both directions of the
  read-boundary split (CR|LF and CR|other-byte) for the index and the
  pager, end-to-end locate-then-read-chunk alignment for goto and
  backward paging, and helper-vs-scanner agreement locks in
  `linebreak.rs`; pure-LF and CRLF paging behavior is unchanged
  byte-for-byte [danger]
- [x] #120: large-file chunk IPC responses had no generation guard — a
  slow pageChunk/autoAppendChunk/prependChunk/gotoLargeFileLine response
  could land after a newer request (rapid Next/Next, a goto/bookmark jump
  racing a pager click) or a reload-from-disk/reopen-with-encoding had
  already moved the doc on, silently clobbering the buffer with stale
  content or a byte offset that no longer matched what was on screen.
  Every one of those five call sites now bumps a per-doc monotonic
  `chunkGeneration` counter (`tabs.ts` `Doc.chunkGeneration`, mirroring
  `scanGeneration` from #103) before firing its IPC call(s) and applies
  the response only if the generation still matches *and* the doc is
  still the active tab, via a shared, unit-tested `shouldApplyChunkResponse`
  (`chunkguard.ts`) — otherwise the response, success or error, is
  discarded outright with no mutation and no dialog. `ensureLineIndex`
  (goto's line-index build) is generation-checked too, so a reload can't
  resurrect a stale index after clearing it. The four request kinds also
  now share one per-doc `chunkLoadInFlight` guard (previously a single
  module-level flag that covered only auto append/prepend and could
  cross-block unrelated tabs), so none of them can overlap for the same
  doc; reload/reopen bump the generation and clear the flag unconditionally
  instead, since they preempt whatever's in flight rather than waiting on
  it. pageChunk's Prev no longer pops its offset history until the
  response is confirmed current, fixing a lost-history-entry bug on a
  failed or superseded Prev. Streaming replace's post-convert reload goes
  through the same `reloadFromDisk`, so it's covered without a separate
  path. Regression tests in `chunkguard.test.ts` simulate the exact
  call-site pattern (bump, await, guarded apply) for a rapid-Next/Next
  race, a tab-switch-during-load race, and a reload-during-load race, plus
  full branch coverage of the pure guard [danger]
- [x] #118: large-file paging silently skipped bytes when a single line
  exceeded `CHUNK_BYTES` (2 MiB) — `align_start`'s "skip forward to the
  next line start" is only safe when a *later* read can recover whatever
  it discards, true for backward paging but never true going forward.
  Once a chunk finally reached an overlong line's own closing terminator,
  the old `read_document_chunk` treated the mid-line continuation offset
  as "misaligned" and skipped past that terminator, discarding the entire
  unterminated remainder it was continuing (up to just under CHUNK_BYTES
  per occurrence). `read_document_chunk` now takes a caller-declared
  `OffsetKind`: a `continuation` offset (paging's own next_offset chain —
  either a genuine line start or a raw mid-line continuation point) is
  never realigned, read from exactly that offset and cut at the last
  complete terminator (or kept whole if none exists yet), while a
  `lineStart` offset (goto/bookmark jumps, riding on a line index that a
  missed watcher event can leave stale — mid-line, even mid-character) is
  verified and defensively realigned to the next real line start, falling
  back to a raw head-trimmed read when the window contains no line start
  at all — never an empty window, never a skipped one (goto is a fresh
  jump, so realignment there moves the window instead of losing bytes
  from an assembled sequence). `read_document_chunk_before` keeps
  `align_start` (backward paging's leading-fragment discard is usually
  safe — a further backward read recovers it) but no longer trusts a
  result that would consume the *entire* window: a CHUNK_BYTES backward
  window landing entirely inside one overlong line has its only
  terminator-like byte at the window's very last position (`end`'s own
  predecessor byte), and "skipping past it" used to collapse the chunk to
  empty with offset == end, hanging paging in place forever. A raw,
  non-terminator cut can also land mid-character; new
  `encoding::trim_truncated_utf8_head` (mirroring the existing
  `trim_truncated_utf8_tail`) fixes the boundary back up on both ends,
  gated to UTF-8 (the one paging-supported encoding where this can
  happen), with the same "never consume the entire window" guard on the
  backward head-trim. Regression tests: forward and backward round-trip
  across a ~12 MB unterminated line with normal lines on both sides (the
  exact byte-loss count is asserted directly), a minimal repro of the
  backward degenerate case, exact mid-line cut offset/character-boundary
  arithmetic for a multibyte (CJK) overlong line, the
  EOF/no-trailing-newline case, stale mid-line and mid-character goto
  offsets realigning to the next line start, a stale goto offset inside
  an overlong line falling back raw, and an all-continuation-bytes
  backward window staying an honest U+FFFD chunk instead of collapsing
  empty [danger]
- [x] Encoding round-trip fuzz expansion: deterministic-PRNG
  representable-text round-trips across all supported encodings plus
  mojibake-wizard reversibility fuzz (no new dependencies; scheduled
  before the Track A content transforms land). New `fuzz_roundtrip.rs`
  (test-only, `#[cfg(test)]`-gated): a hand-rolled xorshift64 PRNG (no
  prior fuzz/PRNG precedent existed in the crate to reuse, despite this
  item's premise — `streamreplace.rs`'s large tests are fixed-size, not
  randomized), one representable-text pool per encoding (full-Unicode
  sampling plus a curated control/astral/surrogate-pair edge set for
  UTF-8/UTF-16LE/UTF-16BE; encode-filtered common-script ranges for
  Big5/GBK/gb18030/Shift_JIS/EUC-JP/EUC-KR/windows-1252, each pool proven
  independently representable by its own sanity test before being trusted
  as a fuzz source), and fuzz tests asserting the #109-documented
  contract (text/encoding-label/BOM/line-ending survive a decode<->encode
  cycle — not byte-for-byte identity, which #109 already excludes for
  legacy non-injective mappings) across all ten encodings x 3 line
  endings x BOM states, plus `mojibake::REPAIR_PAIRS` reversibility for
  all 8 wizard hypotheses. 22 new tests at CI scale (~2s), plus two
  `#[ignore]`d 50x-larger variants for manual runs (verified to pass in
  release mode). No round-trip failures found.
- [x] Cycle close-out: version bump to 0.4.0, tag v0.4.0-alpha.1 (the
  draft-release workflow is billing-blocked — re-run it on the tag once
  Actions billing is restored; publish remains user-gated)

## v0.5 — feature cycle (planned 2026-07-15, delegated)

Scope planned autonomously under the user's 2026-07-15 delegation (same
model as v0.4: user away, plan the cycle, merge on green CI, post-merge
review). The plan passed an adversarial review before work started
(AGREE-WITH-CHANGES; every requested change adopted or explicitly
adjudicated in the session log). Theme: extend the v0.3/v0.4 trust
machinery (fsguard fingerprints, lossy two-phase gate, scan-error
surfacing, shared line-break semantics) to byte-level fidelity and
multi-file replace, and clear the open bug queue. Items marked
**[danger]** follow judgment overlay §1: failing-test-first, round-trip
tests, adversarial review before commit; danger items are never worked
in parallel. #89 is deliberately left open as the good-first-issue
surface for incoming contributors.

**Track R — debt & robustness** (bug queue first)
- [x] July dependency cadence: lockfile-level patch/minor float, no
  manifest changes, full local matrix green (merged as #156 ahead of
  this section — routine DIRECTION §7 policy, not new scope)
- [x] #136: explicit-encoding UTF-8 large-file preview applies the same
  tail trim gate as auto-detect (mid-character cut at the 2 MiB window
  edge misreports U+FFFD/malformed); real interior malformed bytes must
  still surface [danger]. The gate now asks "does the effective encoding
  resolve to UTF-8" via a new `encoding::is_utf8_label` that shares the
  same `Encoding::for_label` normalization as the actual decode — no
  WHATWG label spelling can make the gate and the decode disagree.
  `next_offset` takes the trimmed length, pinned by a
  `str::from_utf8(&full[..next_offset])` boundary assertion. The trim
  can never swallow a real EOF-malformed file: `truncated` requires
  total size > 10 MiB while the window is 2 MiB, so a trimmed tail is
  always strictly file-interior (adversarial review confirmed);
  interior bad bytes and ≤10 MiB files keep surfacing `malformed`
  unchanged, and auto-detect/UTF-16/legacy explicit paths are
  bit-identical to before (asserted by an explicit-vs-auto equivalence
  test). Same-shaped gap for explicit legacy multi-byte encodings
  (Big5/Shift_JIS/GBK — no UTF-8-style trim helper exists for them)
  found out-of-scope and filed as #165.
- [x] Chunk-paging property fuzz: deterministic-PRNG random operation
  sequences (Next/Prev/goto/append/prepend × line-ending mixes ×
  multi-byte boundaries) checked against whole-file ground truth;
  scheduled after the #136 fix (built first it would trip the known
  bug) and before the #134 paging change it protects [danger]. New
  test-only `fuzz_paging.rs` mirroring fuzz_roundtrip.rs's xorshift64/
  `#[cfg(test)]`/`#[ignore]`-variant organization: 12 fixtures (LF/
  CRLF/CR-only/Mixed × ASCII/CJK/astral, ~10 MB each — CHUNK_BYTES is
  a hard const with no injection point, so big-fixture/few-rounds; the
  overlong line is 3×CHUNK_BYTES, sized so stale-goto probes actually
  reach the no-terminator raw-fallback branch, measured 114/288 hits
  after an instrumented run showed the naive 1×-plus-epsilon sizing
  hit it 0/144 times) × four properties: forward-chain lossless
  reassembly against the whole file, chunk boundaries on real line
  starts or documented #118 exceptions, line-index goto offsets equal
  to an independently-derived ground-truth line table (zero shared
  code with linebreak.rs, cross-checked against build_line_index's own
  totals so oracle and prod can't self-certify), and same-seed
  determinism — plus a stale-goto boundary fuzz generalizing the #118
  follow-up regressions. Adversarial review (AGREE-WITH-CHANGES) added
  two fixes before commit: goto/stale-goto paths now assert full
  content equivalence against the ground-truth slice (an
  `OffsetKind::LineStart` off-by-one that kept offsets correct but
  dropped a content byte was previously invisible — exactly the region
  #134 is about to touch), and the stale-goto oracle no longer treats
  EOF as a legal realign target when the file ends in an unresolved
  lone CR or no terminator at all (prod correctly raw-falls-back
  there; masked today at ~3e-10/probe but would have become a false
  alarm the moment #134 touched EOF semantics). Suite: 351 tests
  (348 pass / 3 ignored), fuzz subset ~4s wall on a 12-core dev
  machine (expect ~11s on CI runners), release `--ignored` variant
  passes in ~31s.
- [x] #134: user-initiated goto/paging/bookmark jumps preempt an
  in-flight auto-append (bump generation + clear the in-flight flag,
  the reload precedent) instead of silently no-op'ing [danger]. New
  pure `preemptChunkLoad` helper (chunkguard.ts); pageChunk preempts
  only after its target/early-exits resolve, gotoLargeFileLine
  preempts at entry (its only early exits are an index-build failure
  that already shows an error dialog, or an empty file — a killed
  background auto-append re-triggers on the next scroll, so the
  trade-off is documented rather than fought). Auto append/prepend
  still yields (chunkpolicy.ts untouched, asserted by a test that
  throws if auto even issues a request). The classic preemption
  clobber hole is closed by construction: every request's cleanup is
  generation-guarded (`if (doc.chunkGeneration === myGeneration)`),
  so a preempted request's finally can never clear the winner's
  in-flight flag — verified per call site in adversarial review
  (AGREE). Prev's #120 peek-then-pop-on-confirmed invariant survives
  preemption (Prev-during-Prev pops history exactly once, asserted).
  Failing-test-first: the pre-fix assertions showed the bug was
  worse than a silent no-op — the user's target content lost to the
  stale auto chunk. +5 vitest (577 total); the harnesses are honest
  stand-ins for main.ts's orchestration (which needs a WebView), with
  the shared pure helpers imported for real.
- [x] #124: per-doc save/reload in-flight mutual exclusion — no more
  orphan backup or fingerprint/buffer divergence when a reload lands
  mid-save; second save deferred, watcher state re-evaluated on
  unlock [danger]. `Doc.saveReloadInFlight` ("save"|"reload"|null) plus
  single pending slots (`pendingReload`/`pendingSaveAs`, latest-wins),
  mirroring the chunkGeneration/chunkLoadInFlight per-doc convention;
  pure decision module `src/savemutex.ts` (`mustDefer`/`nextDrainStep`/
  `fingerprintsEqual`) exhaustively unit-tested per the #112
  savecompletion precedent, wired through `withLock`/`drainLock` in
  main.ts with saveFlow/reloadFromDisk split into entry gates plus
  verbatim-extracted bodies (whitespace-normalized diff verified zero
  behavior change in adversarial review). Drain runs the pending
  reload first, then the pending save gated on unlock-time
  `doc.dirty` — deliberately not the spec's original "revision
  advanced" test: dirty is edit-based and stays true after a failed
  save, so the dirty gate retries where a revision gate would silently
  drop the retry (reviewer judged this strictly better). A deferred
  reload is re-evaluated on drain against a fresh fingerprint (a save's
  own write never triggers its own reload; a genuine third-party
  change does), and — the review's one P2, fixed before commit —
  re-checks `doc.dirty` at drain time: edits typed while the save was
  in flight now get the same fileChangedMessage consent dialog as any
  dirty-doc external change (declining keeps buffer, dirty state, and
  hot-exit backup; consenting applies a second fresh read, deliberately
  not re-entering reloadFromDisk which would self-defer forever), and
  the internal stale-confirm reload self-defers onto its own lock's
  drain with no deadlock (verified across the full holder×entrant
  matrix). Save-IPC failure paths release the lock via finally and
  keep the retry path alive. +22 vitest (599 total; mutation-tested —
  a disabled mustDefer fails 9, a disabled dirty re-check fails 2).
  Same-shaped consent gap found in reopenWithEncoding filed as #169.
- [x] #128: batch scan classify_file switches to single-handle bounded
  read (#117's exact pattern) closing the metadata/read TOCTOU [danger].
  New `open_for_classification` (open_for_conversion minus the
  Fingerprint — a dry-run has no later commit to guard) feeding the
  #117 `take_bounded` helper verbatim; the oversize verdict now reads
  actual bytes pulled (`bytes.len() > MAX_FILE_SIZE`), literally the
  same test as the execute side. Boundary behavior (exactly-MAX,
  MAX+1, empty) unchanged; one deliberate hardening: an fstat failing
  on an already-open handle now classifies fail-closed as undecodable
  instead of the old silent `.unwrap_or(false)` pass-through
  (#116 spirit, surfaced to the user). Failing-test-first via a
  temporary unbounded stub (real assertion failure 10485801 vs
  10485761), regression test grows the file through a second handle
  after the check and asserts the read stops at the take-limit
  sentinel. Adversarial review AGREE (349 Rust tests).
- [x] #130: find-in-files collect_files records unreadable
  directories/entries as scan errors surfaced in the panel (#116's
  pattern) instead of silently skipping subtrees. `ScanError` and
  `SearchResults.scan_errors` on the Rust side (deliberately its own
  struct, not an import from batch.rs — the two walkers stay
  independent, as before); an unreadable root now fails the whole
  search closed (`Err`) instead of returning a zero-result report,
  the worst-case misread ("the string is gone") being exactly what
  #130 exists to prevent; mid-walk failures are recorded and the walk
  continues. Panel shows a collapsible "N items could not be
  searched" disclosure above the results (`fif-scan-errors*` classes
  following the file's own naming convention, styles mirroring the
  batch panel's), i18n across en/zh-TW/ja/zh-CN.
  Failing-test-first: field added returning an empty vec, three new
  Rust tests failed (nonexistent root, chmod-000 subdir, no-execute
  parent), then the real logic turned them green with the readable
  sibling still scanned. 352 Rust + 603 vitest.
- [x] #96 (1/3): streaming replace read-chunk byte-passthrough — a
  chunk with no match involvement, no decoder pending on either edge,
  and no carry in/out is copied byte-identical (the BOM-bearing first
  chunk always excluded); regions that are re-encoded are honestly
  disclosed; regression fixtures use the #96-verified non-injective
  byte pairs (Big5 8E 69, Shift_JIS 87 90, GBK A2 E3) [danger].
  Eligibility short-circuits cheapest-first: stateless encoding →
  no match/carry-out → no carry-in → decode self-sufficiency (a fresh
  `without_bom_handling` decoder over the raw chunk with `last=true`
  must reproduce the streaming decoder's exact text with zero
  malformed — for a stateless encoding this *is* segment correctness,
  since the whole file is the concatenation of segments that each
  cold-decode cleanly at character boundaries; the worst conceivable
  false negative degrades to the pre-fix re-encode, never to wrong
  bytes). The encoder still runs on every chunk (its state always
  advances); passthrough only chooses which buffer hits the disk.
  Adversarial review REJECTED the first version with a live-fire
  P1: ISO-2022-JP — encoding_rs's only stateful encoder, genuinely
  reachable via chardetng auto-detection — could leave the raw
  chunk's trailing shift-state (e.g. ending in Roman mode via ESC ( J)
  disagreeing with the encoder's internal state, so the next
  re-encoded chunk omitted its escape sequence and the file decoded
  to silently different text with had_errors=false — worse than the
  canonicalization being fixed. Closed by a stateless-encoding gate
  (`enc != ISO_2022_JP`, static-singleton identity, alias-proof —
  reviewer re-verified and lifted the REJECT); the corruption
  signature is pinned by a red→green cross-chunk fixture, and the
  lesson is recorded in the judgment overlay. New
  `StreamReplaceReport.unmatched_region_reencoded` field awaits the
  (2/3)/(3/3) UI. 360 Rust tests (26 in streamreplace, +8).
- [x] #96 (2/3): lazy byte-drift detection on a doc's first save —
  rebuild the full save pipeline (line-ending re-application + BOM)
  against the on-disk bytes and warn once, informed-consent style,
  before normalizing legacy byte variants; Mixed-line-ending files are
  skipped (their pipeline output is inherently unreproducible) [danger].
  New `bytedrift.rs::check_byte_drift(path, encoding, with_bom)`:
  re-reads the on-disk bytes, decodes via the same `decode_with` path
  an explicit open uses (adversarial review verified the label
  round-trip is exact and legacy encodings never hit BOM handling),
  re-detects the file's own line ending from disk — deliberately not
  the doc's current setting, so a user's explicit LF→CRLF conversion
  is never misreported as legacy-byte canonicalization (a review-caught
  false positive: the dialog would have blamed Big5 for a byte change
  the user themselves requested) — then applies apply_line_ending +
  encode + BOM re-prefix and memcmps. Skips (cheapest-first, Mixed and
  UTF-8/UTF-16 before any disk read, proven by nonexistent-path tests):
  Mixed line endings, Unicode targets (1:1 mappings), malformed files
  (the stronger malformed warning already owns those). Frontend gate
  (`bytedrift.ts`, injectable orchestrator + pure decision helpers)
  runs inside runSaveFlow's #124 lock before the stale/lossy gates,
  first save per doc per session only (`byteDriftChecked`, reset on
  reload/reopen, deliberately not persisted to the session store), and
  only for same-path saves (Save As has no baseline to drift from).
  Cancel aborts the save like the lossy gate; an IPC failure fails
  open for that save but leaves the flag unset so the next save
  retries (review-caught: setting it eagerly would have silenced the
  check for the whole session on a transient file lock). i18n across
  en/zh-TW/ja/zh-CN. Failing-test-first both rounds (stub → 7 of 10
  red; review fixes → 4 more red-then-green). 372 Rust + 616 vitest.
- [x] #96 (3/3): batch conversion dry-run report gains a per-file
  byte-drift flag (a same-encoding "no-op" conversion that would still
  canonicalize bytes becomes visible before execute) [danger].
  `BatchEntry.byte_drift`, computed only for alreadyTarget (no-op)
  files — the one case where the user expects bytes to stay put — via
  a new `rebuild_output_bytes()` extracted verbatim from
  `commit_conversion` so scan and execute can never disagree
  (adversarial review verified the extraction bit-for-bit and that
  execute never consumes the flag). The no-op test reuses batch's own
  alreadyTarget predicate including the BOM axis; Mixed-line-ending
  files skip per the (2/3) ruling, and the line-ending axis can't
  false-positive (a pure-LE no-op file round-trips exactly; any
  residue classifies as Mixed and is skipped). Since alreadyTarget
  rows are never checkable for execute, the badge is honest
  diagnostics ("would drift on re-save"), not an action warning —
  wording verified in review. Panel badge mirrors the malformed
  badge, drift count joins the summary line, i18n across four
  locales. Review AGREE; its one observation — a keep-encoding
  line-ending-only conversion still silently canonicalizes legacy
  bytes on convertible files, the deliberately-out-of-scope other
  half — is filed as #176. The (1/3) report field with no UI consumer
  yet is filed as #175. Failing-test-first via stubs on both sides
  (real red runs). 377 Rust + 622 vitest. #96 closed — all three
  stages landed.

**Track S — replace in files** (the new capability, built on Track R's
byte-preservation machinery)
- [x] Rust backend: line-scoped replace (search.rs's existing per-line
  match semantics) with line-level byte preservation — only matched
  lines are re-encoded, line-terminator bytes are copied verbatim,
  untouched lines stay byte-identical; UTF-16 falls back to whole-file
  re-encode (its mapping is 1:1, no drift); per-file fingerprint
  continuity from dry-run to execute (files changed in between are
  reported, never silently re-matched), atomic temp+rename, lossy
  two-phase gate, scan-error surfacing; regex match with literal-only
  replacement (no backrefs, v1 scope); the 5 MiB search cap carries
  over with oversized files disclosed as skipped; stateful encodings
  excluded by an ASCII-compat invariant test [danger]. New
  `replaceinfiles.rs` (`scan_replace_in_folder` /
  `execute_replace_in_folder` + ipc.ts bindings; the panel UI is the
  next item). Three reviewed design decisions: scan counts matches on
  linebreak.rs's three-way byte-level split rather than `.lines()`
  (which misses lone CR — dry-run and execute must agree on
  Classic-Mac files, pinned by an agreement test); a twin folder walk
  instead of reusing search.rs's collect_files (whose silent 5 MiB
  drop conflicts with skipped+reason disclosure; batch.rs set the twin
  precedent); and routing on encoding_rs's own
  `is_ascii_compatible()` — exactly {REPLACEMENT, UTF-16LE/BE,
  ISO-2022-JP} fall out, so the R1a stateful-encoder lesson is honored
  by construction (ISO-2022-JP whole-file fallback, shift-state
  self-consistent, pinned by a cross-line Roman-mode fixture), and
  REPLACEMENT can never reach a write (everything it decodes is
  malformed → skipped). The ASCII-compat invariant test sweeps all 40
  encoding_rs encodings over planes 0–1 empirically rather than by
  table. Lossy gate re-checks at execute time from the encoder's own
  unmappable flag (never trusting the scan's prediction);
  `regex::NoExpand` keeps replacements literal ("$1" writes
  literally). Mixed-line-ending files preserve every line's own
  terminator verbatim (whole-file bytes oracle). Adversarial review
  AGREE (seven attack surfaces held); its observations filed/tracked:
  ext-hint detection divergence vs open_document (#178), HTML
  numeric-reference lossy semantics to be spelled out in the panel's
  confirm wording (next item). 389 Rust tests (+12).
- [x] Frontend: replace field in the find-in-files panel + dry-run
  preview (files × hit counts × drift/lossy flags), per-file
  checkboxes, a batch-convert-strength destructive confirm, and a
  post-execute summary; i18n across en/zh-TW/ja/zh-CN. Pure logic
  (preview rows, confirm-message building, selection→execute-params,
  result classification) in a new `replaceinfiles-ui.ts` (the
  lossysave/bytedrift extraction precedent), DOM wiring in
  findinfiles.ts; plain search behavior untouched (original tests
  unmodified). Gate properties verified adversarially: busyReplace
  set synchronously before the confirm await (double-click test),
  targets/totals/confirm message snapshotted at one synchronous
  moment (checkbox flips during the dialog can't desync message from
  execute params), allowLossy true only when the *selected* set
  contains lossy files (unchecked lossy files don't raise it), the
  lossy wording names the HTML numeric-character-reference semantics
  outright, skipped files excluded at both the DOM and pure-function
  layers, and all five backend statuses render distinctly (failures
  can't vanish). Review-caught fixes landed before commit: the
  preview now surfaces `report.truncated` ("the rest of the folder
  was not scanned") — previously a 600-match folder showed 500,
  executed 500, and reported success with zero disclosure — and
  regex mode shows a "replacement is literal, $1 won't expand" hint
  before the user ever runs a scan. 684 vitest (+62 over the
  pre-item baseline).
- [x] Find-in-files query/replace inputs wired to the existing
  searchhistory module (localStorage datalist, the CM6-panel
  precedent). searchhistory.ts turned out to already be generic
  (shared find/replace MRU singletons behind plain functions) — a
  zero-line diff there; the panel builds its own two namespaced
  datalists mirroring editor.ts's private helper. Queries record on
  every resolved search; replace scans record query+replacement only
  after the non-stale generation check. History is shared with the
  CM6 panel structurally (same module singleton), asserted both
  directions in tests. 690 vitest (+6).

**Track E — encoding breadth [danger]**
- [x] Curated encoding list expansion: windows-125x family, common
  ISO-8859 members, KOI8-R/U, windows-874, macintosh (one-shot
  selection from encoding_rs's supported set), each addition with
  round-trip tests and a fuzz-pool entry; stateful encodings
  (ISO-2022-*) are permanently excluded, pinned by an ASCII-compat
  invariant test over the entire picker list. 11→27 choices
  (windows-1250–1258, ISO-8859-2/5/7/15, KOI8-R/U, windows-874,
  macintosh); every consumer (reopen/save-with/convert menus,
  preferences' default + per-extension tables, batch, compare
  preview) picks the additions up generically. The whitelist mirror
  reuses fuzz_roundtrip.rs's existing `ALL_ENCODING_LABELS` as the
  single Rust-side constant (no second mirror to drift), with
  back-references in both files; the invariant test asserts every
  label resolves to its canonical name and is ascii-compatible or
  UTF-16 — pushing "ISO-2022-JP" into the list fails it (verified
  red). 16 new encode-filtered fuzz pools each with a sanity test
  (single-byte encodings almost never malform, so the fuzz claim
  stays honest: it covers encode-side round-trips, not decode
  robustness); the release-mode 3000-case × 26-encoding ignored
  variant passes. Adversarial review AGREE — 68 display-name strings
  across four locales fact-checked (no language mix-ups), the
  windows-1258 Vietnamese combining-character non-injectivity attack
  held off (encoding_rs's single-byte path does no normalization;
  precomposed forms simply filter out), list correspondence 27↔26
  exact. Mojibake-wizard Cyrillic hypotheses (windows-1251⇄KOI8-R)
  filed as #182. 422 Rust tests (+33) + 690 vitest.
- [ ] Encoding picker group headers (popup.ts section support:
  Unicode / East Asian / Western / Central European / Other), reopen
  and save-with-encoding menus kept in sync
- [ ] Detection-boundary documentation: single-byte families chardetng
  cannot reliably detect are labeled "manual reopen only" consistently
  in the detection diagnostics; no detection behavior change

**Track C — comfort (stretch: cut first under schedule pressure)**
- [ ] Reopen closed tab (Mod+Shift+T, per-session stack, File menu
  entry, untitled tabs excluded)
- [ ] Tab context menu: Close Others / Close to the Right / Copy Path /
  Reveal in Finder(Explorer) via the already-bundled opener plugin
  (zero new dependencies; path items disabled for untitled tabs)
- [ ] Go to line supports line:column (column positioned within the
  loaded window in large-file mode)

**Track H — outward & close-out**
- [ ] README: add an Install section (GitHub Releases pointer +
  unsigned-build caveats for macOS/Windows) and an accuracy pass over
  existing content; no naming-heavy outward material while D1 is
  undecided; positioning red lines checked per DIRECTION §5-S13
- [ ] Cycle close-out: version 0.5.0 bumped consistently, tag
  v0.5.0-alpha.1, zh-TW release notes, prerelease published (publishing
  pre-releases is delegated; final releases remain user-gated)

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
