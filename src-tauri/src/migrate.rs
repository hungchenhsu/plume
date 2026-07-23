//! One-time migration of the app's config directory from the old
//! `app.plume.editor` bundle identifier to the new `app.mojidori.editor`
//! one. When the identifier changes, Tauri resolves `app_config_dir()` to
//! a brand-new, empty path — without this module a user upgrading past
//! the rename would find their preferences, session (including hot-exit
//! backups), and recent-files list apparently gone.
//!
//! Only `app_config_dir()` needs migrating: `store.rs` (preferences.json,
//! session.json, recent.json — see `config_path` there) and `backup.rs`
//! (`app_config_dir()/backups`) are the only two places in this codebase
//! that persist anything under a Tauri-resolved app directory, and both
//! resolve through `app.path().app_config_dir()`. Nothing in this codebase
//! calls `app_data_dir()`, `app_local_data_dir()`, or `app_cache_dir()`.
//! (On macOS and Windows — this project's two Tier 1 platforms —
//! `app_config_dir()` and `app_data_dir()` also happen to resolve to the
//! same path, since both are `dirs::config_dir()`/`dirs::data_dir()` joined
//! with the identifier and those two base dirs coincide on those
//! platforms; that coincidence isn't relied on here, since only
//! `app_config_dir()` is ever used to persist anything.)
//!
//! Known limitation: the old and new builds use different identifiers, so
//! `tauri-plugin-single-instance`'s lock key differs between them too —
//! an old-identifier install and this one can run at the same time, and if
//! both happen to migrate (or write to `old_dir`/`new_dir`) concurrently
//! their writes can interleave. Not guarded against here (no lock check is
//! implemented); mitigated operationally by telling users in release notes
//! to close the old install before launching this one.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

/// Bundle identifier this app used before the Mojidori rename.
const OLD_IDENTIFIER: &str = "app.plume.editor";

#[derive(Debug, PartialEq, Eq)]
pub enum MigrationOutcome {
    /// The old directory didn't exist; nothing to do.
    NoOldData,
    /// The new directory already has content; left untouched so a
    /// migration can never clobber a live install (e.g. a second run
    /// after a first migration already succeeded).
    NewAlreadyPresent,
    /// Old data was copied into the new directory and verified; the old
    /// directory was renamed to `<old_dir>.migrated` (kept, never deleted).
    Migrated { files: u64, bytes: u64 },
}

/// Given the (new-identifier) app config dir, derive the sibling directory
/// the old identifier would have resolved to. `app_config_dir()` is always
/// `dirs::config_dir().join(identifier)`, so swapping the final path
/// component for the old identifier reproduces the old path exactly,
/// without needing to duplicate Tauri's per-platform base-dir resolution.
pub fn old_config_dir(new_config_dir: &Path) -> Option<PathBuf> {
    new_config_dir
        .parent()
        .map(|parent| parent.join(OLD_IDENTIFIER))
}

/// Recursively count regular files and total bytes under `dir`.
fn dir_stats(dir: &Path) -> io::Result<(u64, u64)> {
    let mut files = 0u64;
    let mut bytes = 0u64;
    let mut stack = vec![dir.to_path_buf()];
    while let Some(current) = stack.pop() {
        for entry in fs::read_dir(&current)? {
            let entry = entry?;
            let file_type = entry.file_type()?;
            if file_type.is_dir() {
                stack.push(entry.path());
            } else if file_type.is_file() {
                files += 1;
                bytes += entry.metadata()?.len();
            }
            // Symlinks aren't expected in the app config dir and are
            // skipped rather than followed or counted.
        }
    }
    Ok((files, bytes))
}

/// Recursively copy every file and subdirectory of `src` into `dst`,
/// creating `dst` (and nested subdirectories) as needed.
fn copy_dir_recursive(src: &Path, dst: &Path) -> io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let dst_path = dst.join(entry.file_name());
        if file_type.is_dir() {
            copy_dir_recursive(&entry.path(), &dst_path)?;
        } else if file_type.is_file() {
            fs::copy(entry.path(), &dst_path)?;
        }
    }
    Ok(())
}

