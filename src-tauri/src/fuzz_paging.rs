//! Deterministic-PRNG property fuzz for the large-file chunk-paging
//! subsystem (`chunk.rs`, `lineindex.rs`), the offset-arithmetic danger
//! domain responsible for issues #118 (overlong-line continuation),
//! #119/#132 (line-break semantics agreement between chunk alignment and
//! the line index) and #136 (multibyte trim at a no-break window edge).
//! Hand-picked fixtures catch one bug shape at a time; this file throws
//! random operation sequences at random fixtures instead, the same way
//! `fuzz_roundtrip.rs` (v0.4) fuzzes the encoding round-trip contract:
//! hand-rolled xorshift64 PRNG (no new dependency), CI-scale tests plus
//! `#[ignore]` large-volume variants.
//!
//! ## Chunk-size injection point
//!
//! `chunk::CHUNK_BYTES` is a hard `pub const`, read directly inside
//! `read_document_chunk`/`read_document_chunk_before` (`vec![0u8;
//! CHUNK_BYTES]`) — neither function takes a chunk-size parameter, so
//! there is no injection point, and adding one would be a production-code
//! change outside this task's scope (test-only addition). Fixtures are
//! therefore sized well above `2 * CHUNK_BYTES` (the "big fixture, fewer
//! rounds" strategy, mirroring `streamconvert.rs`'s large fixed-size
//! stress fixtures) rather than many rounds of an injected small chunk
//! size; the random *operation sequences* run per fixture carry the
//! "fewer rounds at CI scale, more in `#[ignore]`" trade-off instead.
//!
//! ## Ground truth
//!
//! `ground_truth_line_starts` is a hand-rolled single-pass byte scanner
//! defined in this file. It deliberately shares no code with
//! `linebreak.rs` (which `align_start`/`cut_tail_at_line_break`/
//! `is_line_start`/`scan_line_breaks` — everything `chunk.rs` and
//! `lineindex.rs` actually delegate to for line-break semantics — are all
//! defined in) so that a latent bug shared across those functions cannot
//! silently cancel out against the property assertions built on top of
//! it. It is cross-checked against `lineindex.rs`'s own hand-picked #119
//! regression fixtures (`ground_truth_matches_known_fixtures` below)
//! before being trusted as this file's oracle.
//!
//! `encoding::normalize_to_lf`/`trim_truncated_utf8_head` (both simple,
//! already independently unit-tested leaf utilities well outside the
//! offset-arithmetic danger domain this file targets — see
//! `.claude/judgment-overlay.md` §1) *are* reused directly as ground
//! truth for content normalization and the UTF-8-boundary nudge amount
//! respectively. This mirrors `fuzz_roundtrip.rs`'s own precedent of
//! reusing adjacent, already-tested helpers (`encoding::encode`/
//! `decode_with`) as oracles while keeping the thing actually under
//! adversarial test untouched.
//!
//! ## What this does not do
//!
//! No malformed/invalid UTF-8 byte sequence is ever generated -- every
//! fixture is built from `char` values pushed into a `String`, so it is
//! valid UTF-8 by construction and every chunk boundary this module's
//! functions hand back is provably decodable. Decode-error surfacing is a
//! separate, already-covered concern (`encoding.rs`'s malformed-data
//! tests); this file's job is offset arithmetic on well-formed content.
//! `read_document_chunk_before` accepting a non-line-aligned `end` is
//! also out of scope: the module doc pins `end` as always line-aligned
//! for every caller the app has, and the one defensive fallback for a
//! hypothetical future caller is already a dedicated regression test
//! (`backward_head_trim_never_consumes_the_entire_window` in `chunk.rs`).
//! The forward analogue *is* in scope (`run_stale_goto_fuzz` below)
//! because `OffsetKind::LineStart` reads from a possibly-stale line index
//! are real, reachable app behavior (goto/bookmarks), not hypothetical.

use crate::chunk::{self, read_document_chunk, read_document_chunk_before, OffsetKind};
use crate::encoding::normalize_to_lf;
use crate::lineindex::{build_line_index, locate_line_offset, CHECKPOINT_INTERVAL};

/// Minimal hand-rolled xorshift64 (Marsaglia 2003, public domain) PRNG --
/// identical to `fuzz_roundtrip.rs`'s. Duplicated rather than shared:
/// neither that copy nor `lineindex.rs`'s own `read_chunk` (which gives
/// the same rationale for its own near-duplicate of `chunk.rs`'s
/// `read_up_to`) is `pub(crate)`, and the duplication is a handful of
/// lines -- this repo's established preference over cross-module
/// coupling for small test-only helpers.
struct XorShift64(u64);

impl XorShift64 {
    fn new(seed: u64) -> Self {
        Self(if seed == 0 {
            0x9E37_79B9_7F4A_7C15
        } else {
            seed
        })
    }

    fn next_u64(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        x
    }

    /// An index in `0..bound`. The small modulo bias this introduces is
    /// irrelevant at test-fuzzing scale (not cryptographic sampling).
    fn next_range(&mut self, bound: usize) -> usize {
        assert!(bound > 0, "next_range bound must be positive");
        (self.next_u64() % bound as u64) as usize
    }

    fn choose<'a, T>(&mut self, items: &'a [T]) -> &'a T {
        &items[self.next_range(items.len())]
    }
}

// --- Fixture dimensions --------------------------------------------------

