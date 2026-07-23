#!/usr/bin/env node
// scripts/openfile-bench.mjs
//
// File-open latency benchmark for the built Mojidori binary (ROADMAP v0.4
// Track B: "File-open latency budget script"). Companion to
// scripts/startup-bench.mjs, isolating "trigger open -> content rendered"
// from full cold-start latency (WebView init, preferences, session
// restore), so a change to the open path itself can be measured without
// that overhead in the way.
//
// Usage:
//   node scripts/openfile-bench.mjs [--runs=N] [--sizes=small,large]
//                                    [--threshold-small=MS] [--threshold-large=MS]
//                                    [--bin=PATH] [--dry-run]
//
//   --runs=N              Number of *measured* runs per size (default 5).
//                          One extra warmup run per size is always executed
//                          first and discarded, so total launches per size
//                          = N + 1.
//   --sizes=LIST           Comma-separated subset of "small" (1 MiB, opens
//                          in full) and "large" (50 MiB, crosses
//                          LARGE_FILE_THRESHOLD in src-tauri/src/lib.rs —
//                          currently 10 MiB — so it opens through the
//                          read-only preview path instead). Default: both.
//   --threshold-small=MS  Optional. If that size's median exceeds this,
//   --threshold-large=MS  exits non-zero (for a human to gate on locally).
//                          Omit either for an informational-only run.
//   --bin=PATH            Override the binary path (e.g. a packaged .app
//                          on macOS: .../bundle/macos/Mojidori.app/Contents/
//                          MacOS/mojidori). Defaults to the platform release
//                          build under src-tauri/target/release.
//   --dry-run             Generate the synthetic fixtures, print their
//                          paths/sizes, clean up, and exit — never spawns
//                          the binary. Safe to run anywhere, including
//                          headless; this is the only mode that does not
//                          open a GUI window.
//
// Requires a release build first:
//   cd src-tauri && cargo build --release
//
// Mechanism: mirrors startup-bench's env-gated probe pattern with a new,
// separate probe rather than overloading the existing one, because the two
// measure different windows. startup-bench's MOJIDORI_STARTUP_PROBE times
// process-start -> frontend-ready and exits before any file would be
// opened; reusing it would fold WebView/prefs/session-restore latency into
// the open-latency number. Instead: each run launches the binary with
// MOJIDORI_OPENFILE_PROBE=<path to a synthetic fixture> and no other args. The
// frontend boots completely normally (no pending files — the probe path
// deliberately bypasses the OS-args "pending files" queue), and once its
// ordinary startup sequence finishes it reads the probe path back via
// `openfile_probe_path`, opens it through the exact same `openPath()`
// codepath a real drag-drop or file-association open uses, times trigger
// -> next paint with performance.now() in the frontend itself (both
// endpoints live there, unlike the cold-start probe which must time from a
// pre-JS process start), reports the result to `report_openfile_ready`,
// which prints a machine-readable `openfile_ms=<n>` line to stdout and
// exits immediately (see src-tauri/src/openfile_probe.rs and the hook at
// the end of the init IIFE in src/main.ts). Normal launches and normal
// opens never take this path, so this has zero effect on either.
//
// Windows path (src-tauri\target\release\mojidori.exe) is implemented but not
// locally verified in this change, matching startup-bench's own caveat.
//
// Dead end (2026-07-10, inherited from startup-bench — see that script's
// header): running this in CI does not work. On GitHub's macOS runners the
// WKWebView never begins loading the page, so frontend JS never runs and
// no report line is ever printed; the same silence occurs locally when the
// screen is locked. This script must never be added to CI. Run it on an
// unlocked, interactive desktop.
//
// Agent operating note (2026-07-15): actually launching this script spawns
// the Mojidori binary, which opens a real GUI window (WKWebView / WebView2).
// Coding agents in this repo must never do that — an earlier agent's
// `npm run tauri dev` caused macOS to revoke this process tree's disk
// access for hours (TCC incident, see project memory). An agent that
// implements or modifies this script verifies it with
// `node --check scripts/openfile-bench.mjs` and `--dry-run` (fixture
// generation/cleanup only, no binary spawn) — never by actually running
// the benchmark. Real openfile_ms numbers are for a human to gather by
// hand, on an unlocked desktop: `node scripts/openfile-bench.mjs`.

