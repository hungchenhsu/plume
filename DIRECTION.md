# Direction

This is the strategic charter for the project. [ROADMAP.md](ROADMAP.md) is
the execution queue (what is being built right now); this document is
everything above it: where the product is going, which decisions are still
open, what to do when circumstances change, and how any future working
session — human or agent, regardless of capability — should pick up the
work. When this document and reality diverge, update this document in the
same PR that changes course.

Last full review: 2026-07-10.

---

## 1. Mission and positioning

**One sentence:** a small, fast, native-feeling text editor whose core
competence is handling text encodings — especially East Asian legacy
encodings — more reliably than anything else in its class.

**The three pillars (in priority order):**

1. **Never corrupt or misrepresent user text.** Encoding detection,
   decode-error surfacing, round-trip fidelity (encoding + BOM + line
   endings), atomic saves, hot exit. Data integrity is this project's
   equivalent of payment-system correctness.
2. **Instant.** Cold start faster than any IDE; opening a file feels
   immediate; huge files don't lock the UI.
3. **Native on each platform.** macOS feels like a Mac app, Windows feels
   like a Windows app. Platform-correct, not platform-neutral.

**Who it is for:** people who routinely touch files that modern
Unicode-only tooling mangles — Big5 / Shift_JIS / GB18030 documents, mixed
line endings, BOM-sensitive files — plus anyone who wants a quick,
trustworthy scratchpad-and-log-viewer that opens instantly.

**What differentiates it:** every mainstream editor treats legacy encodings
as an afterthought. Here they are the identity. Feature decisions should be
tested against the question: *does this make the editor more trustworthy or
faster for text files, or is it IDE creep?*

**Branding note:** "Plume" is a development codename, not the product name
(see Decision Gate D1). Do not use it in outward-facing material.

## 2. Current state (2026-07-16)

- **v0.6 feature cycle in progress** (planned 2026-07-16 under the
  user's standing delegation, user away until 2026-07-22; same model as
  v0.4/v0.5). Adversarially reviewed before start (AGREE-WITH-CHANGES,
  all changes adopted — notably three CJK↔CJK mojibake candidates
  dropped in planning as the reachable-but-wrong shape mojibake.rs
  already rejects). Scope: the whole open bug queue (#225/#221/#217/
  #223/#227/#203/#201 — the latter two placed by explicit user decision
  of 2026-07-16), Document Info dialog, one narrowed mojibake pair,
  command palette, line-op/recent-files comfort items, session
  compat fixtures, IPC error-path audit, CHANGELOG + features guide.
  See ROADMAP.md §v0.6.
- **Housekeeping (2026-07-16, per explicit user decision):** the stale
  v0.2.0-alpha.1 and v0.3.0-alpha.1 *draft* releases were deleted (notes
  backed up first); both git tags kept. #89 stays open as the
  good-first-issue surface.