#[derive(Clone, Copy, Debug)]
enum LineEnding {
    Lf,
    Crlf,
    Cr,
    Mixed,
}

impl LineEnding {
    const ALL: [LineEnding; 4] = [
        LineEnding::Lf,
        LineEnding::Crlf,
        LineEnding::Cr,
        LineEnding::Mixed,
    ];

    fn label(self) -> &'static str {
        match self {
            LineEnding::Lf => "LF",
            LineEnding::Crlf => "CRLF",
            LineEnding::Cr => "CR",
            LineEnding::Mixed => "Mixed",
        }
    }
}

#[derive(Clone, Copy, Debug)]
enum Width {
    Ascii,
    Cjk,
    Astral,
}

impl Width {
    const ALL: [Width; 3] = [Width::Ascii, Width::Cjk, Width::Astral];

    fn label(self) -> &'static str {
        match self {
            Width::Ascii => "ASCII",
            Width::Cjk => "CJK",
            Width::Astral => "Astral",
        }
    }
}

const MIXED_TERMINATORS: [&str; 3] = ["\n", "\r\n", "\r"];

/// The terminator bytes for one line boundary. `Mixed` picks randomly per
/// boundary (LF, CRLF, or lone CR), matching `lineindex.rs`'s own
/// `mixed_line_endings_each_style_counts_once` regression fixture but at
/// fuzz scale instead of one hand-picked line of each.
fn pick_terminator(line_ending: LineEnding, rng: &mut XorShift64) -> &'static str {
    match line_ending {
        LineEnding::Lf => "\n",
        LineEnding::Crlf => "\r\n",
        LineEnding::Cr => "\r",
        LineEnding::Mixed => rng.choose(&MIXED_TERMINATORS),
    }
}

// --- Character pools -------------------------------------------------
//
// Each pool excludes \n/\r (terminators are inserted explicitly between
// lines) and blends in a handful of plain ASCII characters for the
// non-ASCII widths -- a chunk boundary landing between two *different*
// -width characters is more adversarial than a pool of uniform width.

fn ascii_pool() -> Vec<char> {
    (0x20u32..=0x7Eu32).filter_map(char::from_u32).collect()
}

/// CJK Unified Ideographs (3-byte UTF-8) blended with ASCII.
fn cjk_pool() -> Vec<char> {
    let mut v: Vec<char> = (0x4E00u32..0x4F90u32).filter_map(char::from_u32).collect();
    v.extend(ascii_pool().into_iter().take(20));
    v
}

/// Astral-plane (>U+FFFF, 4-byte UTF-8 / UTF-16 surrogate pair) characters
/// blended with ASCII -- new coverage beyond the existing hand-picked
/// regression tests, which only pin the mid-character trim boundary for
/// ASCII (1-byte) and CJK (3-byte) overlong lines.
fn astral_pool() -> Vec<char> {
    let mut v: Vec<char> = [
        0x1_F300u32,
        0x1_F301,
        0x1_F302,
        0x1_F303,
        0x1_F304,
        0x1_F305,
        0x1_F306,
        0x1_F307,
        0x1_F308,
        0x1_F309,
        0x1_F30A,
        0x1_F600,
        0x1_F601,
        0x1_F602,
        0x1_F603,
        0x1_F604,
        0x1_F9E1,
        0x2_0000,
        0x2_0001,
        0x2_F800,
    ]
    .into_iter()
    .filter_map(char::from_u32)
    .collect();
    v.extend(ascii_pool().into_iter().take(20));
    v
}

fn pool_for(width: Width) -> Vec<char> {
    match width {
        Width::Ascii => ascii_pool(),
        Width::Cjk => cjk_pool(),
        Width::Astral => astral_pool(),
    }
}

/// The single character repeated to build a fixture's one overlong line --
/// 1/3/4 UTF-8 bytes for Ascii/Cjk/Astral respectively, so the overlong
/// line's raw-continuation search and mid-character trim (issue #118) are
/// exercised at all three widths.
fn overlong_char(width: Width) -> char {
    match width {
        Width::Ascii => 'x',
        Width::Cjk => '中',
        Width::Astral => '\u{1F600}',
    }
}

// --- Fixture construction -------------------------------------------------

struct PagingFixture {
    line_ending: LineEnding,
    width: Width,
    trailing_newline: bool,
    seed: u64,
    /// Byte offset where the fixture's one overlong line begins --
    /// recorded so `run_stale_goto_fuzz` can deliberately target probes
    /// deep inside it instead of relying on uniform random sampling over
    /// thousands of ordinary line starts to occasionally land there.
    overlong_start: u64,
    raw_bytes: Vec<u8>,
}

impl PagingFixture {
    /// Reproduction summary embedded in every panic message this file
    /// produces -- seed, dimensions, and fixture size are enough to
    /// reconstruct the exact fixture via `build_fixture`.
    fn params_summary(&self) -> String {
        format!(
            "line_ending={} width={} trailing_newline={} seed=0x{:X} size={}B \
             overlong_start={}",
            self.line_ending.label(),
            self.width.label(),
            self.trailing_newline,
            self.seed,
            self.raw_bytes.len(),
            self.overlong_start
        )
    }

    fn temp_path(&self) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "plume-fuzz-paging-{}-{}-tn{}-{:x}.txt",
            self.line_ending.label(),
            self.width.label(),
            self.trailing_newline as u8,
            self.seed
        ))
    }
}

