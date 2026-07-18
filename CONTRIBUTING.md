# Contributing

Thanks for your interest in Plume! This project is young and currently
maintainer-driven, so the process is lightweight — but a few rules below
are firm. Quick note first: "Plume" is a working codename, not a final
product name (see the notice atop [README.md](README.md)) — please don't
build code, docs, or assets that assume the name is permanent.

## Licensing policy (please read first)

Plume is MIT-licensed. To keep it that way:

- **Do not copy or port code from GPL-licensed projects** (or any
  license incompatible with MIT), including other text editors.
  Studying *ideas and behaviors* is fine; copying or closely translating
  *code* is not.
- Only contribute code you wrote yourself or that is available under an
  MIT-compatible license (MIT, Apache-2.0, BSD) — note the source if you
  adapt anything.
- By submitting a contribution you agree it is licensed under the
  project's MIT license.

## Getting started

Full environment setup for macOS and Windows — prerequisites,
troubleshooting, platform notes — lives in
[docs/dev-setup.md](docs/dev-setup.md). The minimum to get running:

```sh
npm install
npm run build                # required once before any cargo command
npm run tauri dev            # run the app

npm test                     # frontend unit tests (vitest)
cd src-tauri && cargo test   # Rust core tests
```

## What to work on

- Small, scoped issues carry the
  [`good first issue`](https://github.com/hungchenhsu/plume/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22)
  label — the best place to start if you're new to the codebase.
- Larger feature work is planned in [ROADMAP.md](ROADMAP.md) and is
  currently driven by the maintainer in cycles. Want to pick up a
  roadmap item? Open an issue first to check it isn't already in progress.
- Found a bug? File it with the bug report issue template rather than
  jumping straight to a PR — it captures the platform/encoding details
  that make a fix fast, and data-integrity bugs (corrupted saves, lost
  content, silent mojibake) get top priority.
- Have an idea that isn't on the roadmap? Use the feature request
  template, and read ROADMAP.md's "Explicit non-goals" section first —
  Plume stays intentionally small, and PRs expanding scope (plugin
  systems, project panels, a terminal/debugger/LSP, FTP browsing, etc.)
  are declined regardless of code quality.

## Definition of done

All of these must pass locally before a PR is ready for review:

```sh
npm run build                                # tsc strict + vite
npm test                                     # vitest

cd src-tauri
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
```

Beyond green checks:

- New core logic in `src-tauri/src/` needs unit tests. Any change to
  encoding behavior (detection, decoding, encoding, line endings) needs
  round-trip tests — this is the project's highest-severity correctness
  area, so PRs touching it get extra scrutiny.
- Frontend logic that doesn't need the WebView (e.g. the tab store, pure
  helpers) gets vitest unit tests alongside the source file.
- If your change closes a ROADMAP.md item, check the box in the same PR.

CI runs the same checks; a green build locally but red CI usually points
to an environment difference worth tracking down rather than re-pushing
blind.

## PR conventions

- Work on a feature branch (in your own fork if you don't have push
  access) and open a PR against `main`. PRs are squash-merged once CI is
  green.
- Keep each PR to one coherent change — one bug fix or one roadmap item,
  not a bundle of unrelated things.
- **Commit messages and PR titles:** the maintainer's own convention is
  Traditional Chinese (zh-TW), visible throughout the existing history —
  but English is completely welcome and the natural default for
  external contributors. Use whichever you're comfortable with.
- **Code, comments, and docs are always English**, regardless of which
  language you use for the commit message or PR description.
- Mention which platform(s) you tested on if the change touches UI or
  platform integration — macOS and Windows are both Tier 1.

## Ground rules

A few architectural constraints PRs are expected to respect (full detail
in [ARCHITECTURE.md](ARCHITECTURE.md)):

- All disk I/O happens in the Rust core (`src-tauri/`). Raw bytes never
  cross the IPC boundary to the frontend — it only ever sees decoded
  text plus metadata (encoding, BOM, line ending).
- Decode errors are always surfaced to the user, never silently
  rendered as if the text were fine.
- No new runtime dependencies without a strong reason — small bundle
  size and fast startup are treated as features.
- The editor surface (CodeMirror) stays behind its own module
  (`src/editor.ts`) rather than spreading CodeMirror imports across the
  frontend, so it can stay swappable.
- **Rust style:** `rustfmt` defaults, `clippy` clean; prefer explicit
  error messages that include the file path or encoding label involved.
- **TypeScript style:** strict mode is on, keep it passing; no
  frameworks — the frontend is deliberately plain TypeScript + CodeMirror.

Anything here unclear, or want to sanity-check an idea first? Open an
issue — a blank one is fine.
