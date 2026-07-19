# Roadmap

This is the execution queue only. Strategy, decision gates, phase plan,
scenario playbook, and the pre-triage feature backlog live in
[DIRECTION.md](DIRECTION.md) — items are promoted from there into this
file once the user signs off. Completed cycles' full item-level record
(design rationale, edge cases, test evidence — everything trimmed out of
the summaries below) lives in
[docs/archive/roadmap-completed-cycles.md](docs/archive/roadmap-completed-cycles.md).

This roadmap is deliberately narrow. The goal of v0.1 is a tool you can genuinely use every day to open, read, and edit text files — not half an IDE.

## North star

> Open a text file faster than an IDE. Handle legacy encodings more reliably than most modern editors. Feel native on macOS — and on Windows.

## Open items (user-gated)

Carried over from v0.3 Track D — release & community. Both are blocked
on a user decision, not on engineering work; full context in the
archived v0.3 record and in DIRECTION §2/§3.

- [ ] D1 official name — user decision; shortlist re-verified 2026-07-15
  (evidence lives in the maintainer's local private storage since the
  repo went public — see DIRECTION §3/D1)
- [ ] D2 signing + auto-update — blocked on D1 and user-held keys
  (runbook in the maintainer's local private storage)

## v0.7 — consistency, serialization & daily-driver closure (planned 2026-07-18, delegated)

Scope planned autonomously under the user's standing delegation (user
away until 2026-07-22; same model as v0.4–v0.6: plan the cycle, merge on
green CI, post-merge review). Planning was preceded by a four-agent
current-state audit, so nothing below re-plans something that already
exists (Enter auto-indent, move/duplicate line, status-bar text stats,
tab context-menu copy-path/reveal were all confirmed present and
excluded), and the plan passed an adversarial review before work started
(AGREE-WITH-CHANGES; every requested change adopted — see per-item
notes). One structural constraint shapes the cycle: **no GUI can be
launched** (user away, desktop possibly locked, standing caution), so
editor-UX items are built as pure-logic cores with thin CodeMirror
bindings, vitest-covered, and dual-WebView manual acceptance is
explicitly deferred to the user's return; only two such items (the trim
and in-selection ones) are admitted, per the review's cap. Theme: close
the remaining consistency gaps (snapshot reads, write serialization),
deepen the mojibake table by investigation, and finish the
daily-driver comfort backlog that needs no GUI. Items marked
**[danger]** follow judgment overlay §1: failing-test-first, round-trip
tests where encoding behavior changes, adversarial review before
commit; danger items are never worked in parallel. #89 stays open as
the good-first-issue surface.

**Track R — debt & correctness** (ordered by execution)

- [x] #231: clean doc's Save with Encoding leaves a spurious dirty flag
  after a non-stale write failure — the rollback branch restores
  encoding/withBom but not dirty; capture the revision at force time
  and restore dirty=false when the rollback condition holds and the
  revision is unchanged; also reconcile the backup flush already
  scheduled for the rolled-back state (adversarial-review addition)
  [danger]
- [x] #254 (remaining half): one consistent-snapshot backend command
  for Document Info — a single Rust command opens the file once and
  derives all three sections (file metadata, detection evidence,
  line-ending distribution) from that one read, replacing the three
  parallel IPC calls in docinfo.ts; the response keeps per-section
  Result fields so the dialog's existing per-section error degradation
  survives (adversarial-review addition); explain_detection itself
  stays, detectcard.ts uses it independently [danger]
- [x] #236: per-process fixture_dir isolation for the five listed test
  files (batch.rs, fsguard.rs, replaceinfiles.rs, search.rs,
  streamcodec.rs), applying the #237 pattern; sweep the other
  fixed-temp-name test files in the same PR where the same mechanical
  change applies
- [x] prefs + session write serialization: every savePreferences call
  site (preferences.ts, 7 sites) and persistSession path (main.ts, 8
  sites) goes through an op queue — per-file queue, snapshot captured
  at enqueue time (both adversarial-review additions) — closing the
  same late-write-overwrites-newer race #270 closed for recent files
  [danger]

**Track E — encoding trust**

- [ ] mojibake-pair investigation batch: run the dual gate (chardetng
  reachability + reverse-hypothesis rejection) over the candidates
  (WINDOWS_1251, UTF_8), (EUC_KR, UTF_8), (EUC_JP, UTF_8),
  (WINDOWS_1250, UTF_8), and — last, cheapest-death-first per the
  adversarial review — (KOI8_U, WINDOWS_1251); admit whatever passes,
  with the mandatory fuzz_roundtrip.rs MojibakePools/match-arm sync
  (known runtime-panic dead end, overlay §4), and record written
  rejections in mojibake.rs docs for the rest; zero admissions is a
  valid outcome — the rejection record is the deliverable;
  docs/encoding-detection.md updated in the same PR [danger]

**Track C — comfort** (no-GUI shapes; manual acceptance deferred where noted)

- [x] go to matching bracket: menu + palette wiring for the built-in
  cursorMatchingBracket command
- [x] encoding-picker alias search: typing an IANA/common alias
  (latin1, cp950, …) matches the canonical encoding in the picker;
  investigate the picker's existing filter mechanism first — if
  aliases already match, close with findings
