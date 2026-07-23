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
 *  doc comment). `rid` is the resource id later commands (`download_and_install`)
 *  reference to operate on this same checked update. */
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
  /** Best-effort: flush every dirty buffer to its hot-exit backup and
   *  persist the session, then resolve regardless of whether that
   *  succeeded. `plugin:process|restart` calls Tauri's `request_restart`,
   *  which skips every window's `onCloseRequested` listener entirely (it
   *  restarts on the next `RuntimeRunEvent::Exit`, not through the
   *  per-window close-request path main.ts's own hot-exit flush hangs
   *  off) — without this call, an update-triggered relaunch could
   *  silently drop unsaved edits despite the app's hot-exit promise. This
   *  is why `updater.availableMessage` below can truthfully tell the user
   *  their edits are backed up automatically before restarting. */
  flushForExit: () => Promise<void>;
}

async function checkForUpdate(): Promise<UpdateMetadata | null> {
  return invoke<UpdateMetadata | null>("plugin:updater|check", {});
}

async function downloadAndInstall(rid: number): Promise<void> {
  // download_and_install's `onEvent` channel is a required argument on the
  // Rust side (progress reporting); this flow has no progress UI, so the
  // channel is constructed but never given an `onmessage` handler.
  const onEvent = new Channel<unknown>();
  await invoke("plugin:updater|download_and_install", {
    rid,
    onEvent,
    // This module drives the restart itself (after flushForExit), not the
    // plugin — see promptAndInstall below.
    restartAfterInstall: false,
  });
}

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

  try {
    await downloadAndInstall(update.rid);
  } catch (error) {
    console.error("updater: download_and_install failed", error);
    await messageDialog(t("updater.downloadFailedMessage"), {
      title: t("updater.downloadFailedTitle"),
      kind: "error",
    }).catch(() => {});
    return;
  }

  await deps.flushForExit().catch((error) => {
    console.error("updater: flushForExit failed", error);
  });
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