/// Random short lines (5..65 characters) drawn from `pool`, generated
/// until their combined byte length reaches `target_bytes`.
fn generate_body_lines(rng: &mut XorShift64, pool: &[char], target_bytes: usize) -> Vec<String> {
    let mut lines = Vec::new();
    let mut total = 0usize;
    while total < target_bytes {
        let len = rng.next_range(60) + 5;
        let line: String = (0..len).map(|_| *rng.choose(pool)).collect();
        total += line.len();
        lines.push(line);
    }
    lines
}

/// Build one fixture: `body_bytes_each_side` bytes of random short lines,
/// then one overlong line (a single-character repeat of at least
/// `3 * CHUNK_BYTES`, deliberately not a multiple of the character's byte
/// width so the mid-character trim boundary is exercised the same way
/// `chunk.rs`'s own `overlong_multibyte_line_fixture` pins it for CJK),
/// then `body_bytes_each_side` more bytes of random short lines --
/// mirroring `chunk.rs`'s `overlong_line_fixture` shape (many short lines
/// around one giant line) but with randomized, irregular-width content
/// instead of a fixed formulaic string.
///
/// The overlong line is sized to `3 * CHUNK_BYTES` rather than just over
/// `1 * CHUNK_BYTES` so that *every* point in `[overlong_start,
/// overlong_start + CHUNK_BYTES]` has a full `CHUNK_BYTES`-sized read
/// window that stays entirely inside the line -- `run_stale_goto_fuzz`
/// depends on this to reliably exercise its "no terminator anywhere in
/// the window" raw-fallback branch instead of leaving it to chance (a
/// fixture this size has only one overlong line among thousands of
/// ordinary line starts, so uniform random sampling of `line_starts`
/// alone would essentially never land deep enough inside it).
fn build_fixture(
    line_ending: LineEnding,
    width: Width,
    trailing_newline: bool,
    seed: u64,
    body_bytes_each_side: usize,
) -> PagingFixture {
    let mut rng = XorShift64::new(seed);
    let pool = pool_for(width);

    let lines_before = generate_body_lines(&mut rng, &pool, body_bytes_each_side);
    let lines_after = generate_body_lines(&mut rng, &pool, body_bytes_each_side);

    let ch = overlong_char(width);
    let repeats = 3 * (chunk::CHUNK_BYTES / ch.len_utf8()) + 1000 + rng.next_range(500);
    let overlong_line = ch.to_string().repeat(repeats);

    let mut body = String::with_capacity(body_bytes_each_side * 2 + 3 * chunk::CHUNK_BYTES + 4096);
    for line in &lines_before {
        body.push_str(line);
        body.push_str(pick_terminator(line_ending, &mut rng));
    }
    // Recorded before the overlong line itself is appended: this is
    // exactly the byte offset it starts at.
    let overlong_start = body.len() as u64;
    body.push_str(&overlong_line);
    body.push_str(pick_terminator(line_ending, &mut rng));
    let last = lines_after.len() - 1;
    for (i, line) in lines_after.iter().enumerate() {
        body.push_str(line);
        if i != last {
            body.push_str(pick_terminator(line_ending, &mut rng));
        }
    }
    if trailing_newline {
        body.push_str(pick_terminator(line_ending, &mut rng));
    }

    PagingFixture {
        line_ending,
        width,
        trailing_newline,
        seed,
        overlong_start,
        raw_bytes: body.into_bytes(),
    }
}

// --- Ground truth ----------------------------------------------------

/// Independent ground-truth line table: the byte offset of every line's
/// first byte, computed by a single linear scan that shares no code with
/// `linebreak.rs` -- see this file's module doc. Semantics match
/// `linebreak.rs`'s documented three-way split exactly: LF always ends a
/// line, CRLF ends it as one pair (never double-counted), a lone CR ends
/// it too. `starts[0] == 0` for any non-empty buffer; a line that ends
/// exactly at EOF (on a terminator) gets no phantom trailing entry.
fn ground_truth_line_starts(bytes: &[u8]) -> Vec<u64> {
    if bytes.is_empty() {
        return Vec::new();
    }
    let mut starts = vec![0u64];
    let mut i = 0usize;
    while i < bytes.len() {
        match bytes[i] {
            b'\r' if bytes.get(i + 1) == Some(&b'\n') => i += 2,
            b'\r' | b'\n' => i += 1,
            _ => {
                i += 1;
                continue;
            }
        }
        if i < bytes.len() {
            starts.push(i as u64);
        }
    }
    starts
}

/// Whether byte index `idx` of `bytes` (assumed valid UTF-8) is a
/// character boundary -- `idx == bytes.len()` (EOF) or the byte there is
/// not a UTF-8 continuation byte (0x80..0xC0).
fn is_utf8_char_boundary(bytes: &[u8], idx: u64) -> bool {
    let idx = idx as usize;
    idx == bytes.len() || !(0x80..0xC0).contains(&bytes[idx])
}

// --- Shared fixture context -----------------------------------------------

struct FixtureCtx<'a> {
    path: String,
    raw: &'a [u8],
    line_starts: &'a [u64],
    checkpoints: &'a [u64],
    fixture: &'a PagingFixture,
}