import { spawn } from "node:child_process";
import { appendFileSync, existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = join(__dirname, "..");

// Mirrors src-tauri/src/lib.rs's LARGE_FILE_THRESHOLD (files over this size
// open as a bounded read-only preview instead of loading fully).
const LARGE_FILE_THRESHOLD_BYTES = 10 * 1024 * 1024;

const MIB = 1024 * 1024;
const FIXTURE_SPECS = {
  small: { label: "small (1 MiB, full open)", targetBytes: 1 * MIB },
  large: { label: "large (50 MiB, preview-path open)", targetBytes: 50 * MIB },
};

function parseArgs(argv) {
  const args = {
    runs: 5,
    sizes: ["small", "large"],
    thresholds: {},
    bin: null,
    dryRun: false,
  };
  for (const arg of argv) {
    if (arg === "--dry-run") {
      args.dryRun = true;
      continue;
    }
    const [key, value] = arg.replace(/^--/, "").split("=");
    if (key === "runs") args.runs = Number(value);
    else if (key === "bin") args.bin = value;
    else if (key === "sizes") {
      args.sizes = value.split(",").map((s) => s.trim()).filter(Boolean);
    } else if (key === "threshold-small") args.thresholds.small = Number(value);
    else if (key === "threshold-large") args.thresholds.large = Number(value);
  }
  for (const size of args.sizes) {
    if (!FIXTURE_SPECS[size]) {
      throw new Error(`Unknown --sizes entry "${size}" (expected small, large)`);
    }
  }
  return args;
}

function defaultBinaryPath() {
  const exe = platform() === "win32" ? "mojidori.exe" : "mojidori";
  return join(repoRoot, "src-tauri", "target", "release", exe);
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/** Nearest-rank percentile (p in [0, 100]). */
function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  const index = Math.min(Math.max(rank - 1, 0), sorted.length - 1);
  return sorted[index];
}

/**
 * Deterministic synthetic UTF-8 text: numbered lines, mostly ASCII with an
 * occasional CJK line so the fixture genuinely exercises multi-byte
 * decoding rather than being ASCII-only-by-accident. Grows in whole lines
 * until at least targetBytes, so the result is targetBytes plus at most one
 * line's worth of overshoot — exact byte-for-byte sizing isn't the point,
 * only "about 1 MiB" / "about 50 MiB".
 */
function synthDoc(targetBytes) {
  const parts = [];
  let size = 0;
  let n = 0;
  while (size < targetBytes) {
    const line =
      n % 50 === 0
        ? `line ${n}: 敏捷的棕色狐狸跳過懶狗，用於開檔延遲測試的多位元組字元樣本。\n`
        : `line ${n}: the quick brown fox jumps over the lazy dog.\n`;
    parts.push(line);
    size += Buffer.byteLength(line, "utf8");
    n += 1;
  }
  return parts.join("");
}

/**
 * Writes the requested synthetic fixtures into a fresh temp directory.
 * Returns the file list (with actual on-disk byte sizes) and a cleanup
 * function that removes the whole temp directory; callers should always
 * invoke cleanup, success or failure.
 */
async function generateFixtures(sizeNames) {
  const dir = await mkdtemp(join(tmpdir(), "mojidori-openfile-bench-"));
  const files = [];
  for (const name of sizeNames) {
    const spec = FIXTURE_SPECS[name];
    const content = synthDoc(spec.targetBytes);
    const path = join(dir, `${name}.txt`);
    await writeFile(path, content, "utf8");
    files.push({
      name,
      label: spec.label,
      path,
      bytes: Buffer.byteLength(content, "utf8"),
    });
  }
  const cleanup = () => rm(dir, { recursive: true, force: true });
  return { dir, files, cleanup };
}

/**
 * Launch the binary once with the open-file probe pointed at filePath;
 * resolves with the reported openfile_ms. The child's stdout/stderr are
 * streamed to the console in full (prefixed) so the log shows exactly what
 * the app printed — or failed to print — before a timeout.
 */
function runOnce(binPath, filePath, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const child = spawn(binPath, [], {
      env: { ...process.env, MOJIDORI_OPENFILE_PROBE: filePath },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      process.stdout.write(`  [app stdout] ${chunk}`);
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      process.stderr.write(`  [app stderr] ${chunk}`);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      const status = `exit code ${code}, signal ${signal}`;
      if (timedOut) {
        reject(
          new Error(
            `Timed out after ${timeoutMs}ms waiting for openfile_ms (${status}).\n` +
              `stdout so far: ${JSON.stringify(stdout)}\n` +
              `stderr so far: ${JSON.stringify(stderr)}`,
          ),
        );
        return;
      }
      const match = stdout.match(/openfile_ms=(\d+)/);
      if (!match) {
        reject(
          new Error(
            `No openfile_ms in output (${status}).\n` +
              `stdout: ${JSON.stringify(stdout)}\n` +
              `stderr: ${JSON.stringify(stderr)}`,
          ),
        );
        return;
      }
      resolve(Number(match[1]));
    });
  });
}

