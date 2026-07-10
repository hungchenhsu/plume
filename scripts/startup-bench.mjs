#!/usr/bin/env node
// scripts/startup-bench.mjs
//
// Cold-start latency benchmark for the built Plume binary (ROADMAP v0.2:
// "Startup-time budget test"). Pillar 2 of the project ("open a text file
// faster than an IDE") needs a regression guard, not just a vibe.
//
// Usage:
//   node scripts/startup-bench.mjs [--runs=N] [--threshold=MS] [--bin=PATH]
//
//   --runs=N       Number of *measured* runs (default 5). One extra warmup
//                   run is always executed first and discarded, so total
//                   process launches = N + 1.
//   --threshold=MS Optional. If the median exceeds this, exits non-zero
//                   (for CI gating). Omit for an informational-only run.
//   --bin=PATH     Override the binary path (e.g. a packaged .app on
//                   macOS: .../bundle/macos/Plume.app/Contents/MacOS/plume).
//                   Defaults to the platform release build under
//                   src-tauri/target/release.
//
// Requires a release build first:
//   cd src-tauri && cargo build --release
//
// Mechanism: each run launches the binary with PLUME_STARTUP_PROBE=1 set.
// In that mode the app measures process-start -> frontend-ready (frontend
// init sequence complete: preferences, session restore, pending files —
// see src/main.ts), prints `startup_ms=<n>` to stdout, and exits
// immediately (see src-tauri/src/startup_probe.rs). Normal launches never
// take this path, so this has zero effect on real startup behavior.
//
// Windows path (src-tauri\target\release\plume.exe) is implemented but
// not locally verified in this change — noted in the PR description.

import { spawn } from "node:child_process";
import { appendFileSync, existsSync } from "node:fs";
import { platform } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = join(__dirname, "..");

function parseArgs(argv) {
  const args = { runs: 5, threshold: null, bin: null };
  for (const arg of argv) {
    const [key, value] = arg.replace(/^--/, "").split("=");
    if (key === "runs") args.runs = Number(value);
    else if (key === "threshold") args.threshold = Number(value);
    else if (key === "bin") args.bin = value;
  }
  return args;
}

function defaultBinaryPath() {
  const exe = platform() === "win32" ? "plume.exe" : "plume";
  return join(repoRoot, "src-tauri", "target", "release", exe);
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/**
 * Launch the binary once in probe mode; resolves with the reported
 * startup_ms. The child's stdout/stderr are streamed to the console in
 * full (prefixed) so CI logs show exactly what the app printed — or
 * failed to print — before a timeout.
 */
function runOnce(binPath, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const child = spawn(binPath, [], {
      env: { ...process.env, PLUME_STARTUP_PROBE: "1" },
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
            `Timed out after ${timeoutMs}ms waiting for startup_ms (${status}).\n` +
              `stdout so far: ${JSON.stringify(stdout)}\n` +
              `stderr so far: ${JSON.stringify(stderr)}`,
          ),
        );
        return;
      }
      const match = stdout.match(/startup_ms=(\d+)/);
      if (!match) {
        reject(
          new Error(
            `No startup_ms in output (${status}).\n` +
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const binPath = args.bin ?? defaultBinaryPath();

  if (!existsSync(binPath)) {
    console.error(`Binary not found at ${binPath}.`);
    console.error("Build it first: cd src-tauri && cargo build --release");
    process.exitCode = 1;
    return;
  }

  const measuredRuns = Math.max(args.runs, 1);
  const samples = [];

  for (let i = 0; i <= measuredRuns; i++) {
    const ms = await runOnce(binPath);
    if (i === 0) {
      console.log(`run 1/${measuredRuns + 1} (warmup, discarded): ${ms}ms`);
      continue;
    }
    console.log(`run ${i + 1}/${measuredRuns + 1}: ${ms}ms`);
    samples.push(ms);
  }

  const med = median(samples);
  console.log(`\nsamples (ms): [${samples.join(", ")}]`);
  console.log(`median_startup_ms=${med}`);

  if (process.env.GITHUB_STEP_SUMMARY) {
    const lines = [
      "### Startup-time benchmark",
      "",
      `Binary: \`${binPath}\``,
      `Measured runs: ${samples.length} (+1 discarded warmup)`,
      `Samples (ms): ${samples.join(", ")}`,
      `**Median: ${med}ms**`,
      args.threshold ? `Threshold: ${args.threshold}ms` : "",
      "",
    ];
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join("\n") + "\n");
  }

  if (args.threshold && med > args.threshold) {
    console.error(
      `FAIL: median startup ${med}ms exceeds threshold ${args.threshold}ms`,
    );
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