/// Property 2 ("boundary correctness"): `offset` is either a genuine line
/// start (per `line_starts`), the file's own end, or satisfies chunk.rs's
/// documented exception -- it falls strictly inside a single line whose
/// span exceeds `CHUNK_BYTES` (issue #118: a line longer than one chunk
/// has no terminator to align to at all, so the chunk reading through it
/// can only continue raw from wherever the previous read's byte count
/// left off).
fn assert_line_aligned_or_overlong_exception(
    offset: u64,
    line_starts: &[u64],
    raw_len: u64,
    msg: &str,
) {
    if offset == raw_len || line_starts.binary_search(&offset).is_ok() {
        return;
    }
    let containing_start = match line_starts.iter().rposition(|&s| s < offset) {
        Some(idx) => line_starts[idx],
        None => panic!(
            "{msg}: offset {offset} precedes every ground-truth line start -- not a valid \
             chunk boundary"
        ),
    };
    let line_end = line_starts
        .iter()
        .find(|&&s| s > containing_start)
        .copied()
        .unwrap_or(raw_len);
    let line_span = line_end - containing_start;
    assert!(
        line_span > chunk::CHUNK_BYTES as u64,
        "{msg}: offset {offset} is not a real line start, and its containing line \
         (start={containing_start}, end={line_end}, span={line_span}B) does not exceed \
         CHUNK_BYTES ({}B) -- undocumented misalignment",
        chunk::CHUNK_BYTES
    );
}

// --- Property 1 + 2: full forward / backward audits -----------------------

/// Walk the forward `Continuation` chain from offset 0 to EOF. Asserts
/// losslessness (issue #118 family: the concatenated chain must equal the
/// whole file, LF-normalized) and, at every page, that the chunk's own
/// offset is either a real line start or the documented overlong-line
/// exception.
fn audit_forward(ctx: &FixtureCtx) {
    let total_size = ctx.raw.len() as u64;
    let mut assembled = String::new();
    let mut offset = Some(0u64);
    let mut pages = 0usize;
    while let Some(at) = offset {
        let msg = format!(
            "{} forward page {pages} at offset {at}",
            ctx.fixture.params_summary()
        );
        let page = read_document_chunk(
            ctx.path.clone(),
            at,
            "UTF-8".into(),
            OffsetKind::Continuation,
        )
        .unwrap_or_else(|e| panic!("{msg}: read_document_chunk failed: {e}"));
        assert!(
            !page.malformed,
            "{msg}: chunk reported malformed on a well-formed UTF-8 fixture"
        );
        assert_eq!(
            page.offset, at,
            "{msg}: a Continuation read must never realign its own offset (#118)"
        );
        assert_line_aligned_or_overlong_exception(page.offset, ctx.line_starts, total_size, &msg);
        if let Some(next) = page.next_offset {
            assert!(next > page.offset, "{msg}: forward paging made no progress");
        }
        assembled.push_str(&page.content);
        offset = page.next_offset;
        pages += 1;
        assert!(
            pages < 10_000,
            "{msg}: forward paging did not terminate within 10,000 pages"
        );
    }
    assert!(
        pages >= 3,
        "{}: fixture too small to exercise multiple forward chunk transitions ({pages} page(s))",
        ctx.fixture.params_summary()
    );
    let expected = normalize_to_lf(std::str::from_utf8(ctx.raw).unwrap());
    assert_eq!(
        assembled,
        expected,
        "{}: forward continuation chain lost or duplicated bytes (#118 family)",
        ctx.fixture.params_summary()
    );
}

/// Backward analogue of `audit_forward`, walking `read_document_chunk_before`
/// from EOF to offset 0.
fn audit_backward(ctx: &FixtureCtx) {
    let total_size = ctx.raw.len() as u64;
    let mut parts: Vec<String> = Vec::new();
    let mut end = total_size;
    let mut pages = 0usize;
    loop {
        let msg = format!(
            "{} backward page {pages} ending at {end}",
            ctx.fixture.params_summary()
        );
        let page = read_document_chunk_before(ctx.path.clone(), end, "UTF-8".into())
            .unwrap_or_else(|e| panic!("{msg}: read_document_chunk_before failed: {e}"));
        assert!(
            !page.malformed,
            "{msg}: chunk reported malformed on a well-formed UTF-8 fixture"
        );
        assert_eq!(
            page.next_offset,
            Some(end),
            "{msg}: next_offset must echo end"
        );
        assert!(page.offset < end, "{msg}: backward paging made no progress");
        assert_line_aligned_or_overlong_exception(page.offset, ctx.line_starts, total_size, &msg);
        parts.push(page.content.clone());
        end = page.offset;
        pages += 1;
        assert!(
            pages < 10_000,
            "{msg}: backward paging did not terminate within 10,000 pages"
        );
        if end == 0 {
            break;
        }
    }
    assert!(
        pages >= 3,
        "{}: fixture too small to exercise multiple backward chunk transitions ({pages} page(s))",
        ctx.fixture.params_summary()
    );
    parts.reverse();
    let assembled = parts.concat();
    let expected = normalize_to_lf(std::str::from_utf8(ctx.raw).unwrap());
    assert_eq!(
        assembled,
        expected,
        "{}: backward paging chain lost or duplicated bytes (#118 family)",
        ctx.fixture.params_summary()
    );
}

// --- Property 3 + 4: randomized goto/Next/Prev session, determinism-checked ---

/// One operation's outcome, recorded so two runs of the same seed can be
/// compared byte-for-byte (property 4).
#[derive(Debug, PartialEq, Eq)]
enum OpResult {
    Goto {
        target_line: u64,
        resolved_offset: u64,
        next_offset: Option<u64>,
    },
    Next {
        from: u64,
        next_offset: Option<u64>,
        content_len: usize,
    },
    Prev {
        end: u64,
        start: u64,
        content_len: usize,
    },
    NextSkippedAtEof,
    PrevSkippedAtStart,
}

