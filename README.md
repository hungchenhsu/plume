# Plume

> **Plume** is a working codename — the final product name is still to be decided.

A fast, lightweight, open-source text editor. Mac-first, cross-platform, encoding-first.

## Why

Opening a text file should be instant. Legacy encodings should just work. And the app should feel native on your platform — not like something ported from somewhere else.

Plume is built around three promises:

- **Instant.** Cold start to editing in well under a second. Opening a text file is faster than launching an IDE.
- **Encoding-first.** Reliable detection and explicit, lossless conversion for UTF-8 (with or without BOM), UTF-16, Big5, Shift_JIS, GB18030 and more. No mojibake, no silent corruption. Line endings (LF/CRLF) are detected, displayed, and convertible.
- **Native feel.** Platform-correct menus, shortcuts, and behaviors on macOS and Windows. Not a lowest-common-denominator UI.

## Who it's for

Anyone who needs a dependable everyday editor for text files, logs, CSV exports, config files, and quick code edits — especially in environments where legacy encodings (Big5, Shift_JIS, GB18030) are still a daily reality.

## Status

🚧 **Early development.** The current build is a minimal skeleton: a single-document editor with encoding-aware open/save. See [ROADMAP.md](ROADMAP.md) for what's planned and what's explicitly out of scope.

## Platform support

| Platform | Tier | Notes |
|---|---|---|
| macOS | 1 | Primary development target |
| Windows | 1 | Full support intended; CI-verified |
| Linux | 2 | Best effort; issues welcome |

## Tech stack

- **Shell:** [Tauri 2](https://tauri.app/) — small binaries, native WebView, no bundled browser engine
- **Core:** Rust — file I/O, encoding detection/conversion ([encoding_rs](https://github.com/hsivonen/encoding_rs) + [chardetng](https://github.com/hsivonen/chardetng)), search backend
- **Editor surface:** [CodeMirror 6](https://codemirror.net/) — kept behind a thin interface so it stays swappable

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full picture.

## Development

Prerequisites: [Node.js](https://nodejs.org/) ≥ 20, [Rust](https://rustup.rs/) (stable), plus the [Tauri prerequisites](https://tauri.app/start/prerequisites/) for your OS.

```sh
npm install
npm run tauri dev    # run the app in development mode
npm run tauri build  # produce a release bundle
```

Rust tests live in `src-tauri`:

```sh
cd src-tauri && cargo test
```

## Contributing

Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). Please read the licensing policy there before submitting code.

## License

[MIT](LICENSE)
