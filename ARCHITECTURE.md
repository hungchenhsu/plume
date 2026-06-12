# Architecture

## Overview

Plume is a Tauri 2 application with a strict split between a Rust core and a web-technology UI running in the platform WebView.

```
┌─────────────────────────────────────────────┐
│  Frontend (TypeScript, platform WebView)    │
│                                             │
│  ┌───────────────────────────────────────┐  │
│  │ Editor surface (CodeMirror 6)         │  │
│  │ — kept behind a thin interface,       │  │
│  │   swappable by design                 │  │
│  └───────────────────────────────────────┘  │
│  UI chrome: status bar, dialogs, tabs       │
└──────────────────┬──────────────────────────┘
                   │ Tauri IPC (commands / events)
┌──────────────────┴──────────────────────────┐
│  Core (Rust, src-tauri)                     │
│                                             │
│  • File I/O — all disk access goes here     │
│  • Encoding: detection (BOM + chardetng),   │
│    decode/encode (encoding_rs)              │
│  • Line-ending detection & conversion       │
│  • Future: search backend, file watcher,    │
│    large-file strategy, session store       │
└─────────────────────────────────────────────┘
```

## Principles

1. **The Rust core owns the bytes; the frontend owns the (in-memory) text.**
   All disk reads and writes go through Rust commands. Raw bytes never cross
   the IPC boundary — the core decodes on open and encodes on save. The
   frontend only ever sees LF-normalized Unicode text plus metadata
   (encoding, BOM, original line ending).

2. **The editor surface is replaceable.**
   CodeMirror 6 is the right tool today (small, modular, excellent IME/CJK
   input behavior). It may not be the right tool at 500 MB files. Editor
   integration stays behind a thin module boundary so a future large-file
   view (or a different surface entirely) can be added without rewriting the
   app. We deliberately do **not** write our own editor engine.

3. **Encoding handling is core logic, not UI logic.**
   Detection, decoding, and conversion live in `src-tauri/src/encoding.rs`
   with unit tests. The UI only displays results and forwards user choices
   (e.g. "reopen as Big5").

4. **Platform-correct, not platform-neutral.**
   Menus, shortcuts, and dialogs follow each platform's conventions
   (Cmd-based on macOS, Ctrl-based on Windows). Tauri's `Mod-` key
   abstraction and native menu APIs are used instead of a custom
   lowest-common-denominator layer.

## Document lifecycle

**Open** (`open_document` command):

1. Rust reads raw bytes from disk.
2. BOM sniffing first; otherwise statistical detection via chardetng.
3. Decode via encoding_rs. Decode errors are *reported*, never hidden — the
   UI shows a warning so the user can reopen with an explicit encoding.
4. Line ending classified (LF / CRLF / Mixed), then content normalized to LF
   for the in-memory document.
5. Frontend receives `{ content, encoding, hadBom, malformed, lineEnding }`.

**Save** (`save_document` command):

1. Frontend sends LF-normalized content plus the target encoding, BOM flag,
   and line ending.
2. Rust re-applies the line ending, encodes (UTF-16 handled manually since
   encoding_rs is encode-to-ASCII-compatible only), and writes to disk.
3. Unmappable characters are reported back so the UI can warn before data
   would be silently lost.

## WebView duality

The frontend runs on **WKWebView** (Safari engine) on macOS and **WebView2**
(Chromium) on Windows. These differ in rendering, fonts, clipboard, and CSS
edge cases. Consequences:

- Both platforms are Tier 1 and must be CI-built and manually exercised.
- Avoid bleeding-edge CSS/JS features unless verified on both engines.
- Linux (WebKitGTK) is Tier 2: kept building, not UX-polished.

## Large files (future)

CodeMirror 6 with viewport virtualization is fine into the tens of MB. The
plan beyond that is a Rust-side strategy (chunked loading, read-only mode
first) — not a custom editor engine. Until that lands, very large files are
explicitly out of scope.

## Repository layout

```
├── index.html            # Single-page UI shell
├── src/                  # Frontend (TypeScript)
│   ├── main.ts           # Editor setup, file commands, status bar
│   └── styles.css
├── src-tauri/            # Rust core + Tauri shell
│   ├── src/lib.rs        # Tauri commands (open/save)
│   ├── src/encoding.rs   # Detection / decode / encode / line endings
│   ├── tauri.conf.json
│   └── capabilities/     # IPC permission scopes
├── ROADMAP.md
└── ARCHITECTURE.md       # This file
```
