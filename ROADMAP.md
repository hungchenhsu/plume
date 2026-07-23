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

- [x] D1 official name — decided 2026-07-23: **Mojidori** (verification
  evidence in the maintainer's local private storage — see DIRECTION
  §3/D1). In-app rename + one-time data-dir migration shipped in this
  cycle; docs/URL sweep and repo rename tracked as follow-up.
- [ ] D2 signing + auto-update — D1 resolved; still blocked on
  user-held keys (runbook in the maintainer's local private storage)

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
- **v0.7 — consistency, serialization & daily-driver closure** (16
  items across five tracks + close-out, planned 2026-07-18, delegated,
  tag `v0.7.0-alpha.1`): inherited issues closed (#231 spurious dirty,
  #254 one-open Document Info snapshot, #236 fixture isolation);
  prefs/session write serialization; five new mojibake pairs (10→15)
  via the dual-gate investigation batch; replace in selection,
  trim-on-save, encoding-picker alias search, insert date/time,
  matching-bracket menu entry; external-delete visibility; per-module
  corruption tests; shortcut reference + CONTRIBUTING rewrite. PRs
  #273–#297, tests 987/532 → 1117/576 (vitest/cargo). Built under a
  no-GUI constraint: dual-WebView manual acceptance for the two
  editor-UX items is deferred to the user's return.
- **v0.6 — bug queue + trust visibility** (19 items across five tracks,
  planned 2026-07-16, delegated, tag `v0.6.0-alpha.1`): inherited bug
  queue closed (#201/#203/#217/#221/#223/#225/#227); Document Info
  dialog, EUC-JP ⇄ windows-1252 mojibake pair; command palette,
  join/reverse lines, sort variants, clear recent files; session
  forward-compat fixtures, IPC error-path audit; CHANGELOG backfill,
  docs/features.md. 20 PRs (#229–#249 range), ended at 522 cargo test /
  955 vitest.

127 shipped items total across the seven cycles above; 2 remain open
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
