# Plume

> **Plume** is a working codename — the final product name is still to be decided.

A fast, lightweight, open-source text editor. Mac-first, cross-platform, encoding-first.

<!-- TODO(owner): screenshots — light/dark, encoding menu, large-file mode -->

## Why

Opening a text file should be instant. Legacy encodings should just work. And the app should feel native on your platform — not like something ported from somewhere else.

Plume is built around three promises:

- **Instant.** Cold start to editing in well under a second. Opening a text file is faster than launching an IDE.
- **Encoding-first.** Reliable detection and explicit, lossless conversion for UTF-8 (with or without BOM), UTF-16, Big5, Shift_JIS, GB18030 and more. No mojibake, no silent corruption. Line endings (LF, CRLF, and mixed) are detected, displayed, and convertible.
- **Native feel.** Platform-correct menus, shortcuts, and behaviors on macOS and Windows. Not a lowest-common-denominator UI.

## Who it's for

Anyone who needs a dependable everyday editor for text files, logs, CSV exports, config files, and quick code edits — especially in environments where legacy encodings (Big5, Shift_JIS, GB18030) are still a daily reality.

## Status

🚧 **Pre-1.0, alpha, actively developed.** Several feature cycles beyond the original MVP have shipped. See [ROADMAP.md](ROADMAP.md) for the full history and explicit non-goals, and [Install](#install) below for build status (unsigned, no auto-update yet).

What's there today:

- Multi-tab editing with session restore (reopened files, cursor position, window size) and hot exit — unsaved buffers, including untitled tabs, are backed up continuously and restored on launch
- Encoding-first core: automatic detection (BOM + statistical) plus explicit reopen/convert across 26 curated encodings (UTF-8, UTF-16, Big5, Shift_JIS, GB18030, the windows-125x/ISO-8859/KOI8 families, and more — [which ones detect automatically](docs/encoding-detection.md)); decode errors are always surfaced, never silently rendered as mojibake
- A mojibake repair wizard, side-by-side encoding preview, and byte-fidelity handling on save — untouched bytes stay untouched, and unavoidable drift is disclosed before it happens rather than left silent
- Batch encoding and line-ending conversion, and find/replace across whole folders (both regex-capable), each with a dry-run preview before anything is written
- Large-file mode: large files open instantly via chunked streaming rather than loading the whole file, with search/replace and go-to-line/bookmarks that work beyond the currently loaded window
- Character-level trust tools: a codepoint/byte inspector, invisible and ambiguous character highlighting, and Unicode normalization (NFC/NFD) that checks representability before it touches a byte
- Everyday editing comfort: multi-cursor, code folding, indent guides and detection, line operations (sort/unique/trim/case/move/duplicate), regex find/replace, and tab drag-to-reorder
- Native platform integration on macOS and Windows (menus, shortcuts, file associations), light/dark/eye-friendly themes, and a UI available in English, Traditional Chinese, Japanese, and Simplified Chinese

For a full walkthrough of every encoding and large-file feature — menu paths, shortcuts, and behavior boundaries — see [docs/features.md](docs/features.md).

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

## Install

Plume ships as pre-release builds on [GitHub Releases](https://github.com/hungchenhsu/plume/releases) — there is no stable 1.0 yet, and things can change between alphas.

Download the build for your platform from the latest release's Assets — macOS: `.dmg` (pick `aarch64` for Apple Silicon or `x64` for Intel); Windows: `.msi` or `.exe`. To build from source instead, see [Development](#development) below.

Builds are not code-signed or notarized, so the OS will warn you the first time you open one:

- **macOS:** a plain double-click is blocked by Gatekeeper. Right-click (or Control-click) the app and choose **Open**, then confirm in the dialog that follows — or, if that option isn't offered, go to **System Settings → Privacy & Security** and click **Open Anyway**. Only needed once per build.
- **Windows:** SmartScreen will show "Windows protected your PC." Click **More info**, then **Run anyway**.

Signing and auto-update are on the roadmap.

## Development

Prerequisites: [Node.js](https://nodejs.org/) ≥ 20, [Rust](https://rustup.rs/) (stable), plus the [Tauri prerequisites](https://tauri.app/start/prerequisites/) for your OS. Full platform-specific setup notes live in [docs/dev-setup.md](docs/dev-setup.md).

```sh
npm install
npm run build          # required once before any cargo command (tauri::generate_context! needs dist/)
npm run tauri dev      # run the app in development mode
npm run tauri build    # produce a release bundle
```

Tests:

```sh
npm test                     # frontend unit tests (vitest)
cd src-tauri && cargo test   # Rust core tests
```

## Contributing

Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). Please read the licensing policy there before submitting code.

## License

[MIT](LICENSE)
