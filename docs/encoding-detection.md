# Encoding detection

How Mojidori decides a file's encoding on open, and — the part that most often
surprises users — which of the 27 encodings in the picker
(`src/encodings.ts`) that decision can actually *land on by itself*, versus
which ones only ever come from a BOM, a per-extension default, or a manual
"Reopen with Encoding".

> Maintenance note: this document is a living reference, like
> [dev-setup.md](dev-setup.md). If `MANUAL_ONLY_ENCODINGS` in
> `src/encodings.ts` changes (a chardetng upgrade, a picker addition), or
> the decision order in `src-tauri/src/encoding.rs::detect_with_extension`
> changes, update this file in the same PR.

## The decision order

The authoritative description of the decision order lives in the doc
comment on `detect_with_extension` in `src-tauri/src/encoding.rs` — this
file does not restate its six numbered rules, to avoid the two drifting
apart. In short, three layers run in sequence, each only consulted if the
one before it didn't resolve the encoding:

1. **BOM sniffing** (`Encoding::for_bom`) — unconditional ground truth when
   present. Covers UTF-8, UTF-16LE, UTF-16BE.
2. **Statistical detection** (chardetng, `EncodingDetector::guess`) — runs
   over a sample of the file's bytes and is the layer this document is
   mostly about. What counts as "the sample" depends on the caller: the
   real open path (`open_document` in `src-tauri/src/lib.rs`) reads the
   whole file for anything under the 10 MiB large-file threshold, or a
   bounded ~2 MiB preview window (`PREVIEW_BYTES`) for anything over it;
   the "Why {encoding}?" diagnostics popup below instead always re-reads a
   fixed 64 KiB prefix (`EXPLAIN_SAMPLE_BYTES`) regardless of file size, so
   its "Sampled" row can under-represent what the original open actually
   saw for a file between 64 KiB and the large-file threshold — it is
   still evidence about the same bytes, just a smaller slice of them.

   **Truncated-sample caveat (issue #201)**: for a file large enough to
   take the bounded preview path, chardetng's read of that window can
   occasionally land on the wrong encoding *family*, not just be less
   confident about the right one. Concretely: a single very long line with
   no newline anywhere in the window can end mid-character at the
   window's tail, skewing chardetng's statistics toward a single-byte
   encoding — and single-byte decoding never reports `malformed`, so
   nothing else catches it. The diagnostics popup surfaces a caveat for
   this (`DetectionExplanation.largeFilePreview` in `src-tauri/src/lib.rs`,
   `detectcard.ts`'s `truncatedSampleNote`) whenever the file exceeds the
   large-file threshold and the verdict didn't come from a BOM (a BOM is
   read from the first few bytes regardless of file size, so truncation
   never affects it). This is disclosure only — it does not change what
   the detector actually decides, and it fires for *any* file that took
   the truncated preview path, not only the narrow single-line case that
   actually misfires: distinguishing "truncated" from "truncated *and*
   about to misfire" would mean re-implementing a chardetng-specific
   heuristic, which is out of scope for a warning label.
3. **Per-extension default** — a user-configured "always open `.txt` as
   Big5" preference (Preferences → encoding defaults), consulted only when
   the sample isn't confident UTF-8 and decodes cleanly under the
   preference.

If none of those apply (or the input is empty with no preference), the
encoding falls back to UTF-8.

The status bar's "Why {encoding}?" popup (`src/detectcard.ts`, backed by
the `explain_detection` command) shows exactly which of these layers fired
for the currently-open document, live-rereading the file to report what
auto-detection would choose *right now* alongside what's actually in use.

## Detection boundaries: what chardetng can and can't guess

`chardetng` (pinned at 0.1.17 in `Cargo.lock`) is not a general-purpose
detector for every encoding `encoding_rs` can decode — it's Mozilla's
purpose-built detector for the specific set of legacy encodings a browser
needs to guess when a page has no charset declared. Its own README documents
a fixed target set, under "Notes About Encodings":
<https://github.com/hsivonen/chardetng/blob/master/README.md>

Cross-referencing that list against Mojidori's 27-entry catalog (verified
directly against the README text, not assumed from an encoding's age or
byte width — see `MANUAL_ONLY_ENCODINGS`'s doc comment in
`src/encodings.ts` for the same citation in code):