async function benchOne(binPath, file, measuredRuns) {
  const samples = [];
  for (let i = 0; i <= measuredRuns; i++) {
    const ms = await runOnce(binPath, file.path);
    if (i === 0) {
      console.log(
        `[${file.name}] run 1/${measuredRuns + 1} (warmup, discarded): ${ms}ms`,
      );
      continue;
    }
    console.log(`[${file.name}] run ${i + 1}/${measuredRuns + 1}: ${ms}ms`);
    samples.push(ms);
  }
  return {
    file,
    samples,
    median: median(samples),
    p95: percentile(samples, 95),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const measuredRuns = Math.max(args.runs, 1);

  const { files, cleanup } = await generateFixtures(args.sizes);
  try {
    if (args.dryRun) {
      console.log("Dry run: fixtures generated, binary not spawned.\n");
      for (const f of files) {
        const overThreshold = f.bytes > LARGE_FILE_THRESHOLD_BYTES;
        console.log(
          `  ${f.name} (${f.label}): ${f.path} — ${f.bytes} bytes` +
            (overThreshold
              ? ` (> ${LARGE_FILE_THRESHOLD_BYTES}-byte LARGE_FILE_THRESHOLD -> preview path)`
              : " (full open path)"),
        );
      }
      console.log("\nCleaning up and exiting (no binary was spawned).");
      return;
    }

    const binPath = args.bin ?? defaultBinaryPath();
    if (!existsSync(binPath)) {
      console.error(`Binary not found at ${binPath}.`);
      console.error("Build it first: cd src-tauri && cargo build --release");
      process.exitCode = 1;
      return;
    }

    const results = [];
    for (const file of files) {
      results.push(await benchOne(binPath, file, measuredRuns));
    }

    console.log("");
    const summaryLines = ["### Open-file latency benchmark", "", `Binary: \`${binPath}\``, ""];
    for (const r of results) {
      console.log(`[${r.file.name}] samples (ms): [${r.samples.join(", ")}]`);
      console.log(`[${r.file.name}] median_openfile_ms=${r.median}`);
      console.log(`[${r.file.name}] p95_openfile_ms=${r.p95}`);
      const threshold = args.thresholds[r.file.name];
      summaryLines.push(
        `**${r.file.name}** (${r.file.label}, ${r.file.bytes} bytes)`,
        `- Measured runs: ${r.samples.length} (+1 discarded warmup)`,
        `- Samples (ms): ${r.samples.join(", ")}`,
        `- Median: ${r.median}ms, p95: ${r.p95}ms` +
          (threshold ? `, threshold: ${threshold}ms` : ""),
        "",
      );
      if (threshold && r.median > threshold) {
        console.error(
          `FAIL: [${r.file.name}] median open-file latency ${r.median}ms exceeds threshold ${threshold}ms`,
        );
        process.exitCode = 1;
      }
    }

    if (process.env.GITHUB_STEP_SUMMARY) {
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, summaryLines.join("\n") + "\n");
    }
  } finally {
    await cleanup();
  }
}

const isMainModule = import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}

export { median, percentile, synthDoc };
