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
