//! Cold-start latency probe (ROADMAP v0.2: "Startup-time budget test").
//!
//! Activated only when the `PLUME_STARTUP_PROBE` environment variable is
//! set. In that mode: the frontend invokes [`report_startup_ready`] once
//! its own startup sequence finishes (preferences loaded, session
//! restored, pending files opened — see the end of the init IIFE in
//! `src/main.ts`), and this prints a machine-readable
//! `startup_ms=<elapsed>` line to stdout for `scripts/startup-bench.mjs`
//! to parse, then exits the process.
//!
//! On a normal launch (the env var unset) `report_startup_ready` is a
//! no-op early return: zero behavioral difference on the regular startup
//! path, and no other command's IPC surface is touched.

use std::io::Write;
use std::sync::OnceLock;
use std::time::Instant;

static PROCESS_START: OnceLock<Instant> = OnceLock::new();

/// Record the process start time. Call once, as early as possible in
/// `run()`. Idempotent — a second call is a no-op, so it is safe even if
/// invoked more than once.
pub fn mark_process_start() {
    PROCESS_START.get_or_init(Instant::now);
}

fn probe_enabled() -> bool {
    std::env::var_os("PLUME_STARTUP_PROBE").is_some()
}

/// Machine-readable report line the bench script parses.
fn format_report(elapsed_ms: u128) -> String {
    format!("startup_ms={elapsed_ms}")
}

/// Tauri command the frontend calls once its startup sequence completes.
/// No-op unless `PLUME_STARTUP_PROBE` is set, so normal launches are
/// unaffected.
#[tauri::command]
pub fn report_startup_ready() {
    if !probe_enabled() {
        return;
    }
    let elapsed_ms = PROCESS_START
        .get()
        .map(|start| start.elapsed().as_millis())
        .unwrap_or(0);
    println!("{}", format_report(elapsed_ms));
    let _ = std::io::stdout().flush();
    std::process::exit(0);
}

#[cfg(test)]
mod tests {
    use super::format_report;

    #[test]
    fn formats_machine_readable_report() {
        assert_eq!(format_report(1234), "startup_ms=1234");
    }

    #[test]
    fn formats_zero_elapsed() {
        assert_eq!(format_report(0), "startup_ms=0");
    }
}