- **v0.5 feature cycle complete** (2026-07-15→16, PRs #156–#196 range):
  planned and executed autonomously under the user's 2026-07-15
  delegation (same model as v0.4), adversarially reviewed before start
  (AGREE-WITH-CHANGES, all adjudicated). All five tracks delivered —
  **debt & robustness** (the whole bug queue: #96 in three stages
  including streamreplace byte-passthrough with an
  ISO-2022-JP-shift-state P1 caught and killed in review, lazy
  save-time byte-drift consent, batch drift flags; #124 save/reload
  mutex; #128/#130 TOCTOU + scan-error twins; #134 preempt; #136 trim
  gate; a chunk-paging property fuzz), **replace in files**
  (line-level byte-preserving backend + panel UI + shared search
  history), **encoding breadth** (11→27 picker choices with invariant
  tests, grouped pickers, detection-boundary docs), **comfort
  stretch** (reopen closed tab, tab context menu, goto line:column),
  **outward** (README install/accuracy pass under the positioning red
  lines). Every danger item passed adversarial review; issues
  #96/#124/#128/#130/#134/#136 closed, follow-ups filed
  (#165/#169/#175/#176/#178/#182). Tests at cycle end: 423 Rust + 763
  vitest (cycle start: 333/572). Tagged **v0.5.0-alpha.1**.

- **v0.2 feature cycle complete** (PRs #34–#50): full visual refresh on
  design tokens, built-in themes, UI i18n (zh-TW first), all six Tier-1
  encoding/editing items. Tagged **v0.2.0-alpha.1**.
- **v0.3 feature cycle complete** (PRs #65–#90, all CI-green): all four
  parallel tracks delivered — **encoding tools** (mojibake repair
  wizard, batch encoding + line-ending conversion, side-by-side encoding
  preview), **large files** (streaming find/replace, line-offset index +
  bookmarks), **editing comfort** (code folding, line operations, indent
  guides), **release & community** (issue templates + good-first-issues,
  ja + zh-CN i18n). Preceded by a P1/P2 data-integrity sweep: five P1
  fixes (two-phase lossy save, atomic_write symlink hardening,
  session-index atomicity + orphan recovery, hot-exit backup-failure
  handling, bounded large-file read) and three P2s. Tagged
  **v0.3.0-alpha.1**. D1 (naming) explicitly deferred by the user; D2
  blocked behind it.
- **v0.4 feature cycle complete** (2026-07-14→15, PRs #110–#152):
  planned and executed autonomously under an explicit user delegation
  (user away; post-merge review pending), adversarially reviewed before
  start. All four tracks delivered — **character-level trust**
  (character inspector, invisible/bidi-character audit, width
  conversion, Unicode normalization with representability guard,
  lossy-save character preview, BOM-toggle gap verification), **large
  files & performance** (#107 fix, streaming encoding conversion,
  open-latency bench script — numbers pending user), **editing comfort**
  (multi-cursor menu exposure, line shuffle ops, word/char count, tab
  drag-reorder, per-tab read-only, indentation tools), **robustness**
  (round-trip fuzz across all 10 encodings). Mid-cycle S1 interrupt: a
  10-issue external review batch (#112–#121) — 3 P1 save-path
  stale-overwrite bugs and 6 P2s — was fixed first (PRs #123–#137,
  fsguard fingerprint module, revision-gated save completion, shared
  line-break semantics). Also: repo visibility was found PUBLIC and
  restored to private (D3 gates unmet; #121 open for the user), after
  which GitHub Actions became billing-blocked — every PR since carries
  local full-matrix verification evidence instead; re-run CI on main
  once billing is fixed.
- Tests at cycle end: 333 Rust + 572 vitest (cycle start: 182/245).
  Tagged **v0.4.0-alpha.1**.
- **Repo is PUBLIC by explicit user decision (2026-07-15)**: the user
  confirmed the earlier visibility flip was deliberate (public repos get
  free Actions CI, and "it's about time"), overriding the original
  keep-private-until-named gate. Consequence: D3 is now *partially*
  entered out of order — the remaining hygiene items (D1 naming,
  `.claude/archive/` internal-material purge, outward-facing README
  pass, macOS signing) are outstanding **post-publication** work items
  rather than preconditions, tracked in §3/D3. The positioning red
  lines (§5-S13) apply with full force now that every file is
  outward-facing. Actions billing on the account remains unfixed but
  moot while public.
- Contributor onboarding docs live in `docs/dev-setup.md` (macOS +
  Windows); pre-release tagging is delegated to the agent (final
  releases remain user-gated).
- Open decision gates: naming (D1), signing/updates (D2), distribution
  (D4) — see §3. D3 (going public) was entered early by user decision
  on 2026-07-15; its remaining items are post-publication work, not a
  gate (§3/D3).
- Known operational constraints and dead ends live in
  [.claude/judgment-overlay.md](.claude/judgment-overlay.md); hard
  architectural constraints in [ARCHITECTURE.md](ARCHITECTURE.md).

## 3. Decision gates

These are the four product-level decisions that block later phases. Each
lists its options, the recommended default, and the concrete process. All
four are **user decisions** — a working session prepares the material and
proposes, but never decides unilaterally.

### D1 — Official name

**Blocks:** going public (D3), distribution (D4), signing identifiers (D2
partially — bundle ID should be final before certificates are issued).

**Constraints:**

- Must not collide with the existing ActivityPub blogging platform named
  Plume (joinplu.me) or any other active software product in an adjacent
  category.
- Works in both English and Traditional Chinese contexts; easy to say,
  spell, and search for.
- Availability needed: GitHub org/repo name, a domain (.app or .dev is
  fine), and ideally the name is clean on crates.io/npm even if unused.
- No trademark conflicts in the editor/developer-tool space (a
  common-law-level search is enough at this scale; full trademark
  registration is optional and deferred).

**Process:**

1. Generate 15–20 candidates (themes that have worked in discussion:
   lightness/feathers, speed, clarity/text, CJK-friendly words).
2. For each survivor of a taste filter, run the availability checklist:
   GitHub search, crates.io, npm, a general web search, domain lookup.
   Record results in a table — **never assert availability without an
   actual lookup; unverified entries are marked "unchecked".**
3. Present a shortlist of 3 with evidence; user picks.
4. After the pick: rename the GitHub repo (old URLs redirect
   automatically), update `productName`/window titles, and change the
   bundle identifier. **Bundle-ID change consequence:** config dir,
   window-state, session store, and file associations key off the
   identifier — existing installs (currently just the developer's own
   machines) will appear to reset. Ship a one-time config-migration step
   or accept the reset explicitly in the release notes; do not let it
   silently discard hot-exit backups.

**Fallback:** if every good candidate is taken, prefer a two-word or
coined name over shipping as "Plume". Shipping under the codename is a
last resort and requires an explicit user sign-off on the collision risk.

### D2 — Signing, notarization, and auto-update

**Blocks:** frictionless installs, auto-update, serious distribution.

Three independent pieces, cheapest first:

1. **Updater keys (no cost, do first).** `tauri-plugin-updater` uses its
   own minisign keypair, independent of OS code signing. Generate the
   keypair, store the private key in a GitHub Actions secret **and** an
   offline backup the user controls, embed the public key in
   `tauri.conf.json`. Losing the private key strands every installed copy
   on its current version — treat the backup as a hard requirement, not a
   nicety.
2. **macOS (user's primary platform).** Apple Developer Program
   (US$99/year) → Developer ID Application certificate → `codesign` +
   `notarytool` wired into the release workflow via GitHub secrets.
   Without it, users must right-click-open or `xattr -cr` the app —
   tolerable for private alpha, unacceptable for public release.
3. **Windows.** Recommended path: Azure Trusted Signing (subscription,
   ~US$10/month, requires identity validation) — it gives SmartScreen
   reputation without the classic OV-cert reputation grind. Alternatives:
   OV certificate (~US$100–300/year, SmartScreen warnings persist until
   reputation accrues) or shipping unsigned with documented warnings.
   Decide when D3 is in sight; not needed during private testing.

**Recommended sequencing:** updater keys → auto-update feature behind them
→ macOS signing → (at public release) Windows signing.

### D3 — Going public

**Status: entered early by explicit user decision (2026-07-15).** The
repo is public; the original preconditions below are kept for the
record but are now **post-publication work items**, not gates:

1. D1 decided and applied — still open (the largest remaining item; the
   README carries an explicit "Plume is a working codename" notice as
   the accepted interim treatment while public — honesty over hiding —
   recorded here as the sanctioned exception to the §1 branding note
   until the rename lands).
2. Repo hygiene sweep — archive material relocated out of the repo
   (2026-07-15); README rewritten with an Install section and accuracy
   pass (v0.5 H1); screenshots still owner-pending (agents must not
   launch the GUI).
3. macOS signing — pending (D2, user-held; planned 2026-07-22).
4. A tagged build in daily use — ongoing (alpha pre-releases are
   published; the §7 versioning policy's original "first public tag is
   v0.1.0-beta.1" plan was overtaken by events: the repo went public
   mid-alpha, so alpha tags are public and the beta designation now
   simply marks the first signed build).

Publishing remains deliberately quiet-first; loud marketing is a
separate, later user decision.

### D4 — Distribution channels

Staged; each stage only after the previous is stable:

1. **GitHub Releases** (already working via the tag pipeline) — always the
   canonical source.
2. **Homebrew cask** (macOS) — needs public repo + non-draft release;
   straightforward PR to homebrew-cask once there's a stable tag.
3. **winget** (Windows) — needs a signed installer for a good experience;
   manifest PR to microsoft/winget-pkgs.
4. **Deliberately skipped for now:** Mac App Store (sandboxing conflicts
   with "open any file anywhere" and file-association UX), Microsoft
   Store (revisit only if user demand appears), Linux repos (Tier 2 —
   AppImage/deb artifacts exist from the pipeline; formal packaging is
   community-welcome, not roadmap).

## 4. Phase plan

Phases gate on decisions and evidence, not dates. Each phase lists entry
criteria, work, and exit criteria. Skipping a gate requires an explicit
user decision recorded in this file.

### P0 — Field testing (exited 2026-07-10 by user instruction)

- **Entry:** alpha.7 installed on the user's machines. (Done.)
- **Work:** use the editor for real daily tasks. Every friction point,
  bug, or wish becomes a GitHub issue immediately, labeled `bug` /
  `friction` / `idea` — unfiltered, low ceremony. Working sessions during
  P0 do **not** invent features; they fix reported bugs and keep CI/deps
  healthy (§7).
- **Exit:** any of — (a) 2–4 weeks of real use accumulated, (b) ≥10
  issues triaged, or (c) the user declares the phase done. Exit produces
  a triage: issues sorted into "fix now", "v0.2 backlog" (§6), "won't
  fix" — this triage, with the user, is what creates the next ROADMAP.

### P1 — Identity and update infrastructure

- **Entry:** P0 exit; user ready to spend on D2.
- **Work:** D1 naming process; updater keys + auto-update implementation
  (update check on launch + manual "Check for Updates" menu item,
  never auto-install without consent); macOS signing + notarization in
  CI; rename/bundle-ID migration.
- **Exit:** a signed, notarized, auto-updating macOS build under the
  final name that the user has installed via a normal double-click.

### P2 — Public release

- **Entry:** P1 exit.
- **Work:** D3 checklist; README/screenshots; `v0.1.0-beta.1`; Homebrew
  cask; Windows signing decision + winget if signed.
- **Exit:** repo public, beta tagged, at least one distribution channel
  beyond GitHub Releases live.

### P3 — feature cycles (current phase; recurring)

- **Entry:** a user-approved backlog (promoted from §6 into ROADMAP.md
  as checkboxes). *(v0.2 cycle: approved 2026-07-10 by session
  instruction, completed 2026-07-11. v0.3 cycle: four parallel tracks
  approved 2026-07-11 — see ROADMAP.md §v0.3. v0.4 cycle: planned
  2026-07-14 under an explicit user delegation of cycle planning and
  merges — user reviews post-merge; see ROADMAP.md §v0.4. v0.5 cycle:
  planned 2026-07-15 under the same delegation model, adversarially
  reviewed before start; see ROADMAP.md §v0.5.)*
- **Work:** normal feature PRs under the existing Definition of Done.
  One coherent item per PR; danger domains get the full treatment
  (§5-S1 discipline even without an incident).
- **Exit:** backlog empty or user pauses again — then loop back to a
  P0-style usage period. This build→use→triage loop is the permanent
  operating rhythm, not a one-off.

### P4 — Sustain / 1.0

- **1.0 criteria:** three months of daily use with zero data-loss
  incidents; signed on both Tier-1 platforms; auto-update proven through
  at least two real update cycles; public issues triaged within a week.
- **Sustain mode work:** dependency cadence (§7), upstream watching
  (Tauri 2.x, CodeMirror 6, encoding_rs, chardetng), community PR review
  once public.

## 5. Scenario playbook

What to do when things happen. Each scenario: trigger → response. Future
sessions should scan this list before improvising.

**S1 — A data-loss or corruption bug is found** (save path, hot exit,
encoding round-trip, atomic write). This outranks everything. Freeze
feature work. Branch from the latest release tag, reproduce with a
failing test *first*, fix, add a regression + round-trip test, run the
full verification matrix, ship a hotfix release immediately (alpha.N+1 —
user confirms the publish). Post-mortem sentence goes into the judgment
overlay's dead-ends/danger list.

**S2 — App fails to launch after a change.** Suspect startup-order issues
first (menu construction must stay inside Tauri `setup()`; PathResolver
state ordering). The startup smoke test exists precisely because CI unit
tests cannot catch this class — run it, then bisect with `git bisect` if
needed.

**S3 — Field testing stalls (user isn't reaching for the editor).** That
itself is the finding. Don't push features; run a friction audit instead:
what tool won, for which task, and why (speed? a missing capability? a
default?). The audit's answers — not brainstorming — seed the v0.2
backlog. If the honest answer is "no daily niche", the fallback position
is: keep it as a personal encoding-first utility, skip P2 marketing
ambitions, and keep maintenance cost near zero. That is a valid end state,
not a failure.

**S4 — Naming candidates all collide (D1).** Move to coined/two-word
names. Do not ship publicly as "Plume" without explicit user sign-off.

**S5 — User declines signing costs (D2).** Ship unsigned with honest
install instructions (right-click-open on macOS; SmartScreen "More info →
Run anyway" on Windows) documented in the README. Auto-update via updater
keys still works unsigned. Revisit when adoption justifies the spend.

**S6 — Upstream breaking change (Tauri, a Tauri plugin, CodeMirror).**
Policy: patch updates monthly in a routine chore PR; minor updates
quarterly; major updates get a dedicated PR with a full manual pass on
*both* WebViews plus the startup smoke test. If a plugin is abandoned,
prefer vendoring the minimal needed code over adding a new dependency
(bundle size and startup time are features).

**S7 — The `time`/cookie pin resolves.** `time` is pinned at 0.3.47
because cookie 0.18 fails against 0.3.48 (E0119). Check monthly whether a
fixed cookie release exists; when it does: remove the pin note from
CLAUDE.md and the overlay, `cargo update`, full Rust verification suite,
dedicated chore PR.

**S8 — CodeMirror hits a wall** (performance, a needed capability, or
maintenance risk). The editor surface is swappable by design —
`src/editor.ts` is the only module importing CodeMirror. Evaluate
alternatives behind that boundary. Writing our own editor engine remains
a hard non-goal regardless of frustration level.

**S9 — Platform-divergence bug** (works on WKWebView, broken on WebView2
or vice versa). Reproduce on the other platform before theorizing; the
usual culprits are clipboard, fonts, IME, and newer CSS. The fix must be
verified on both engines; the release checklist's dual-platform manual
pass exists for this.

**S10 — A similar lightweight editor gains attention.** Do not chase its
feature list. The moat is encoding correctness + startup speed + data
integrity; respond by deepening those (better detection, better
diagnostics, faster cold start), not by widening scope into §9 territory.

**S11 — Working sessions lose access to stronger models.** This document,
[ROADMAP.md](ROADMAP.md), [ARCHITECTURE.md](ARCHITECTURE.md), and the
judgment overlay are the contract that makes weaker sessions safe. Rules
of engagement for a constrained session: (a) read §8 and follow it
literally; (b) prefer small Tier-1 backlog items and bug fixes with
existing test patterns to copy; (c) never touch danger domains (save
path, encoding round-trip, IPC boundary, large-file offsets) without a
failing-test-first workflow and adversarial review; (d) when judgment
runs out, open an issue describing the fork in the road instead of
guessing. Shipping nothing is always acceptable; shipping a silent
regression is not.

**S12 — Security advisory affects a dependency** (Tauri CVE, encoding_rs,
etc.). Assess exposure honestly (much of Tauri's attack surface assumes
remote content; this app loads only local assets — but say so with
evidence, not by reflex). Critical + actually-exposed: patch and release
within 48 hours. Not exposed: routine chore PR with the reasoning
recorded in the PR body.

**S13 — Anything outward-facing is about to be written** (README, release
notes, store listings, announcements). Check the positioning constraints
in the project memory/overlay before publishing: no competitor
comparisons naming specific products, and the codename rule (D1). When
in doubt, describe what the product *is*, never what it is *against*.

**S14 — A release must be yanked** (bad build shipped). GitHub Releases:
mark the release as pre-release/draft again or delete the asset, never
delete the git tag (installed updaters may reference it). Publish a
fixed release immediately after; note the yank in the new release's
notes. All of this is Red-tier: user confirms each step.

## 6. Feature backlog (pre-triage)

Candidate pool for future cycles. **Nothing here is committed** — user
triage promotes items into ROADMAP.md. *(2026-07-11: the v0.3 tracks —
encoding tools, large files, editing comfort, release & community — were
proposed and approved directly in-session; see ROADMAP.md §v0.3.)* Tiers reflect autonomy
required, not value.

### Tier 1 — safe for any competent session (small, testable, no design debate)

*All six promoted into ROADMAP.md on 2026-07-10 (user approval).*

| Candidate | Why it fits | Acceptance sketch |
| --- | --- | --- |
| Show invisibles toggle (spaces / tabs / EOL marks) | Encoding-first identity: seeing what's really in the file | View-menu toggle, persisted pref; CM6 built-in highlighters; both platforms |
| Hex/bytes preview for undecodable files | Turns decode-error surfacing into a diagnosis tool | Read-only bytes view offered from the decode-warning UI; Rust supplies hex dump; no editing |
| Per-extension default encoding | Users with legacy-encoding workflows have per-filetype habits | Prefs table ext→encoding; detection still wins when confident; round-trip tests |
| Find/replace history | Daily-driver ergonomics | Per-session or persisted history dropdown; vitest for the store |
| Startup-time budget test | Pillar 2 needs a regression guard | Scripted cold-start measurement; CI-friendly threshold or at least a tracked number |
| Encoding-detection diagnostics ("why was this detected as X?") | Trust through transparency | Status-bar popup shows the evidence behind the detection (BOM found, chardetng verdict) |

### Tier 2 — needs a design conversation with the user first

- **Multi-window** (session model, hot-exit interaction, menu focus —
  known to need discussion since 2026-06).
- **UI i18n** — *promoted 2026-07-10* (zh-TW first; resolved: no runtime
  dependency, lightweight typed dictionary module; covers native menus).
- **Custom themes / theme import** — *promoted 2026-07-10 as built-in
  themes only*, capped at a few good built-ins + CSS variables; no
  import.
- **Autosave-to-disk option** — *declined 2026-07-10* (hot exit already
  protects against loss); revisit only on user request.

### Tier 3 — blocked on decision gates or infrastructure

- **Auto-update** (blocked on D2 step 1; first real feature of P1).
- **Crash reporting / telemetry** — default stance: **none**. "No
  telemetry" is a feature consistent with the trust pillar; revisit only
  if the user explicitly wants opt-in diagnostics.

### Graduated (done, kept for reference)

Everything in ROADMAP.md's checked lists: MVP, large-file phases 1–2c,
find-in-files with regex, hot exit, atomic saves, session/cursor/window
persistence, printing, zoom, word wrap.

## 7. Engineering policies

**Versioning.** `v0.1.0-alpha.N` while private; first public tag is
`v0.1.0-beta.1`; `v0.1.0` stable when beta feedback settles; then semver
minor per feature cycle (`v0.2.0`, …); `v1.0.0` per the P4 criteria.
Breaking config-format changes bump minor at least and must migrate, not
discard, user state.

**Release checklist** (every tag, no exceptions):

1. Working tree clean on `main`, CI green, version bumped in
   `tauri.conf.json` + `package.json` + `Cargo.toml` consistently.
2. Full verification matrix locally (the judgment overlay §2 table).
3. Tag push → pipeline produces the draft release with all six installers.
4. Manual smoke on **both** Tier-1 platforms: launch; open a UTF-8, a
   Big5, and a >10 MB file; edit + save + reopen (round-trip intact);
   hot-exit kill-and-restore; check menus and shortcuts.
5. `CHANGELOG.md` updated in the same PR as the version bump: move the
   `Unreleased` entries under the new dated version heading.
6. Release notes written (zh-TW), draft reviewed by the user, **user
   confirms publish** (Red tier).
7. Post-release: install from the published artifact once, cold, on the
   primary machine.

**Dependency cadence.** Monthly chore PR: `cargo update` (respecting the
`time` pin while it stands, §5-S7) + `npm update` patch-level; quarterly
minor-level; majors per §5-S6. Any dependency *addition* still requires
strong justification (CLAUDE.md hard constraint).

**Quality gates.** The Definition of Done in CLAUDE.md is the floor,
never waived. Additions from hard experience: startup smoke test for
anything touching Tauri setup/menus; round-trip tests for any encoding
behavior; never mix CM6 character offsets with file byte offsets.

**Docs discipline.** ROADMAP checkbox in the same PR as the feature;
this file updated in the same PR as any change of course; lessons and
dead ends go to the judgment overlay, not scattered in commit messages.

## 8. Session handoff protocol

Decision tree for any future working session opening this repo:

1. **Read first:** CLAUDE.md → this file (§2 for state, §4 for the
   current phase) → ROADMAP.md → `.claude/judgment-overlay.md` → the
   project memory index. Do not start work before knowing which phase
   (§4) is active.
2. **Explicit user instruction?** Do that. It overrides phase defaults.
3. **Otherwise, is a phase gate satisfied?** (P0 exit evidence in the
   issue tracker; a decision gate resolved in this file.) Prepare the
   next phase's proposal for the user — preparation is autonomous,
   decisions are not.
4. **Otherwise, is there an open `bug` issue?** Fix the top one under
   full DoD.
5. **Otherwise, routine health:** dependency cadence due (§7)? Pin
   resolved (§5-S7)? CI still green on a fresh clone?
6. **Otherwise: stop.** Present the open decision list (§3) to the user.
   Do not invent scope — that lesson is already paid for
   (2026-06-13: autonomous value was exhausted; everything after that
   point is user-decision-driven).

And always: commit on feature branches only, zh-TW commit messages,
English docs, danger domains get tests before code.

## 9. Non-goals (permanent)

Restating ROADMAP.md's list because every future feature debate will
brush against it: no plugin system / scripting / macros, no project
panels or workspace management, no integrated terminal / debugger /
LSP intelligence, no FTP/SFTP, no ambition to replace an IDE. Additions
here require rewriting §1 first — if a feature needs the mission
changed to justify it, that is the signal it doesn't belong.