fn dir_has_entries(dir: &Path) -> bool {
    fs::read_dir(dir)
        .map(|mut it| it.next().is_some())
        .unwrap_or(false)
}

/// Sibling staging directory the copy is built in before being published to
/// `new_dir` with a single atomic rename. Named `<new_dir>.partial` — see
/// [`migrate_dir`] for why the copy never writes into `new_dir` directly.
fn partial_dir(new_dir: &Path) -> PathBuf {
    let name = format!(
        "{}.partial",
        new_dir
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("new")
    );
    new_dir
        .parent()
        .map(|p| p.join(&name))
        .unwrap_or_else(|| PathBuf::from(&name))
}

/// Migrate `old_dir` into `new_dir`.
///
/// - `old_dir` doesn't exist -> [`MigrationOutcome::NoOldData`]; nothing
///   touched.
/// - `new_dir` exists and already has content ->
///   [`MigrationOutcome::NewAlreadyPresent`]; nothing touched (a migration
///   never overwrites a directory that's already in use).
/// - Otherwise: recursively copy `old_dir` into a sibling staging directory
///   `<new_dir>.partial` (any pre-existing `.partial` is removed first — it
///   can only be debris from a prior attempt that never finished), verify
///   the copy there (file count and total bytes match between source and
///   staging copy), then atomically `rename` the staging directory onto
///   `new_dir`. Only after that publish succeeds is `old_dir` renamed to
///   `<old_dir>.migrated` so the pre-migration data is set aside, never
///   deleted.
///
///   The copy is staged rather than written into `new_dir` directly so a
///   crash or kill mid-copy can never leave a partially-written `new_dir`
///   that a later run would mistake for
///   [`MigrationOutcome::NewAlreadyPresent`] and treat as "already
///   migrated" — `new_dir` only ever comes into existence, fully formed,
///   via that one atomic rename.
/// - If the copy, verification, or publish fails: any `.partial` staging
///   directory is removed, `old_dir` is left exactly as found, and `Err`
///   describes the failure.
pub fn migrate_dir(old_dir: &Path, new_dir: &Path) -> Result<MigrationOutcome, String> {
    if !old_dir.is_dir() {
        return Ok(MigrationOutcome::NoOldData);
    }
    if new_dir.exists() && dir_has_entries(new_dir) {
        return Ok(MigrationOutcome::NewAlreadyPresent);
    }

    let partial = partial_dir(new_dir);
    // Any `.partial` left behind can only be debris from a run that
    // crashed or was killed mid-copy; it was never published (that's the
    // one atomic step below), so it's safe to discard and start clean.
    let _ = fs::remove_dir_all(&partial);

    if let Err(e) = copy_dir_recursive(old_dir, &partial) {
        let _ = fs::remove_dir_all(&partial);
        return Err(format!(
            "failed to copy {} to {}: {e}",
            old_dir.display(),
            partial.display()
        ));
    }

    let (old_files, old_bytes) = match dir_stats(old_dir) {
        Ok(v) => v,
        Err(e) => {
            let _ = fs::remove_dir_all(&partial);
            return Err(format!(
                "failed to verify source {}: {e}",
                old_dir.display()
            ));
        }
    };
    let (new_files, new_bytes) = match dir_stats(&partial) {
        Ok(v) => v,
        Err(e) => {
            let _ = fs::remove_dir_all(&partial);
            return Err(format!(
                "failed to verify copy at {}: {e}",
                partial.display()
            ));
        }
    };

    if old_files != new_files || old_bytes != new_bytes {
        let _ = fs::remove_dir_all(&partial);
        return Err(format!(
            "migration verification mismatch: source had {old_files} file(s)/{old_bytes} byte(s), copy has {new_files} file(s)/{new_bytes} byte(s)"
        ));
    }

    // `new_dir`, if it exists at all here, was already confirmed empty
    // above (the `NewAlreadyPresent` check). Clear it explicitly before
    // the publish rename rather than relying on `fs::rename` to replace an
    // existing directory implicitly — that behavior isn't portable
    // (Windows' `MoveFileEx` does not replace an existing directory, even
    // an empty one, the way POSIX `rename` can).
    if new_dir.exists() {
        if let Err(e) = fs::remove_dir_all(new_dir) {
            let _ = fs::remove_dir_all(&partial);
            return Err(format!(
                "failed to clear pre-existing empty {}: {e}",
                new_dir.display()
            ));
        }
    }
    // Publish: one atomic rename from the verified staging directory onto
    // `new_dir`. Both are siblings under the same parent, so this is a
    // same-volume rename, not a copy — `new_dir` goes from "doesn't exist"
    // to "fully populated" in a single filesystem operation with no
    // observable in-between state.
    if let Err(e) = fs::rename(&partial, new_dir) {
        let _ = fs::remove_dir_all(&partial);
        return Err(format!(
            "verified copy at {} but could not publish it to {}: {e}",
            partial.display(),
            new_dir.display()
        ));
    }

    let migrated_name = format!(
        "{}.migrated",
        old_dir
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("old")
    );
    let migrated_path = old_dir
        .parent()
        .map(|p| p.join(&migrated_name))
        .unwrap_or_else(|| PathBuf::from(&migrated_name));
    if let Err(e) = fs::rename(old_dir, &migrated_path) {
        // The copy already verified successfully at this point, so
        // `new_dir` has good, complete data. Failing to set `old_dir`
        // aside is surprising but not a data-loss risk, so it's logged
        // rather than turned into an error that would mask a successful
        // migration.
        eprintln!(
            "migrate: copied data to {} but could not rename {} to {}: {e}",
            new_dir.display(),
            old_dir.display(),
            migrated_path.display()
        );
    }

    Ok(MigrationOutcome::Migrated {
        files: new_files,
        bytes: new_bytes,
    })
}

