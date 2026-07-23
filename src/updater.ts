// Auto-update (ROADMAP.md D2): background startup check + a manual "Check
// for Updates…" menu entry, both routed through `checkForUpdatesAndPrompt`
// below. Talks to the Rust-side `tauri-plugin-updater` / `tauri-plugin-process`
// plugins via raw `invoke("plugin:<name>|<command>", ...)` calls instead of
// the `@tauri-apps/plugin-updater` / `@tauri-apps/plugin-process` npm
// packages — CLAUDE.md "no new runtime dependencies without strong
// justification" scopes the D2 approval to the two Cargo crates only, and
// `@tauri-apps/api/core`'s `invoke`/`Channel` (already a dependency, used
// throughout `src/ipc.ts`) are enough to call any Tauri plugin command
// directly by its name — the same mechanism those npm packages use
// internally.
import { Channel, invoke } from "@tauri-apps/api/core";
import { confirm as confirmDialog, message as messageDialog } from "@tauri-apps/plugin-dialog";
import { t } from "./i18n";

/** Mirrors the updater plugin's Rust `Metadata` struct — the raw shape
 *  `invoke("plugin:updater|check")` resolves to (serde
 *  `rename_all = "camelCase"`), not the `@tauri-apps/plugin-updater`
 *  `Update` class this module deliberately doesn't depend on (see module
 *  doc comment). `rid` is the resource id `download` below reads to fetch
 *  this same checked update. */
interface UpdateMetadata {
  rid: number;
  currentVersion: string;
  version: string;
  date?: string;
  body?: string;
  rawJson: unknown;
}

/** What the caller must supply so this module never needs to know about
 *  `tabs`/`editor`/`backups` directly — same dependency-injection idiom as
 *  `createBackupPipeline`/`createSessionPersister`/`createOpQueue`
 *  elsewhere in this codebase. */
export interface UpdaterDeps {
  /** Flush every dirty buffer to its hot-exit backup and persist the
   *  session; resolves `true` when everything landed, `false` when any
   *  backup or the session write failed (never rejects — a thrown error
   *  is treated the same as `false` by `promptAndInstall` below).
   *
   *  Must run, and its `false` case must be handled, strictly *before*
   *  `install` is called below — never after. `install` (`plugin:updater|install`)
   *  never returns on Windows: the plugin launches the platform installer
   *  via `ShellExecuteW` and then calls `std::process::exit(0)` in the same
   *  Rust command handler
   *  (github.com/tauri-apps/plugins-workspace, v2, plugins/updater/src/updater.rs,
   *  `install_inner`'s `#[cfg(windows)]` branch) — nothing after that
   *  `invoke` call, in this module or anywhere else in the frontend, ever
   *  runs on Windows. Anything meant to happen on every platform —
   *  flushing hot-exit backups foremost — has to happen before `install`,
   *  not after it or after `relaunch`. */
  flushForExit: () => Promise<boolean>;
}

async function checkForUpdate(): Promise<UpdateMetadata | null> {
  return invoke<UpdateMetadata | null>("plugin:updater|check", {});
}

/** Downloads the update's bytes into a Rust-side resource and returns its
 *  id — `install` below needs both this and the original `check` resource
 *  id to actually install it. Split from `install` (rather than the
 *  combined `plugin:updater|download_and_install`) specifically so
 *  `flushForExit` can run, and its failure dialog be resolved, in the gap
 *  between the two — see `UpdaterDeps.flushForExit`'s doc comment for why
 *  that gap has to exist at all. */
async function download(rid: number): Promise<number> {
  // The `onEvent` channel is a required argument on the Rust side
  // (progress reporting); this flow has no progress UI, so the channel is
  // constructed but never given an `onmessage` handler.
  const onEvent = new Channel<unknown>();
  return invoke<number>("plugin:updater|download", { rid, onEvent });
}

/** Installs a previously downloaded update. Returns on macOS/Linux;
 *  **never returns on Windows** — see `UpdaterDeps.flushForExit`'s doc
 *  comment. Every side effect this flow needs on every platform must
 *  already be done by the time this is called. */
