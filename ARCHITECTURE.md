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

## Large files

Phase 1 (implemented): files over 10 MB open as a read-only preview of the
first 2 MB, cut at a line boundary; saving is disabled because writing the
slice back would destroy the file. Phase 2 (future) is Rust-side chunked
scrolling through the whole file — still not a custom editor engine.

## Repository layout

```
├── index.html               # Single-page UI shell
├── src/                     # Frontend (TypeScript, no framework)
│   ├── main.ts              # Wiring: tabs, flows, menu events, startup
│   ├── editor.ts            # The only module that imports CodeMirror
│   ├── ipc.ts               # Typed wrappers for Rust commands
│   ├── tabs.ts              # TabStore + tab bar rendering (tabs.test.ts)
│   ├── statusbar.ts         # Path / encoding / line ending / cursor
│   ├── encodings.ts         # Curated encoding choices for pickers
│   ├── preferences.ts       # Prefs state + settings dialog
│   ├── popup.ts             # Anchored popup menu (status bar pickers)
│   ├── quickopen.ts         # Recent-files quick open (Mod+P)
│   ├── findinfiles.ts       # Find-in-files panel (Mod+Shift+F)
│   ├── goto.ts              # Go-to-line prompt (Mod+L)
│   └── styles.css
├── src-tauri/               # Rust core + Tauri shell
│   ├── src/lib.rs           # Commands (open/save), pending files, run loop
│   ├── src/encoding.rs      # Detection / decode / encode / line endings
│   ├── src/search.rs        # Encoding-aware find-in-files backend
│   ├── src/watcher.rs       # notify-based watching for auto-reload
│   ├── src/session.rs       # Open-files session persistence
│   ├── src/prefs.rs         # User preferences persistence
│   ├── src/recent.rs        # Recent-files list persistence
│   ├── src/store.rs         # Shared JSON config-dir read/write
│   ├── src/menu.rs          # Native menu (platform-specific layout)
│   ├── tauri.conf.json      # Window, bundle, file associations
│   └── capabilities/        # IPC permission scopes
├── ROADMAP.md
└── ARCHITECTURE.md          # This file
```