**Detected** — chardetng's `guess()` can select these on its own from
content alone, among the 27 Mojidori actually offers: UTF-8 (only because
Mojidori passes `allow_utf8: true`), GBK, Big5, EUC-KR, Shift_JIS, EUC-JP,
windows-1250 through windows-1258, windows-874, ISO-8859-2, ISO-8859-5,
ISO-8859-7, KOI8-U. (chardetng's target set is actually a little larger
than this — it also covers ISO-2022-JP and ISO-8859-4/6/8/13, but Mojidori's
picker excludes all of those outright for reasons unrelated to detection:
ISO-2022-JP for the stateful-encoding fast-path hazard documented in
`encodings.ts`, and ISO-8859-4/6/8/13 simply were never added to the
picker's 27-entry catalog.)

**Manual-only** (`isManualOnlyEncoding` / `MANUAL_ONLY_ENCODINGS` in
`src/encodings.ts`) — chardetng's `guess()` can **never** return these
literal values, for two distinct reasons documented in the README:

- **Never detected at all**: `ISO-8859-15` and `macintosh`. Per the
  README, these "have never been a locale-specific fallback in a major
  browser or a menu item in IE" — chardetng doesn't attempt them.
- **Detected, but always mislabeled as a different catalog entry**:
  `gb18030` ("Detected as GBK" — genuine gb18030 content is recognized as
  belonging to that statistical family, but the guess always comes back as
  the distinct `GBK` encoding, never `gb18030` itself) and `KOI8-R`
  ("Detected as KOI8-U... Always guessing the U variant is less likely to
  corrupt non-box drawing characters" — same mechanism, always reported as
  `KOI8-U`).

For all four, opening a file and landing on that *exact* label always goes
through the BOM layer (not applicable to any of these four — none has a
BOM), a per-extension default, or an explicit "Reopen with Encoding" — never
a bare content scan. The detection-diagnostics popup shows an explicit note
to that effect whenever the document's current encoding is one of these
four, regardless of whether this run's evidence happens to agree with it.

**Detected, but with a documented accuracy caveat** — these are genuine
chardetng targets (so they are *not* in `MANUAL_ONLY_ENCODINGS`, and the
diagnostics popup does not add a boundary note for them), but the same
README flags them as unreliable in common cases:

- `windows-1257`: "very inaccurate" in general — the README notes the
  detector doesn't use trigrams, which `ced` relies on to disambiguate it.
- `windows-874` (Thai): "inaccurate for short inputs".
- `GBK`: "less accurate than in ced for short titles consisting of fewer
  than six hanzi".

A user who reopens with one of these three because auto-detect guessed
wrong on a short file is not hitting a bug — it's this same, documented
limitation, just a matter of degree rather than an absolute gap.

**Outside chardetng's target set, but still auto-detected anyway**:
UTF-16LE/UTF-16BE. The README explicitly excludes them ("Detecting these
belongs on the BOM layer"), but Mojidori's own BOM-sniffing layer (ahead of
chardetng in the decision order above) detects them whenever a BOM is
present — the overwhelming common case for real UTF-16 files — so they are
deliberately *not* in `MANUAL_ONLY_ENCODINGS`. Only a BOM-less UTF-16 file
falls back to needing a per-extension default or a manual reopen, same as
any other undetectable case.

## Relationship to the mojibake repair wizard

The "Detected" list above is also the load-bearing fact behind
`src-tauri/src/mojibake.rs`'s `REPAIR_PAIRS`: every mojibake-repair
hypothesis `(intermediate, original)` in that table requires chardetng to
be able to positively confirm `original` on the recovered bytes (that
module's `try_repair`, gate (c)). An encoding this document lists as
never-detected-at-all or always-mislabeled-as-something-else (the four
"Manual-only" entries just above, principally `KOI8-R`, which chardetng
always reports as `KOI8-U`) can therefore never appear as `original` in
`REPAIR_PAIRS` — not a low-probability case, a structural impossibility,
regardless of the input. For the ROADMAP v0.7 Track E batch, the
encoding this constraint actually bites on is each pair's `original` —
`UTF-8` for four of the five pairs and `windows-1251` for the fifth —
both solidly in the "Detected" set, confirmed directly against chardetng
0.1.17's `src/data.rs`/`src/lib.rs` (not just this document). The other
batch encodings (`EUC-KR`, `EUC-JP`, `windows-1250`, `KOI8-U`) appear
only as `intermediate`, where gate (c) does not apply (an intermediate
only needs to be *encodable*, gate (a)); that they also happen to be
detectable is incidental. See `REPAIR_PAIRS`'s own doc comment for the
full per-pair writeup.

## Practical guidance

If a file is known (or suspected) to be one of the four manual-only
encodings — or one of the three low-accuracy ones, if it's short — the
reliable paths are, in order of convenience:

1. Set a per-extension default (Preferences) if every file of that
   extension uses the same legacy encoding — the common case for e.g. a
   folder of `.txt` files exported from an old Windows codepage-874 or
   classic Mac OS tool.
2. Otherwise, "Reopen with Encoding" (status bar → encoding → Reopen) once,
   per file.

Auto-detect guessing "wrong" for one of these seven encodings on a single
open is expected behavior, not a regression — see the previous section for
which of the two reasons (never-detected vs. mislabeled vs. low-accuracy)
applies to which encoding.
