//! Open-file latency probe (ROADMAP v0.4 Track B: "File-open latency
//! budget script"). A companion to `startup_probe.rs` that isolates
//! "trigger open -> content rendered" from full cold-start latency, so a
//! change to the open path can be measured without the WebView/prefs/
//! session-restore overhead `startup_probe` already covers.
//!
//! Activated only when the `MOJIDORI_OPENFILE_PROBE` environment variable is
//! set, to the absolute path of the file to open. In that mode: once the
//! frontend's normal startup sequence completes (preferences loaded,
//! session restored, pending files opened — see the end of the init IIFE
//! in `src/main.ts`), it reads the path back via [`openfile_probe_path`],
//! opens it through the exact same `openPath()` codepath a real drag-drop
//! or file-association open uses, times the operation itself in JS with
//! `performance.now()` (both endpoints — trigger and post-paint — live in
//! the frontend here, unlike the cold-start probe, which must time from a
//! pre-JS process start), and reports the result through
//! [`report_openfile_ready`], which prints a machine-readable
//! `openfile_ms=<n>` line to stdout for `scripts/openfile-bench.mjs` to
//! parse, then exits the process.
//!
//! On a normal launch (the env var unset) `openfile_probe_path` returns
//! `None` and the frontend never calls `report_openfile_ready`: zero
//! behavioral difference on the regular startup or open path, and no other
//! command's IPC surface is touched.

use std::io::Write;

fn probe_path() -> Option<String> {
    std::env::var("MOJIDORI_OPENFILE_PROBE")
        .ok()
        .filter(|value| !value.is_empty())
}

/// Tauri command the frontend calls once at startup to learn whether an
/// open-file probe was requested and, if so, which path to open. Returns
/// `None` on a normal launch.
#[tauri::command]
pub fn openfile_probe_path() -> Option<String> {
    probe_path()
}

/// Machine-readable report line the bench script parses.
fn format_report(elapsed_ms: u64) -> String {
    format!("openfile_ms={elapsed_ms}")
}

/// Tauri command the frontend calls once the probed file's content has
/// been opened and rendered, with the elapsed milliseconds it measured
/// itself. No-op unless `MOJIDORI_OPENFILE_PROBE` is set, so normal opens are
/// unaffected.
#[tauri::command]
pub fn report_openfile_ready(elapsed_ms: f64) {
    if probe_path().is_none() {
        return;
    }
    println!("{}", format_report(elapsed_ms.round() as u64));
    let _ = std::io::stdout().flush();
    std::process::exit(0);
}

#[cfg(test)]
mod tests {
    use super::format_report;

    #[test]
    fn formats_machine_readable_report() {
        assert_eq!(format_report(1234), "openfile_ms=1234");
    }

    #[test]
    fn formats_zero_elapsed() {
        assert_eq!(format_report(0), "openfile_ms=0");
    }
}