/// Simulate a paging session: a random mix of "goto a random line"
/// (property 3, #119/#132 family), "auto-append" (Next, extending the
/// window's forward edge) and "auto-prepend" (Prev, extending its
/// backward edge) -- the continuation-chain pattern the frontend actually
/// drives while scrolling a large-file window. A `Goto` replaces the
/// current window (a fresh jump discards the old scroll position); `Next`
/// /`Prev` extend it. Every step's content is independently checked
/// against a ground-truth byte slice of `ctx.raw`, normalized the same
/// way `chunk.rs`'s own pipeline does.
fn run_random_session(ctx: &FixtureCtx, rng: &mut XorShift64, num_ops: usize) -> Vec<OpResult> {
    let total_size = ctx.raw.len() as u64;
    let mut trace = Vec::with_capacity(num_ops);
    let mut window: Option<(u64, u64)> = None;

    for step in 0..num_ops {
        let msg = format!(
            "{} random session step {step}",
            ctx.fixture.params_summary()
        );
        match rng.next_range(3) {
            0 => {
                // Goto a random line via the line index, mirroring how the
                // frontend picks a checkpoint at or before the target.
                let target_line = rng.next_range(ctx.line_starts.len()) as u64;
                let checkpoint_idx =
                    ((target_line / CHECKPOINT_INTERVAL) as usize).min(ctx.checkpoints.len() - 1);
                let from_line = checkpoint_idx as u64 * CHECKPOINT_INTERVAL;
                let from_offset = ctx.checkpoints[checkpoint_idx];
                let resolved =
                    locate_line_offset(ctx.path.clone(), target_line, from_offset, from_line)
                        .unwrap_or_else(|e| panic!("{msg}: locate_line_offset failed: {e}"));
                let expected = ctx.line_starts[target_line as usize];
                assert_eq!(
                    resolved, expected,
                    "{msg}: locate_line_offset(target_line={target_line}) = {resolved}, ground \
                     truth line start = {expected} (#119 family)"
                );
                let page = read_document_chunk(
                    ctx.path.clone(),
                    resolved,
                    "UTF-8".into(),
                    OffsetKind::LineStart,
                )
                .unwrap_or_else(|e| panic!("{msg}: read_document_chunk(goto) failed: {e}"));
                assert!(!page.malformed, "{msg}: goto chunk reported malformed");
                assert_eq!(
                    page.offset, resolved,
                    "{msg}: a locate()-produced line start must not be shifted by chunk \
                     alignment (#132 family)"
                );
                let next_end = page.next_offset.unwrap_or(total_size);
                assert_line_aligned_or_overlong_exception(
                    next_end,
                    ctx.line_starts,
                    total_size,
                    &msg,
                );
                let expected_content = normalize_to_lf(
                    std::str::from_utf8(&ctx.raw[resolved as usize..next_end as usize]).unwrap(),
                );
                assert_eq!(
                    page.content, expected_content,
                    "{msg}: goto chunk content did not match the ground-truth slice \
                     [{resolved}, {next_end})"
                );
                window = Some((page.offset, next_end));
                trace.push(OpResult::Goto {
                    target_line,
                    resolved_offset: resolved,
                    next_offset: page.next_offset,
                });
            }
            1 => {
                // Next: extend forward from the window's current end (or
                // bootstrap from 0 if nothing is loaded yet).
                let from = window.map_or(0, |(_, e)| e);
                if from >= total_size {
                    trace.push(OpResult::NextSkippedAtEof);
                    continue;
                }
                let page = read_document_chunk(
                    ctx.path.clone(),
                    from,
                    "UTF-8".into(),
                    OffsetKind::Continuation,
                )
                .unwrap_or_else(|e| panic!("{msg}: read_document_chunk(next) failed: {e}"));
                assert!(!page.malformed, "{msg}: next chunk reported malformed");
                assert_eq!(
                    page.offset, from,
                    "{msg}: Continuation read realigned unexpectedly"
                );
                let next_end = page.next_offset.unwrap_or(total_size);
                assert_line_aligned_or_overlong_exception(
                    next_end,
                    ctx.line_starts,
                    total_size,
                    &msg,
                );
                let expected_content = normalize_to_lf(
                    std::str::from_utf8(&ctx.raw[from as usize..next_end as usize]).unwrap(),
                );
                assert_eq!(
                    page.content, expected_content,
                    "{msg}: next chunk content did not match the ground-truth slice \
                     [{from}, {next_end})"
                );
                let start = window.map_or(from, |(s, _)| s);
                window = Some((start, next_end));
                trace.push(OpResult::Next {
                    from,
                    next_offset: page.next_offset,
                    content_len: page.content.len(),
                });
            }
            _ => {
                // Prev: extend backward from the window's current start
                // (or bootstrap from EOF if nothing is loaded yet).
                let end = window.map_or(total_size, |(s, _)| s);
                if end == 0 {
                    trace.push(OpResult::PrevSkippedAtStart);
                    continue;
                }
                let page = read_document_chunk_before(ctx.path.clone(), end, "UTF-8".into())
                    .unwrap_or_else(|e| {
                        panic!("{msg}: read_document_chunk_before(prev) failed: {e}")
                    });
                assert!(!page.malformed, "{msg}: prev chunk reported malformed");
                assert_eq!(
                    page.next_offset,
                    Some(end),
                    "{msg}: prev next_offset must echo end"
                );
                assert!(page.offset < end, "{msg}: backward read made no progress");
                assert_line_aligned_or_overlong_exception(
                    page.offset,
                    ctx.line_starts,
                    total_size,
                    &msg,
                );
                let expected_content = normalize_to_lf(
                    std::str::from_utf8(&ctx.raw[page.offset as usize..end as usize]).unwrap(),
                );
                assert_eq!(
                    page.content, expected_content,
                    "{msg}: prev chunk content did not match the ground-truth slice \
                     [{}, {end})",
                    page.offset
                );
                let stop = window.map_or(end, |(_, e)| e);
                window = Some((page.offset, stop));
                trace.push(OpResult::Prev {
                    end,
                    start: page.offset,
                    content_len: page.content.len(),
                });
            }
        }
    }
    trace
}