- [ ] trim trailing whitespace on save: opt-in preference (default
  off); the trim is applied as an editor edit before the normal save
  flow so buffer and disk stay identical — the spec must keep the
  caret stable and fold the trim into the save so one undo step
  reverts the user's last edit, not the trim (adversarial-review
  addition); round-trip tests; large-file mode is untouched (read-only
  preview cannot save); dual-WebView manual acceptance deferred
  [danger]
- [ ] find/replace in selection: replace / replace-all scoped to the
  current selection — built as a pure, vitest-covered core
  ((docText, ranges, query) → edits, including post-replace
  range-shift bookkeeping) with a thin CodeMirror binding, per the
  adversarial review; dual-WebView manual acceptance deferred [danger]
- [ ] insert date/time (stretch — first to cut if the cycle runs
  long): Edit-menu + palette command inserting a localized timestamp
  at the caret

**Track V — robustness**

- [x] per-module corruption regression tests: session.rs, prefs.rs,
  recent.rs each get their own truncated/invalid-JSON tests against
  their real file name and real struct (today they only inherit
  store.rs's generic guarantee)
- [ ] external delete/rename visibility: verify what the watcher
  actually surfaces today for on-disk delete and rename (notify
  Remove / Modify(Name) events), document the gap analysis; any fix
  this cycle is limited to vitest-testable logic — findings-only is a
  valid close (adversarial-review scoping)

**Track H — outward**

- [x] keyboard-shortcut reference: one consolidated table
  (docs/features.md appendix or docs/shortcuts.md) sourced from
  menu.rs LABELS and the CM6 built-in keymap — never hand-recalled
- [x] CONTRIBUTING.md: links dev-setup.md, the Definition of Done, PR
  conventions, and the commit-language policy for external
  contributors (zh-TW preferred, English accepted); positioning red
  lines apply

**Close-out**

- [ ] routine cargo-lockfile refresh (18 compatible updates pending at
  planning time) as a small chore PR
- [ ] cycle close-out: CHANGELOG.md, version bump across
  tauri.conf.json / package.json / Cargo.toml, tag v0.7.0-alpha.1
  (pre-release authority), handoff memory update

## Completed cycles

Summary index only — every item's full design rationale, edge cases,
and test evidence is archived verbatim in
[docs/archive/roadmap-completed-cycles.md](docs/archive/roadmap-completed-cycles.md).
Item counts below are shipped `[x]` items per cycle.

- **v0.1 — MVP + Post-MVP candidates** (16 items, 2026-06, tags
  `v0.1.0-alpha.1` → `v0.1.0-alpha.7`): multi-tab editing; full encoding
  detection/reopen/save-with-encoding/BOM/line-ending handling; regex
  find/replace; session restore; native macOS/Windows menus and file
  association. Post-MVP: large-file mode (phases 1-2b), find in files,
  recent files/quick open, column selection, drag-and-drop open,
  auto-reload, printing.
- **v0.2 — polish + feature cycle** (18 items, approved 2026-07-10, tag
  `v0.2.0-alpha.1`): atomic saves, hot exit, cursor/window persistence,
  large-file phase 2c, full visual refresh (design-token system); theme
  system, zh-TW i18n, show-invisibles, hex/bytes preview, per-extension
  default encoding, find/replace history, startup-time budget test,
  encoding-detection diagnostics.
- **v0.3 — feature cycle, four tracks** (12 items done + 2 open, approved
  2026-07-11, tag `v0.3.0-alpha.1`): Track A encoding tools (mojibake
  repair wizard, batch encoding/line-ending conversion, side-by-side
  encoding preview); Track B large-file streaming find/replace +
  line-offset index; Track C code folding/line operations/indent guides;
  Track D issue templates + ja/zh-CN i18n — D1/D2 remain open, see above.
- **v0.4 — character-level trust** (26 items, planned 2026-07-14,
  delegated, tag `v0.4.0-alpha.1`): character inspector,
  suspicious-character audit, full/half-width conversion, Unicode
  NFC/NFD normalization, lossy-save character preview (all [danger]);
  streaming encoding conversion for large files; multi-cursor, per-tab
  read-only mode, tab drag-to-reorder, indentation tools; fsguard
  fingerprint guards, save-completion revision gating, CR-only
  line-ending fixes, chunk-generation race guards. Ended at 333 Rust /
  572 frontend tests.
- **v0.5 — byte-fidelity + replace-in-files** (21 items across five
  tracks, planned 2026-07-15, delegated, tags `v0.5.0-alpha.1` /
  `v0.5.0-alpha.2`): byte-passthrough streaming replace + lazy
  byte-drift detection (#96, 3 stages); new replace-in-files capability
  (Rust backend + panel UI); encoding breadth 11→27 curated encodings
  with a grouped picker; reopen-closed tab, tab context menu, go-to
  line:column; README install section. Six issues closed, six
  follow-ups filed, tests 333/572 → 423/763.
- **v0.6 — bug queue + trust visibility** (19 items across five tracks,
  planned 2026-07-16, delegated, tag `v0.6.0-alpha.1`): inherited bug
  queue closed (#201/#203/#217/#221/#223/#225/#227); Document Info
  dialog, EUC-JP ⇄ windows-1252 mojibake pair; command palette,
  join/reverse lines, sort variants, clear recent files; session
  forward-compat fixtures, IPC error-path audit; CHANGELOG backfill,
  docs/features.md. 20 PRs (#229–#249 range), ended at 522 cargo test /
  955 vitest.

111 shipped items total across the six cycles above; 2 remain open
(D1/D2, tracked under "Open items" above, not counted here).

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