/// Runs the config-dir migration for `app`: destination is `app_config_dir()`
/// under the identifier baked into this build; source is the pre-rename
/// `app.plume.editor` identifier's directory, derived via [`old_config_dir`].
///
/// Must be called from `setup()` before anything reads preferences,
/// session, recent files, or backups (all of which live under
/// `app_config_dir()`), so the migrated data — if any — is what those
/// first reads see.
pub fn run<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<(), String> {
    use tauri::Manager;
    let new_dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("cannot resolve config dir: {e}"))?;
    let Some(old_dir) = old_config_dir(&new_dir) else {
        // No parent directory to derive the legacy path from (a
        // degenerate config_dir()); nothing to migrate.
        return Ok(());
    };

    match migrate_dir(&old_dir, &new_dir)? {
        MigrationOutcome::Migrated { files, bytes } => {
            eprintln!(
                "migrate: moved {files} file(s), {bytes} byte(s) from {} to {}",
                old_dir.display(),
                new_dir.display()
            );
        }
        MigrationOutcome::NoOldData | MigrationOutcome::NewAlreadyPresent => {}
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("mojidori-migrate-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn old_config_dir_swaps_final_path_component() {
        let new_dir = Path::new("/Users/alice/Library/Application Support/app.mojidori.editor");
        assert_eq!(
            old_config_dir(new_dir).unwrap(),
            Path::new("/Users/alice/Library/Application Support/app.plume.editor")
        );
    }

    #[test]
    fn old_config_dir_none_when_new_dir_has_no_parent() {
        assert_eq!(old_config_dir(Path::new("/")), None);
    }

    #[test]
    fn moves_everything_when_old_exists_and_new_is_absent() {
        let root = temp_dir("moves-everything");
        let old_dir = root.join("app.plume.editor");
        let new_dir = root.join("app.mojidori.editor");

        fs::create_dir_all(old_dir.join("backups")).unwrap();
        fs::write(old_dir.join("preferences.json"), b"{\"theme\":\"dark\"}").unwrap();
        fs::write(old_dir.join("session.json"), b"{}").unwrap();
        fs::write(
            old_dir.join("backups").join("tab-1.bak"),
            b"unsaved content",
        )
        .unwrap();

        let outcome = migrate_dir(&old_dir, &new_dir).unwrap();
        assert_eq!(
            outcome,
            MigrationOutcome::Migrated {
                files: 3,
                bytes: (b"{\"theme\":\"dark\"}".len() + b"{}".len() + b"unsaved content".len())
                    as u64,
            }
        );

        assert_eq!(
            fs::read(new_dir.join("preferences.json")).unwrap(),
            b"{\"theme\":\"dark\"}"
        );
        assert_eq!(
            fs::read(new_dir.join("backups").join("tab-1.bak")).unwrap(),
            b"unsaved content"
        );

        // Old directory is set aside, never deleted.
        assert!(!old_dir.exists());
        let migrated = root.join("app.plume.editor.migrated");
        assert!(migrated.is_dir());
        assert_eq!(
            fs::read(migrated.join("preferences.json")).unwrap(),
            b"{\"theme\":\"dark\"}"
        );

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn does_nothing_when_new_dir_already_has_content() {
        let root = temp_dir("new-already-present");
        let old_dir = root.join("app.plume.editor");
        let new_dir = root.join("app.mojidori.editor");

        fs::create_dir_all(&old_dir).unwrap();
        fs::write(old_dir.join("preferences.json"), b"old").unwrap();

        fs::create_dir_all(&new_dir).unwrap();
        fs::write(
            new_dir.join("preferences.json"),
            b"already migrated / fresh install",
        )
        .unwrap();

        let outcome = migrate_dir(&old_dir, &new_dir).unwrap();
        assert_eq!(outcome, MigrationOutcome::NewAlreadyPresent);

        // Neither side touched.
        assert_eq!(fs::read(old_dir.join("preferences.json")).unwrap(), b"old");
        assert_eq!(
            fs::read(new_dir.join("preferences.json")).unwrap(),
            b"already migrated / fresh install"
        );

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn does_nothing_when_neither_dir_exists() {
        let root = temp_dir("neither-exists");
        let old_dir = root.join("app.plume.editor");
        let new_dir = root.join("app.mojidori.editor");

        let outcome = migrate_dir(&old_dir, &new_dir).unwrap();
        assert_eq!(outcome, MigrationOutcome::NoOldData);

        assert!(!old_dir.exists());
        assert!(!new_dir.exists());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn does_nothing_when_new_dir_exists_but_is_empty() {
        // An empty new_dir (e.g. Tauri or another plugin created it as a
        // side effect) should still be treated as "no live data there" and
        // migrated into, not skipped.
        let root = temp_dir("new-empty");
        let old_dir = root.join("app.plume.editor");
        let new_dir = root.join("app.mojidori.editor");

        fs::create_dir_all(&old_dir).unwrap();
        fs::write(old_dir.join("preferences.json"), b"old").unwrap();
        fs::create_dir_all(&new_dir).unwrap();

        let outcome = migrate_dir(&old_dir, &new_dir).unwrap();
        assert!(matches!(
            outcome,
            MigrationOutcome::Migrated { files: 1, .. }
        ));
        assert_eq!(fs::read(new_dir.join("preferences.json")).unwrap(), b"old");
        assert!(!old_dir.exists());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    // Unix-only: Windows ignores FILE_ATTRIBUTE_READONLY on directories,
    // so a read-only parent does not block child creation and the copy
    // never fails there. The error path under test is platform-independent
    // io::Error propagation; unix coverage suffices.
    #[cfg(unix)]
    fn leaves_old_dir_intact_when_copy_target_is_unwritable() {
        let root = temp_dir("copy-fails");
        let old_dir = root.join("app.plume.editor");
        fs::create_dir_all(old_dir.join("nested")).unwrap();
        fs::write(old_dir.join("preferences.json"), b"old").unwrap();
        fs::write(old_dir.join("nested").join("deep.txt"), b"deep content").unwrap();

        // Make the staging dir's parent read-only so
        // `create_dir_all(<new_dir>.partial)` (inside copy_dir_recursive)
        // fails partway through, before `new_dir` itself is ever touched.
        let blocked_parent = root.join("blocked");
        fs::create_dir_all(&blocked_parent).unwrap();
        let new_dir = blocked_parent.join("app.mojidori.editor");

        let mut perms = fs::metadata(&blocked_parent).unwrap().permissions();
        perms.set_readonly(true);
        fs::set_permissions(&blocked_parent, perms).unwrap();

        let result = migrate_dir(&old_dir, &new_dir);

        // Restore permissions before any assertion can early-return/panic
        // and leave the temp dir unremovable.
        let mut perms = fs::metadata(&blocked_parent).unwrap().permissions();
        #[allow(clippy::permissions_set_readonly_false)]
        perms.set_readonly(false);
        fs::set_permissions(&blocked_parent, perms).unwrap();

        assert!(result.is_err(), "expected an Err, got {result:?}");

        // Old directory is completely untouched.
        assert!(old_dir.is_dir());
        assert_eq!(fs::read(old_dir.join("preferences.json")).unwrap(), b"old");
        assert_eq!(
            fs::read(old_dir.join("nested").join("deep.txt")).unwrap(),
            b"deep content"
        );
        // No half-written new_dir left behind.
        assert!(!new_dir.exists());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn recovers_from_a_previous_crash_that_left_partial_debris() {
        let root = temp_dir("recovers-from-partial");
        let old_dir = root.join("app.plume.editor");
        let new_dir = root.join("app.mojidori.editor");

        fs::create_dir_all(&old_dir).unwrap();
        fs::write(old_dir.join("preferences.json"), b"real prefs").unwrap();
        fs::write(old_dir.join("session.json"), b"real session").unwrap();

        // Simulate a run that crashed mid-copy on a previous launch:
        // `new_dir` was never published (it doesn't exist), but its
        // `.partial` staging directory is still around with stale,
        // incomplete content from that attempt.
        let partial = partial_dir(&new_dir);
        fs::create_dir_all(&partial).unwrap();
        fs::write(partial.join("preferences.json"), b"TRUNCATED-GARBAGE").unwrap();

        let outcome = migrate_dir(&old_dir, &new_dir).unwrap();
        assert!(matches!(
            outcome,
            MigrationOutcome::Migrated { files: 2, .. }
        ));

        // The rerun discarded the stale partial content and copied the
        // real data fresh -- not a merge of old debris with new data --
        // and `new_dir` ends up complete rather than being mistaken for
        // `NewAlreadyPresent` because of the leftover debris.
        assert_eq!(
            fs::read(new_dir.join("preferences.json")).unwrap(),
            b"real prefs"
        );
        assert_eq!(
            fs::read(new_dir.join("session.json")).unwrap(),
            b"real session"
        );
        assert!(!partial.exists());
        assert!(!old_dir.exists());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn publishes_new_dir_via_rename_then_only_afterwards_retires_old_dir() {
        let root = temp_dir("publish-order");
        let old_dir = root.join("app.plume.editor");
        let new_dir = root.join("app.mojidori.editor");
        let partial = partial_dir(&new_dir);

        fs::create_dir_all(&old_dir).unwrap();
        fs::write(old_dir.join("preferences.json"), b"data").unwrap();

        let outcome = migrate_dir(&old_dir, &new_dir).unwrap();
        assert!(matches!(
            outcome,
            MigrationOutcome::Migrated { files: 1, .. }
        ));

        // Final state is only reachable if the steps ran in the documented
        // order: `new_dir` is fully populated (published by the staging
        // rename), the staging directory is gone -- consumed by that
        // rename, not left behind as a separate copy -- and `old_dir` was
        // retired to `.migrated` (never deleted) only as the last step,
        // after the publish had already succeeded.
        assert!(new_dir.is_dir());
        assert_eq!(fs::read(new_dir.join("preferences.json")).unwrap(), b"data");
        assert!(
            !partial.exists(),
            "staging dir should be consumed by the publish rename, not left behind"
        );
        assert!(!old_dir.exists());
        assert!(root.join("app.plume.editor.migrated").is_dir());

        let _ = fs::remove_dir_all(&root);
    }
}