// --- Extra: stale/perturbed LineStart fallback fuzz (#118 follow-up family) ---

#[derive(Debug, PartialEq, Eq)]
struct StaleProbeResult {
    probe: u64,
    chunk_offset: u64,
    next_offset: Option<u64>,
}

/// Generalizes `chunk.rs`'s hand-picked `goto_read_realigns_a_stale_*` /
/// `goto_read_falls_back_to_raw_inside_an_overlong_line` regression tests:
/// a *stale* line-index offset (one the caller claims is a line start but
/// might not be, e.g. because a watcher event was missed) can land
/// anywhere. Perturb a real line start forward by a random amount and feed
/// the result straight to `read_document_chunk` as `OffsetKind::LineStart`
/// (bypassing `locate_line_offset` entirely, unlike `run_random_session`'s
/// `Goto`). The realignment must either land on the nearest real line
/// start `align_start` can prove within the single-buffer read window
/// (a complete terminator -- see the `nearest` oracle below for the two
/// window-edge cases this excludes), or -- when none exists -- fall back
/// to a raw read nudged at most 3 bytes forward onto a UTF-8 character
/// boundary (`trim_truncated_utf8_head`'s documented bound), never
/// splitting a character and never skipping a real line start. In every
/// path the returned content must equal the ground-truth bytes of the
/// window the chunk reports covering.
fn run_stale_goto_fuzz(
    ctx: &FixtureCtx,
    rng: &mut XorShift64,
    num_probes: usize,
) -> Vec<StaleProbeResult> {
    let total_size = ctx.raw.len() as u64;
    let max_perturb = chunk::CHUNK_BYTES as u64;
    let mut results = Vec::with_capacity(num_probes);
    // The first few probes are deliberately based at the fixture's one
    // overlong line (`overlong_start`) rather than a uniformly random
    // `line_starts` entry -- see `build_fixture`'s doc for why random
    // sampling alone essentially never lands deep enough inside it. This
    // makes the "no terminator anywhere in the window" branch below run
    // reliably on every fixture instead of only probabilistically
    // (confirmed empirically: it fired 0 times across 144 CI-scale probes
    // before this dedicated-probe change was added).
    let dedicated_deep_probes = num_probes.min(3);

    for step in 0..num_probes {
        let base = if step < dedicated_deep_probes {
            ctx.fixture.overlong_start
        } else {
            *rng.choose(ctx.line_starts)
        };
        let perturb = 1 + (rng.next_u64() % max_perturb);
        let probe = (base + perturb).min(total_size);
        let msg = format!(
            "{} stale-goto probe {step} base={base} perturb={perturb} probe={probe}",
            ctx.fixture.params_summary()
        );

        let page = read_document_chunk(
            ctx.path.clone(),
            probe,
            "UTF-8".into(),
            OffsetKind::LineStart,
        )
        .unwrap_or_else(|e| panic!("{msg}: read_document_chunk(stale) failed: {e}"));
        assert!(
            !page.malformed,
            "{msg}: stale-goto chunk reported malformed"
        );
        assert!(
            page.offset >= probe,
            "{msg}: LineStart realignment moved backward of the probed offset \
             (page.offset={})",
            page.offset
        );
        let window_end = (probe + chunk::CHUNK_BYTES as u64).min(total_size);
        assert!(
            page.offset <= window_end,
            "{msg}: LineStart realignment moved past the single-buffer read window \
             (page.offset={}, window_end={window_end})",
            page.offset
        );

        if ctx.line_starts.binary_search(&probe).is_ok() {
            assert_eq!(
                page.offset, probe,
                "{msg}: probe is already a genuine line start and must not be realigned"
            );
        } else {
            // A candidate must be a line start `align_start` can actually
            // *prove* within the read window (linebreak.rs's complete
            // -terminator rule): a lone-CR-derived line start exactly at
            // `window_end` is excluded, because its CR is the buffer's
            // last byte -- align_start cannot rule out a split CRLF there
            // and defers, so prod raw-falls-back. EOF counts as a target
            // only when the file's last byte is `\n` (a complete LF/CRLF
            // terminator align_start skips past to land on buf.len()); a
            // trailing lone CR at EOF or an unterminated final line
            // raw-falls-back too, and must not be modeled as a realign
            // to `total_size`.
            let nearest = ctx
                .line_starts
                .iter()
                .copied()
                .filter(|&s| {
                    s > probe
                        && s <= window_end
                        && !(s == window_end && ctx.raw[s as usize - 1] == b'\r')
                })
                .chain(
                    (window_end == total_size && ctx.raw.last() == Some(&b'\n'))
                        .then_some(total_size),
                )
                .min();
            match nearest {
                Some(n) => assert_eq!(
                    page.offset, n,
                    "{msg}: a real line start ({n}) exists within the read window but \
                     realignment landed elsewhere"
                ),
                None => {
                    assert!(
                        is_utf8_char_boundary(ctx.raw, page.offset),
                        "{msg}: raw fallback landed mid-character at offset {}",
                        page.offset
                    );
                    assert!(
                        page.offset - probe <= 3,
                        "{msg}: raw fallback nudged forward by {} bytes, expected at most 3 \
                         (trim_truncated_utf8_head's documented bound)",
                        page.offset - probe
                    );
                    assert!(
                        !page.content.is_empty() || page.offset == total_size,
                        "{msg}: raw fallback produced an empty, non-progressing chunk"
                    );
                }
            }
        }
        // Content equivalence for every path above (genuine hit, realign,
        // raw fallback): whatever offset the read settled on, the decoded
        // content must equal the ground-truth byte slice it claims to
        // cover -- offset assertions alone cannot catch a read that
        // reports the right window but returns subtly wrong bytes.
        let next_end = page.next_offset.unwrap_or(total_size);
        let expected_content = normalize_to_lf(
            std::str::from_utf8(&ctx.raw[page.offset as usize..next_end as usize]).unwrap(),
        );
        assert_eq!(
            page.content, expected_content,
            "{msg}: stale-goto chunk content did not match the ground-truth slice \
             [{}, {next_end})",
            page.offset
        );
        results.push(StaleProbeResult {
            probe,
            chunk_offset: page.offset,
            next_offset: page.next_offset,
        });
    }
    results
}