async function install(updateRid: number, bytesRid: number): Promise<void> {
  await invoke("plugin:updater|install", {
    updateRid,
    bytesRid,
    // This module drives the restart itself on the platforms where
    // `install` actually returns to it (see `relaunch` below) — no need
    // for the plugin to also do it internally. Ignored entirely on
    // macOS/Linux and only affects the installer's own launch args on
    // Windows (which has already `exit(0)`'d us by the time it would
    // matter here either way).
    restartAfterInstall: false,
  });
}

/** Only ever reached on macOS/Linux — see `install`'s doc comment. Kept
 *  unconditional (not platform-gated) rather than dead-code-guarded: on
 *  Windows this call site is simply never reached, so gating it would add
 *  a platform check with nothing to actually branch on from the frontend
 *  side. */
async function relaunch(): Promise<void> {
  await invoke("plugin:process|restart");
}

async function promptAndInstall(update: UpdateMetadata, deps: UpdaterDeps): Promise<void> {
  const proceed = await confirmDialog(t("updater.availableMessage", update.version), {
    title: t("updater.availableTitle"),
    okLabel: t("updater.downloadAndRestart"),
    cancelLabel: t("updater.later"),
  }).catch(() => false);
  if (!proceed) return;

  let bytesRid: number;
  try {
    bytesRid = await download(update.rid);
  } catch (error) {
    console.error("updater: download failed", error);
    await messageDialog(t("updater.downloadFailedMessage"), {
      title: t("updater.downloadFailedTitle"),
      kind: "error",
    }).catch(() => {});
    return;
  }

  const flushed = await deps.flushForExit().catch((error) => {
    console.error("updater: flushForExit failed", error);
    return false;
  });
  if (!flushed) {
    // Default is Cancel (both the explicit button and confirmDialog's own
    // dismiss-as-false behavior): nothing has been installed yet at this
    // point on any platform, so declining costs nothing but being asked
    // again next check — installing over a failed backup is the choice
    // that can actually lose data, so it must be opt-in, never the
    // fallback.
    const installAnyway = await confirmDialog(t("updater.flushFailedMessage"), {
      title: t("updater.flushFailedTitle"),
      kind: "warning",
      okLabel: t("updater.installAnyway"),
      cancelLabel: t("updater.cancelInstall"),
    }).catch(() => false);
    if (!installAnyway) return;
  }

  try {
    await install(update.rid, bytesRid);
  } catch (error) {
    // Windows never reaches here on success (see install's doc comment) —
    // only a genuine install failure lands in this catch on any platform.
    console.error("updater: install failed", error);
    await messageDialog(t("updater.installFailedMessage"), {
      title: t("updater.installFailedTitle"),
      kind: "error",
    }).catch(() => {});
    return;
  }
  // Windows: unreachable, the process already exited inside `install`.
  await relaunch().catch((error) => {
    console.error("updater: relaunch failed", error);
  });
}

/**
 * Check for an update and, if one exists, ask the user before downloading
 * and installing it.
 *
 * `silent: true` (the startup call) never surfaces a dialog for "no update"
 * or "check failed" — offline is the normal state for a local desktop
 * editor, not an error to interrupt startup with, so those paths only ever
 * reach `console.error`. `silent: false` (the File menu's "Check for
 * Updates…" item) additionally tells the user when they're already up to
 * date or when the check itself failed, so a manual click never silently
 * does nothing. The "update available" prompt itself always shows,
 * regardless of `silent`.
 */
export async function checkForUpdatesAndPrompt(
  deps: UpdaterDeps,
  options: { silent: boolean },
): Promise<void> {
  let update: UpdateMetadata | null;
  try {
    update = await checkForUpdate();
  } catch (error) {
    console.error("updater: check failed", error);
    if (!options.silent) {
      await messageDialog(t("updater.checkFailedMessage"), {
        title: t("updater.checkFailedTitle"),
        kind: "error",
      }).catch(() => {});
    }
    return;
  }
  if (!update) {
    if (!options.silent) {
      await messageDialog(t("updater.upToDateMessage"), {
        title: t("updater.upToDateTitle"),
      }).catch(() => {});
    }
    return;
  }
  await promptAndInstall(update, deps);
}
