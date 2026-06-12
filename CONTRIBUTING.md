# Contributing

Thanks for your interest in Plume! This project is young, so the process is lightweight — but a few rules below are firm.

## Licensing policy (please read first)

Plume is MIT-licensed. To keep it that way:

- **Do not copy or port code from GPL-licensed projects** (or any license
  incompatible with MIT). This includes other text editors. Studying *ideas
  and behaviors* is fine; copying or closely translating *code* is not.
- Only contribute code you wrote or that is available under an
  MIT-compatible license (MIT, Apache-2.0, BSD). Note the source if you
  adapt anything.
- By submitting a contribution you agree it is licensed under the project's
  MIT license.

## Project scope

Read [ROADMAP.md](ROADMAP.md) before proposing features — especially the
**non-goals** section. PRs that expand scope beyond the roadmap (plugin
systems, IDE features, etc.) will be declined regardless of code quality.
Open an issue first if you're unsure.

## Development setup

Prerequisites: Node.js ≥ 20, Rust stable (via [rustup](https://rustup.rs/)),
and the [Tauri prerequisites](https://tauri.app/start/prerequisites/) for
your OS.

```sh
npm install
npm run tauri dev
```

## Before submitting a PR

```sh
# Frontend: must compile cleanly
npm run build

# Rust: format, lint, test
cd src-tauri
cargo fmt --check
cargo clippy -- -D warnings
cargo test
```

- Keep PRs focused — one change per PR.
- Add tests for core logic (anything in `src-tauri/src/` beyond glue code).
  Encoding behavior in particular must be covered by round-trip tests.
- Test on both macOS and Windows if your change touches UI or platform
  integration; say in the PR which platforms you verified.

## Code style

- **Rust:** `rustfmt` defaults, `clippy` clean. Prefer explicit error
  messages that include the file path or encoding label involved.
- **TypeScript:** strict mode is on; keep it passing. No frameworks — the
  frontend is deliberately plain TypeScript + CodeMirror.

## Language

Issues, PRs, and code comments are in **English** so the widest audience can
participate. Bug reports about CJK/encoding behavior are welcome in any
language if writing in English is a barrier — include a sample file when
possible.