// --- Orchestration ---------------------------------------------------

/// Build one fixture and run every property against it: #119-family
/// cross-checks on `build_line_index`'s own report, the full forward/
/// backward audits (properties 1+2), the randomized goto/Next/Prev
/// session run twice for determinism (properties 3+4), and the stale
/// -goto fallback fuzz (also determinism-checked). Shared by both the
/// CI-scale tests and the `#[ignore]` large-volume variant below.
fn run_paging_property_fuzz(
    line_ending: LineEnding,
    width: Width,
    trailing_newline: bool,
    seed: u64,
    body_bytes_each_side: usize,
    ops_per_session: usize,
    stale_probes: usize,
) {
    let fixture = build_fixture(
        line_ending,
        width,
        trailing_newline,
        seed,
        body_bytes_each_side,
    );
    assert!(
        fixture.raw_bytes.len() as u64 > 2 * chunk::CHUNK_BYTES as u64,
        "{}: fixture must exceed 2x CHUNK_BYTES to exercise multiple chunk transitions on \
         both sides of the overlong line",
        fixture.params_summary()
    );
    std::str::from_utf8(&fixture.raw_bytes).unwrap_or_else(|e| {
        panic!(
            "{}: fixture is not valid UTF-8 (harness bug): {e}",
            fixture.params_summary()
        )
    });
    let line_starts = ground_truth_line_starts(&fixture.raw_bytes);

    let path = fixture.temp_path();
    std::fs::write(&path, &fixture.raw_bytes).unwrap();
    let path_str = path.to_string_lossy().into_owned();

    let report = build_line_index(path_str.clone(), "UTF-8".into())
        .unwrap_or_else(|e| panic!("{}: build_line_index failed: {e}", fixture.params_summary()));
    assert_eq!(
        report.total_lines,
        line_starts.len() as u64,
        "{}: total_lines mismatch (#119 family)",
        fixture.params_summary()
    );
    assert_eq!(
        report.indexed_size,
        fixture.raw_bytes.len() as u64,
        "{}: indexed_size mismatch",
        fixture.params_summary()
    );
    let expected_checkpoints: Vec<u64> = line_starts
        .iter()
        .step_by(CHECKPOINT_INTERVAL as usize)
        .copied()
        .collect();
    assert_eq!(
        report.checkpoints,
        expected_checkpoints,
        "{}: checkpoints mismatch (#119 family)",
        fixture.params_summary()
    );

    let ctx = FixtureCtx {
        path: path_str,
        raw: &fixture.raw_bytes,
        line_starts: &line_starts,
        checkpoints: &report.checkpoints,
        fixture: &fixture,
    };

    audit_forward(&ctx);
    audit_backward(&ctx);

    let session_seed = seed ^ 0xA5A5_A5A5_A5A5_A5A5;
    let trace1 = run_random_session(&ctx, &mut XorShift64::new(session_seed), ops_per_session);
    let trace2 = run_random_session(&ctx, &mut XorShift64::new(session_seed), ops_per_session);
    assert_eq!(
        trace1,
        trace2,
        "{}: determinism -- the random session trace differed across two runs with the same seed",
        fixture.params_summary()
    );

    let stale_seed = seed ^ 0x5A5A_5A5A_5A5A_5A5A;
    let stale1 = run_stale_goto_fuzz(&ctx, &mut XorShift64::new(stale_seed), stale_probes);
    let stale2 = run_stale_goto_fuzz(&ctx, &mut XorShift64::new(stale_seed), stale_probes);
    assert_eq!(
        stale1,
        stale2,
        "{}: determinism -- the stale-goto probe trace differed across two runs with the same seed",
        fixture.params_summary()
    );

    std::fs::remove_file(&path).ok();
}

#[cfg(test)]
mod tests {
    use super::*;

    const PAGING_FUZZ_SEED: u64 = 0x9A6E_5EED_FADE_C0DE;
    const OPS_PER_SESSION: usize = 20;
    const STALE_PROBES_PER_SESSION: usize = 12;
    const BODY_BYTES_EACH_SIDE: usize = chunk::CHUNK_BYTES;

    const LARGE_OPS_PER_SESSION: usize = 150;
    const LARGE_STALE_PROBES: usize = 80;
    const LARGE_BODY_BYTES_EACH_SIDE: usize = chunk::CHUNK_BYTES * 3;

    /// `ground_truth_line_starts` cross-checked against known cases lifted
    /// directly from `lineindex.rs`'s own #119 regression fixtures, before
    /// it is trusted as this file's independent oracle -- the same
    /// "prove the oracle independently" discipline `fuzz_roundtrip.rs`
    /// applies to its representable-character pools.
    #[test]
    fn ground_truth_matches_known_fixtures() {
        assert_eq!(ground_truth_line_starts(b""), Vec::<u64>::new());
        assert_eq!(ground_truth_line_starts(b"hello, world"), vec![0]);
        assert_eq!(ground_truth_line_starts(b"\n"), vec![0]);
        // Lone CR at true EOF: one line, no phantom trailing entry.
        assert_eq!(ground_truth_line_starts(b"hello\r"), vec![0]);
        // Two consecutive lone CRs: two (empty) lines.
        assert_eq!(ground_truth_line_starts(b"\r\r"), vec![0, 1]);
        // LF, CRLF, lone CR, LF -- each style once (lineindex.rs's
        // `mixed_line_endings_each_style_counts_once`).
        assert_eq!(
            ground_truth_line_starts(b"aaa\nbbb\r\nccc\rddd\n"),
            vec![0, 4, 9, 13]
        );
        // CRLF counted once, not twice.
        let crlf = b"line-0000000\r\nline-0000001\r\n";
        assert_eq!(ground_truth_line_starts(crlf), vec![0, 14]);
    }

    fn case(line_ending: LineEnding, width: Width, trailing_newline: bool, tag: u64) {
        run_paging_property_fuzz(
            line_ending,
            width,
            trailing_newline,
            PAGING_FUZZ_SEED ^ tag,
            BODY_BYTES_EACH_SIDE,
            OPS_PER_SESSION,
            STALE_PROBES_PER_SESSION,
        );
    }

    // --- CI-scale: all 12 (line-ending x width) combinations, alternating
    // trailing_newline so both states get exercised across the set. -------

    #[test]
    fn fuzz_paging_lf_ascii() {
        case(LineEnding::Lf, Width::Ascii, true, 1);
    }

    #[test]
    fn fuzz_paging_lf_cjk() {
        case(LineEnding::Lf, Width::Cjk, false, 2);
    }

    #[test]
    fn fuzz_paging_lf_astral() {
        case(LineEnding::Lf, Width::Astral, true, 3);
    }

    #[test]
    fn fuzz_paging_crlf_ascii() {
        case(LineEnding::Crlf, Width::Ascii, false, 4);
    }

    #[test]
    fn fuzz_paging_crlf_cjk() {
        case(LineEnding::Crlf, Width::Cjk, true, 5);
    }

    #[test]
    fn fuzz_paging_crlf_astral() {
        case(LineEnding::Crlf, Width::Astral, false, 6);
    }

    #[test]
    fn fuzz_paging_cr_ascii() {
        case(LineEnding::Cr, Width::Ascii, true, 7);
    }

    #[test]
    fn fuzz_paging_cr_cjk() {
        case(LineEnding::Cr, Width::Cjk, false, 8);
    }

    #[test]
    fn fuzz_paging_cr_astral() {
        case(LineEnding::Cr, Width::Astral, true, 9);
    }

    #[test]
    fn fuzz_paging_mixed_ascii() {
        case(LineEnding::Mixed, Width::Ascii, false, 10);
    }

    #[test]
    fn fuzz_paging_mixed_cjk() {
        case(LineEnding::Mixed, Width::Cjk, true, 11);
    }

    #[test]
    fn fuzz_paging_mixed_astral() {
        case(LineEnding::Mixed, Width::Astral, false, 12);
    }

    /// Manual-only, larger-volume version of every `fuzz_paging_*` test
    /// above, run together: ~3x the body size on each side of the
    /// overlong line, 150 random-session operations and 80 stale-goto
    /// probes per fixture instead of 20/12. Not part of the default
    /// `cargo test` run (kept under the CI time budget) -- run explicitly
    /// with: `cargo test --release -- --ignored fuzz_paging`.
    #[test]
    #[ignore]
    fn large_paging_fuzz_all_combinations() {
        let mut tag = 100u64;
        for &line_ending in &LineEnding::ALL {
            for &width in &Width::ALL {
                let trailing_newline = tag.is_multiple_of(2);
                run_paging_property_fuzz(
                    line_ending,
                    width,
                    trailing_newline,
                    PAGING_FUZZ_SEED ^ tag,
                    LARGE_BODY_BYTES_EACH_SIDE,
                    LARGE_OPS_PER_SESSION,
                    LARGE_STALE_PROBES,
                );
                tag += 1;
            }
        }
    }
}
