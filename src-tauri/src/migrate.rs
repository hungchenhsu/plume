//! One-time migration of the app's config directory from the old
//! `app.plume.editor` bundle identifier to the new `app.mojidori.editor`
//! one. When the identifier changes, Tauri resolves `app_config_dir()` to
//! a brand-new, empty path — without this module a user upgrading past
//! the rename would find their preferences, session (including hot-exit
//! backups), and recent-files list apparently gone.
//!
//! `app_config_dir()` is written to by: `store.rs` (preferences.json,
//! session.json, recent.json — see `config_path` there), `backup.rs`
//! (`app_config_dir()/backups`), **`tauri-plugin-window-state`**
//! (`.window-state.json`, written on every exit — this is not our code,
//! but it matters a great deal here: see the state-machine note below),
//! and this module itself (the `.partial` staging dir, the `.migrated`
//! retirement dir, and the `.migration-complete` marker file, all
//! siblings of `app_config_dir()` rather than inside it). Nothing in this
//! codebase or its plugins calls `app_data_dir()`, `app_local_data_dir()`,
//! or `app_cache_dir()`. (On macOS and Windows — this project's two Tier 1
//! platforms — `app_config_dir()` and `app_data_dir()` also happen to
//! resolve to the same path, since both are
//! `dirs::config_dir()`/`dirs::data_dir()` joined with the identifier and
//! those two base dirs coincide on those platforms; that coincidence
//! isn't relied on here, since only `app_config_dir()` is ever used to
//! persist anything.)
//!
//! ## Why a durable completion marker, not just "is `new_dir` non-empty"
//!
//! An earlier version of this module used "does `new_dir` already have
//! content" as the sole signal for "already migrated, don't touch it
//! again". That has a dead end: `tauri-plugin-window-state` writes
//! `.window-state.json` into `app_config_dir()` on *every* exit,
//! regardless of whether migration ever ran or succeeded. If migration
//! fails (or the process is killed before it runs at all), the app still
//! starts and still exits, `new_dir` ends up with exactly one file that
//! has nothing to do with migration, and the next launch would read
//! "`new_dir` non-empty" as "already migrated" and never try again —
//! silently orphaning the old preferences/session/hot-exit backups
//! forever, with no further error and no further chance to recover.
//!
//! [`migrate`] instead makes the decision exactly once and records it
//! durably in a marker file (`<new_dir>.migration-complete`, sibling of
//! `new_dir`) before ever treating it as final:
//!
//! | marker | `old_dir` | `new_dir`  | action |
//! |--------|-----------|------------|--------|
//! | present | — | — | already decided; no-op |
//! | absent | absent | — | fresh install; write marker, no-op otherwise |
//! | absent | present | empty/absent | full transfer ([`migrate_dir`]); write marker |
//! | absent | present | **non-empty** | merge-recover ([`merge_recover`]): copy only what `new_dir` doesn't already have, never overwrite; write marker |
//!
//! The last row is what closes the dead end above: finding `new_dir`
//! non-empty with no marker no longer means "someone else already
//! migrated, leave it alone" — it means "something (typically
//! window-state) wrote here without migration having completed", so the
//! old data still needs recovering, just without clobbering whatever's
//! already there.
//!
//! ## Durability
//!
//! Every file this module writes (copies during a transfer/merge, and the
//! marker itself) is `fsync`'d individually before the operation that
//! depends on it (verification, or the marker being considered written)
//! proceeds. The three renames that make a decision final — the
//! `.partial` → `new_dir` publish, `old_dir` → `.migrated` retirement,
//! and the marker's own temp-file → final-name rename (via
//! `crate::atomic_write`) — are each followed by an `fsync` of their
//! parent directory on Unix, so the directory entry change itself
//! survives a crash immediately after. Windows has no directory-fsync
//! API (`FlushFileBuffers` doesn't support directory handles portably
//! across Windows versions), so that half is `#[cfg(unix)]` and
//! documented best-effort on Windows: the file-level syncs still apply
//! there, only the "rename itself is crash-durable" guarantee is
//! unavailable.
//!
//! ## Known limitation: concurrent old + new installs
//!
//! The old and new builds use different identifiers, so
//! `tauri-plugin-single-instance`'s lock key differs between them too —
//! an old-identifier install and this one can run at the same time, and
//! if both happen to migrate (or write to `old_dir`/`new_dir`)
//! concurrently their writes can interleave. Not guarded against here (no
//! lock check is implemented); mitigated operationally by telling users
//! in release notes to close the old install before launching this one.

use std::fs::{self, File};
use std::io;
use std::path::{Path, PathBuf};

/// Bundle identifier this app used before the Mojidori rename.
const OLD_IDENTIFIER: &str = "app.plume.editor";

/// Suffix for the durable completion marker file — see the module doc.
const MARKER_SUFFIX: &str = ".migration-complete";

#[derive(Debug, PartialEq, Eq)]
pub enum MigrationOutcome {
    /// The old directory didn't exist; nothing to do. (Returned by both
    /// [`migrate_dir`] and [`migrate`].)
    NoOldData,
    /// [`migrate_dir`] found the new directory already had content and
    /// left everything untouched. Not reachable through [`migrate`] (which
    /// routes a non-empty `new_dir` to [`merge_recover`] instead) — this
    /// variant exists for [`migrate_dir`] callers that want the old,
    /// simpler "do nothing" primitive directly.
    NewAlreadyPresent,
    /// Old data was copied into the new directory and verified; the old
    /// directory was renamed to `<old_dir>.migrated` (kept, never deleted).
    Migrated { files: u64, bytes: u64 },
    /// `new_dir` already had content (with no completion marker to
    /// explain why): every item from `old_dir` that `new_dir` didn't
    /// already have was copied in; nothing already present in `new_dir`
    /// was touched. `old_dir` was renamed to `<old_dir>.migrated`.
    Merged {
        files_copied: u64,
        bytes_copied: u64,
        files_skipped: u64,
    },
    /// The completion marker was already present; the decision was made
    /// on an earlier run and nothing was touched this time.
    AlreadyDecided,
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

/// Copy `src` to `dst` and `fsync` the destination file before returning,
/// so a crash immediately after this call can't leave a copy that looks
/// complete (right length) but has data still sitting in a write cache.
fn copy_file_synced(src: &Path, dst: &Path) -> io::Result<u64> {
    let bytes = fs::copy(src, dst)?;
    File::open(dst)?.sync_all()?;
    Ok(bytes)
}

/// `fsync` a directory so a rename that changed one of its entries is
/// durable across a crash, not just the renamed file/dir's own contents.
/// Unix only — Windows has no portable directory-handle-flush API; this is
/// documented best-effort there, relying solely on the file-level
/// `sync_all()` calls that already happen before any such rename.
#[cfg(unix)]
fn fsync_dir(dir: &Path) -> io::Result<()> {
    File::open(dir)?.sync_all()
}

#[cfg(not(unix))]
fn fsync_dir(_dir: &Path) -> io::Result<()> {
    Ok(())
}

/// Recursively copy every file and subdirectory of `src` into `dst`,
/// creating `dst` (and nested subdirectories) as needed. Each file is
/// synced individually (see [`copy_file_synced`]).
fn copy_dir_recursive(src: &Path, dst: &Path) -> io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let dst_path = dst.join(entry.file_name());
        if file_type.is_dir() {
            copy_dir_recursive(&entry.path(), &dst_path)?;
        } else if file_type.is_file() {
            copy_file_synced(&entry.path(), &dst_path)?;
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

/// Path of the durable completion marker for the migration whose
/// destination is `new_dir` — a sibling file, `<new_dir>.migration-complete`.
fn marker_path(new_dir: &Path) -> PathBuf {
    let name = format!(
        "{}{}",
        new_dir
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("new"),
        MARKER_SUFFIX
    );
    new_dir
        .parent()
        .map(|p| p.join(&name))
        .unwrap_or_else(|| PathBuf::from(&name))
}

/// Write the completion marker durably: temp file + `fsync` + rename (via
/// `crate::atomic_write`), then `fsync` the parent directory too (Unix
/// only — see [`fsync_dir`]) so the rename itself survives a crash right
/// after this returns.
fn write_marker(
    marker_path: &Path,
    source_identifier: &str,
    outcome_label: &str,
) -> Result<(), String> {
    let body = format!(
        "{{\"source_identifier\":\"{source_identifier}\",\"outcome\":\"{outcome_label}\"}}\n"
    );
    crate::atomic_write(marker_path, body.as_bytes()).map_err(|e| {
        format!(
            "failed to write migration marker {}: {e}",
            marker_path.display()
        )
    })?;
    if let Some(parent) = marker_path.parent() {
        let _ = fsync_dir(parent);
    }
    Ok(())
}

/// Rename `old_dir` to `<old_dir>.migrated`, `fsync`ing the parent
/// directory afterwards (Unix only). Failure is logged, not propagated:
/// by the time this is called the migrated/merged data at `new_dir` has
/// already been copied and verified, so failing to set `old_dir` aside is
/// surprising but not a data-loss risk — it shouldn't mask a successful
/// migration by turning it into an `Err`.
fn retire_old_dir(old_dir: &Path) {
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
        eprintln!(
            "migrate: copied data but could not rename {} to {}: {e}",
            old_dir.display(),
            migrated_path.display()
        );
        return;
    }
    if let Some(parent) = migrated_path.parent() {
        let _ = fsync_dir(parent);
    }
}

/// Migrate `old_dir` into `new_dir`.
///
/// - `old_dir` doesn't exist -> [`MigrationOutcome::NoOldData`]; nothing
///   touched.
/// - `new_dir` exists and already has content ->
///   [`MigrationOutcome::NewAlreadyPresent`]; nothing touched (this
///   primitive never overwrites a directory that's already in use — see
///   [`migrate`] for the marker-aware decision that routes this case to
///   [`merge_recover`] instead of stopping here).
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
    if let Some(parent) = new_dir.parent() {
        let _ = fsync_dir(parent);
    }

    retire_old_dir(old_dir);

    Ok(MigrationOutcome::Migrated {
        files: new_files,
        bytes: new_bytes,
    })
}

/// Tracks what [`merge_dir_recursive`] has actually written, so a failure
/// partway through can roll back exactly (and only) what this run added.
#[derive(Default)]
struct MergeProgress {
    /// `(path written under new_dir, expected length)`.
    copied: Vec<(PathBuf, u64)>,
    files_copied: u64,
    bytes_copied: u64,
    files_skipped: u64,
}

/// Recursively copy every file/subdirectory of `src` into `dst` (which
/// must not yet exist), unconditionally — used when merging a subtree that
/// `new_dir` doesn't have at all yet, so there's nothing to collide with.
fn copy_dir_recursive_tracked(
    src: &Path,
    dst: &Path,
    progress: &mut MergeProgress,
) -> io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let dst_path = dst.join(entry.file_name());
        if file_type.is_dir() {
            copy_dir_recursive_tracked(&entry.path(), &dst_path, progress)?;
        } else if file_type.is_file() {
            let bytes = copy_file_synced(&entry.path(), &dst_path)?;
            progress.copied.push((dst_path, bytes));
            progress.files_copied += 1;
            progress.bytes_copied += bytes;
        }
    }
    Ok(())
}

/// Merge `old`'s contents into `new`, item by item, never overwriting
/// anything already present in `new`:
///
/// - A file `old` has that `new` doesn't -> copied in.
/// - A file both have -> left alone (skipped); `new`'s version wins.
/// - A directory both have -> recursed into, merging their contents.
/// - A directory `old` has that `new` doesn't -> the whole subtree is
///   copied in (nothing there to collide with).
/// - A type mismatch (`old` has a file where `new` has a directory, or
///   vice versa) -> skipped entirely; logged, since this shouldn't happen
///   in practice and merging through it would be guessing.
fn merge_dir_recursive(old: &Path, new: &Path, progress: &mut MergeProgress) -> io::Result<()> {
    for entry in fs::read_dir(old)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let src_path = entry.path();
        let dst_path = new.join(entry.file_name());

        if file_type.is_dir() {
            if dst_path.is_dir() {
                merge_dir_recursive(&src_path, &dst_path, progress)?;
            } else if dst_path.exists() {
                eprintln!(
                    "migrate: merge skipped {} — {} exists and is not a directory",
                    src_path.display(),
                    dst_path.display()
                );
                let (skipped, _) = dir_stats(&src_path).unwrap_or((0, 0));
                progress.files_skipped += skipped;
            } else {
                copy_dir_recursive_tracked(&src_path, &dst_path, progress)?;
            }
        } else if file_type.is_file() {
            if dst_path.exists() {
                progress.files_skipped += 1;
            } else {
                if let Some(parent) = dst_path.parent() {
                    fs::create_dir_all(parent)?;
                }
                let bytes = copy_file_synced(&src_path, &dst_path)?;
                progress.copied.push((dst_path, bytes));
                progress.files_copied += 1;
                progress.bytes_copied += bytes;
            }
        }
    }
    Ok(())
}

/// Undo exactly what a failed [`merge_dir_recursive`] run added: remove
/// every file it copied in. Directories it may have created along the way
/// (either as merge targets or as part of a whole-subtree copy) are left
/// in place — they're harmless if empty, and precisely distinguishing "we
/// created this directory" from "it already existed" adds failure modes
/// of its own without a safety benefit worth the complexity.
fn rollback_merge(progress: &MergeProgress) {
    for (path, _) in &progress.copied {
        let _ = fs::remove_file(path);
    }
}

/// Merge-recovery path for [`migrate`]: `new_dir` already has content (see
/// the module doc for why this can happen without migration ever having
/// completed) but there's no completion marker, so `old_dir`'s data still
/// needs recovering — without touching anything already in `new_dir`.
///
/// Copies every item [`merge_dir_recursive`] finds missing from `new_dir`,
/// verifies each copied file is present at its expected length, and only
/// then retires `old_dir` to `<old_dir>.migrated`. On any failure, the
/// files this run copied in are removed again (nothing pre-existing in
/// `new_dir` is ever touched either way), `old_dir` is left completely
/// intact, and `Err` describes the failure — exactly like [`migrate_dir`]'s
/// failure contract, just without a `new_dir` to clean up (there's no
/// staging directory here: writes land directly in `new_dir`, since unlike
/// the full-transfer case there's a live directory to merge into, not an
/// empty one to publish atomically).
fn merge_recover(old_dir: &Path, new_dir: &Path) -> Result<(u64, u64, u64), String> {
    let mut progress = MergeProgress::default();

    if let Err(e) = merge_dir_recursive(old_dir, new_dir, &mut progress) {
        rollback_merge(&progress);
        return Err(format!(
            "failed to merge {} into {}: {e}",
            old_dir.display(),
            new_dir.display()
        ));
    }

    for (path, expected_len) in &progress.copied {
        match fs::metadata(path) {
            Ok(meta) if meta.len() == *expected_len => {}
            Ok(meta) => {
                rollback_merge(&progress);
                return Err(format!(
                    "merge verification mismatch for {}: expected {expected_len} byte(s), found {}",
                    path.display(),
                    meta.len()
                ));
            }
            Err(e) => {
                rollback_merge(&progress);
                return Err(format!(
                    "merge verification failed for {}: {e}",
                    path.display()
                ));
            }
        }
    }

    if let Some(parent) = new_dir.parent() {
        let _ = fsync_dir(parent);
    }

    retire_old_dir(old_dir);

    Ok((
        progress.files_copied,
        progress.bytes_copied,
        progress.files_skipped,
    ))
}

/// Runs the full migration decision matrix — see the module doc's table —
/// guarded by a durable completion marker at `marker_path` so the decision
/// is made **at most once** and this is safe (cheap, even) to call on
/// every launch: once the marker exists, every later call is an immediate
/// no-op.
///
/// `source_identifier` is recorded in the marker for forensic purposes
/// (e.g. distinguishing "fresh install" from "migrated" after the fact);
/// it does not affect the decision itself.
pub fn migrate(
    old_dir: &Path,
    new_dir: &Path,
    marker_path: &Path,
    source_identifier: &str,
) -> Result<MigrationOutcome, String> {
    if marker_path.exists() {
        return Ok(MigrationOutcome::AlreadyDecided);
    }

    if !old_dir.is_dir() {
        write_marker(marker_path, source_identifier, "no_old_data")?;
        return Ok(MigrationOutcome::NoOldData);
    }

    let new_has_content = new_dir.exists() && dir_has_entries(new_dir);

    if !new_has_content {
        return match migrate_dir(old_dir, new_dir)? {
            outcome @ MigrationOutcome::Migrated { .. } => {
                write_marker(marker_path, source_identifier, "migrated")?;
                Ok(outcome)
            }
            // migrate_dir() only returns NoOldData/NewAlreadyPresent when
            // its own preconditions (just re-checked here) don't hold;
            // given old_dir is confirmed a directory and new_dir confirmed
            // empty, neither should occur. Handled anyway for
            // exhaustiveness, deliberately without writing a marker, so a
            // future call re-evaluates from scratch instead of being
            // permanently short-circuited by an outcome this matrix didn't
            // intend.
            other => Ok(other),
        };
    }

    let (files_copied, bytes_copied, files_skipped) = merge_recover(old_dir, new_dir)?;
    write_marker(marker_path, source_identifier, "merged")?;
    Ok(MigrationOutcome::Merged {
        files_copied,
        bytes_copied,
        files_skipped,
    })
}

/// Production entry point: runs [`migrate`] for `identifier` (this build's
/// bundle identifier, e.g. `app.mojidori.editor`), computing `new_dir` as
/// `dirs::config_dir().join(identifier)` — the same computation
/// `tauri::AppHandle::path().app_config_dir()` does internally (same
/// crate, same version; see the module doc) — and `old_dir` via
/// [`old_config_dir`].
///
/// Deliberately takes a plain identifier string rather than an
/// `AppHandle`, so it can run *before* a `tauri::Builder` exists at all:
/// `tauri-plugin-window-state` loads its on-disk cache as part of its own
/// plugin setup, which runs during `Builder::build()` — strictly before
/// this app's `.setup()` closure ever gets a chance to run. Migrating
/// there (the previous design) is too late: it exists, moving the plugin's
/// *registration* later instead doesn't work either — see `lib.rs`'s
/// `run()` for why. Running here, ahead of the whole `Builder`, is what
/// makes the ordering actually correct.
pub fn run(identifier: &str) -> Result<MigrationOutcome, String> {
    let new_dir = dirs::config_dir()
        .ok_or_else(|| "cannot resolve config dir".to_string())?
        .join(identifier);
    let Some(old_dir) = old_config_dir(&new_dir) else {
        // No parent directory to derive the legacy path from (a
        // degenerate config_dir()); nothing to migrate.
        return Ok(MigrationOutcome::NoOldData);
    };
    let marker = marker_path(&new_dir);

    let outcome = migrate(&old_dir, &new_dir, &marker, OLD_IDENTIFIER)?;
    match &outcome {
        MigrationOutcome::Migrated { files, bytes } => {
            eprintln!(
                "migrate: moved {files} file(s), {bytes} byte(s) from {} to {}",
                old_dir.display(),
                new_dir.display()
            );
        }
        MigrationOutcome::Merged {
            files_copied,
            bytes_copied,
            files_skipped,
        } => {
            eprintln!(
                "migrate: merge-recovered {files_copied} file(s)/{bytes_copied} byte(s) from {} into {} ({files_skipped} item(s) already present were kept as-is)",
                old_dir.display(),
                new_dir.display()
            );
        }
        MigrationOutcome::NoOldData
        | MigrationOutcome::AlreadyDecided
        | MigrationOutcome::NewAlreadyPresent => {}
    }
    Ok(outcome)
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

    #[test]
    fn marker_present_short_circuits_everything() {
        let root = temp_dir("marker-short-circuits");
        let old_dir = root.join("app.plume.editor");
        let new_dir = root.join("app.mojidori.editor");
        let marker = marker_path(&new_dir);

        fs::create_dir_all(&old_dir).unwrap();
        fs::write(old_dir.join("preferences.json"), b"old").unwrap();
        fs::write(
            &marker,
            b"{\"source_identifier\":\"app.plume.editor\",\"outcome\":\"migrated\"}\n",
        )
        .unwrap();

        let outcome = migrate(&old_dir, &new_dir, &marker, OLD_IDENTIFIER).unwrap();
        assert_eq!(outcome, MigrationOutcome::AlreadyDecided);

        // Nothing touched: old_dir still exactly where it was, new_dir
        // never created.
        assert!(old_dir.is_dir());
        assert_eq!(fs::read(old_dir.join("preferences.json")).unwrap(), b"old");
        assert!(!new_dir.exists());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn fresh_install_writes_marker_and_touches_nothing_else() {
        let root = temp_dir("fresh-install");
        let old_dir = root.join("app.plume.editor");
        let new_dir = root.join("app.mojidori.editor");
        let marker = marker_path(&new_dir);

        let outcome = migrate(&old_dir, &new_dir, &marker, OLD_IDENTIFIER).unwrap();
        assert_eq!(outcome, MigrationOutcome::NoOldData);
        assert!(marker.is_file());
        assert!(fs::read_to_string(&marker).unwrap().contains("no_old_data"));
        assert!(!old_dir.exists());
        assert!(!new_dir.exists());

        // Rerunning is now a pure no-op via the marker, not a second
        // "fresh install" decision.
        let second = migrate(&old_dir, &new_dir, &marker, OLD_IDENTIFIER).unwrap();
        assert_eq!(second, MigrationOutcome::AlreadyDecided);

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn full_migration_path_writes_marker() {
        let root = temp_dir("full-migration-marker");
        let old_dir = root.join("app.plume.editor");
        let new_dir = root.join("app.mojidori.editor");
        let marker = marker_path(&new_dir);

        fs::create_dir_all(&old_dir).unwrap();
        fs::write(old_dir.join("preferences.json"), b"data").unwrap();

        let outcome = migrate(&old_dir, &new_dir, &marker, OLD_IDENTIFIER).unwrap();
        assert!(matches!(
            outcome,
            MigrationOutcome::Migrated { files: 1, .. }
        ));
        assert!(marker.is_file());
        assert!(fs::read_to_string(&marker).unwrap().contains("migrated"));
        assert_eq!(fs::read(new_dir.join("preferences.json")).unwrap(), b"data");

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn merge_recovers_missing_items_without_overwriting_existing_ones() {
        let root = temp_dir("merge-basic");
        let old_dir = root.join("app.plume.editor");
        let new_dir = root.join("app.mojidori.editor");

        fs::create_dir_all(&old_dir).unwrap();
        fs::write(old_dir.join("preferences.json"), b"old prefs").unwrap();
        fs::write(old_dir.join("session.json"), b"old session").unwrap();

        fs::create_dir_all(&new_dir).unwrap();
        // Already present in new_dir under a name old_dir also has --
        // must survive untouched.
        fs::write(new_dir.join("preferences.json"), b"NEW live prefs").unwrap();

        let (files_copied, bytes_copied, files_skipped) =
            merge_recover(&old_dir, &new_dir).unwrap();
        assert_eq!(files_copied, 1); // session.json only
        assert_eq!(bytes_copied, b"old session".len() as u64);
        assert_eq!(files_skipped, 1); // preferences.json

        // Existing file untouched.
        assert_eq!(
            fs::read(new_dir.join("preferences.json")).unwrap(),
            b"NEW live prefs"
        );
        // Missing file recovered.
        assert_eq!(
            fs::read(new_dir.join("session.json")).unwrap(),
            b"old session"
        );
        assert!(root.join("app.plume.editor.migrated").is_dir());
        assert!(!old_dir.exists());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn merge_recovers_a_whole_missing_nested_subdirectory() {
        let root = temp_dir("merge-nested");
        let old_dir = root.join("app.plume.editor");
        let new_dir = root.join("app.mojidori.editor");

        fs::create_dir_all(old_dir.join("backups")).unwrap();
        fs::write(old_dir.join("backups").join("tab-1.bak"), b"unsaved buffer").unwrap();

        fs::create_dir_all(&new_dir).unwrap();
        fs::write(new_dir.join(".window-state.json"), b"{\"main\":{}}").unwrap();

        let (files_copied, _, files_skipped) = merge_recover(&old_dir, &new_dir).unwrap();
        assert_eq!(files_copied, 1);
        assert_eq!(files_skipped, 0);

        assert_eq!(
            fs::read(new_dir.join("backups").join("tab-1.bak")).unwrap(),
            b"unsaved buffer"
        );
        // The unrelated file that was already there is untouched.
        assert_eq!(
            fs::read(new_dir.join(".window-state.json")).unwrap(),
            b"{\"main\":{}}"
        );

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    #[cfg(unix)]
    fn merge_failure_rolls_back_only_what_it_added_and_leaves_old_dir_intact() {
        let root = temp_dir("merge-failure-rollback");
        let old_dir = root.join("app.plume.editor");
        let new_dir = root.join("app.mojidori.editor");

        // A top-level file new_dir doesn't have -- should be copyable on
        // its own merits, independent of what else fails.
        fs::create_dir_all(&old_dir).unwrap();
        fs::write(old_dir.join("recoverable.json"), b"copyable on its own").unwrap();
        // A subdirectory *both* old_dir and new_dir already have, so the
        // merge recurses into it rather than whole-subtree-copying it --
        // and new_dir's copy of that subdirectory is read-only, so the
        // nested file's copy fails there specifically.
        fs::create_dir_all(old_dir.join("shared_subdir")).unwrap();
        fs::write(
            old_dir.join("shared_subdir").join("blocked.txt"),
            b"never makes it in",
        )
        .unwrap();

        fs::create_dir_all(&new_dir).unwrap();
        fs::write(
            new_dir.join(".window-state.json"),
            b"pre-existing, must survive",
        )
        .unwrap();
        fs::create_dir_all(new_dir.join("shared_subdir")).unwrap();
        let mut perms = fs::metadata(new_dir.join("shared_subdir"))
            .unwrap()
            .permissions();
        perms.set_readonly(true);
        fs::set_permissions(new_dir.join("shared_subdir"), perms).unwrap();

        let result = merge_recover(&old_dir, &new_dir);

        let mut perms = fs::metadata(new_dir.join("shared_subdir"))
            .unwrap()
            .permissions();
        #[allow(clippy::permissions_set_readonly_false)]
        perms.set_readonly(false);
        fs::set_permissions(new_dir.join("shared_subdir"), perms).unwrap();

        assert!(result.is_err(), "expected an Err, got {result:?}");

        // old_dir is completely intact -- merge failure never touches the
        // source, and never retires it.
        assert!(old_dir.is_dir());
        assert_eq!(
            fs::read(old_dir.join("recoverable.json")).unwrap(),
            b"copyable on its own"
        );
        assert_eq!(
            fs::read(old_dir.join("shared_subdir").join("blocked.txt")).unwrap(),
            b"never makes it in"
        );

        // The pre-existing file survives, and whatever this attempt
        // managed to copy before failing was rolled back rather than left
        // half-merged.
        assert_eq!(
            fs::read(new_dir.join(".window-state.json")).unwrap(),
            b"pre-existing, must survive"
        );
        assert!(!new_dir.join("recoverable.json").exists());

        let _ = fs::remove_dir_all(&root);
    }

    /// The exact regression scenario this whole state machine exists for:
    /// a migration attempt that failed (or never ran) left `new_dir` with
    /// exactly one file that has nothing to do with migration --
    /// `tauri-plugin-window-state` writing `.window-state.json` on exit is
    /// the real-world cause, reproduced here directly rather than via a
    /// live plugin. No marker was written (the failure happened before
    /// [`migrate`] ever got to that step). The next launch must recover
    /// the old data via merge, and must not overwrite the window-state
    /// file that's already there.
    #[test]
    fn recovers_via_merge_after_a_failed_migration_left_a_window_state_file() {
        let root = temp_dir("window-state-regression");
        let old_dir = root.join("app.plume.editor");
        let new_dir = root.join("app.mojidori.editor");
        let marker = marker_path(&new_dir);

        fs::create_dir_all(&old_dir).unwrap();
        fs::write(old_dir.join("preferences.json"), b"{\"theme\":\"dark\"}").unwrap();
        fs::create_dir_all(old_dir.join("backups")).unwrap();
        fs::write(
            old_dir.join("backups").join("tab-1.bak"),
            b"unsaved hot-exit content",
        )
        .unwrap();

        // Simulate: migration failed/never ran on the previous launch, the
        // app started anyway, and tauri-plugin-window-state wrote its
        // cache into new_dir on exit. No marker exists.
        fs::create_dir_all(&new_dir).unwrap();
        fs::write(
            new_dir.join(".window-state.json"),
            b"{\"main\":{\"width\":1080,\"height\":720}}",
        )
        .unwrap();
        assert!(!marker.exists());

        // Next launch: migrate() runs again.
        let outcome = migrate(&old_dir, &new_dir, &marker, OLD_IDENTIFIER).unwrap();
        assert!(
            matches!(
                outcome,
                MigrationOutcome::Merged {
                    files_copied: 2,
                    ..
                }
            ),
            "expected a 2-file merge (preferences.json + backups/tab-1.bak), got {outcome:?}"
        );

        // The window-state file was never overwritten.
        assert_eq!(
            fs::read(new_dir.join(".window-state.json")).unwrap(),
            b"{\"main\":{\"width\":1080,\"height\":720}}"
        );
        // The old data is now recovered into new_dir.
        assert_eq!(
            fs::read(new_dir.join("preferences.json")).unwrap(),
            b"{\"theme\":\"dark\"}"
        );
        assert_eq!(
            fs::read(new_dir.join("backups").join("tab-1.bak")).unwrap(),
            b"unsaved hot-exit content"
        );
        // old_dir retired, marker written -- next launch is a no-op.
        assert!(!old_dir.exists());
        assert!(root.join("app.plume.editor.migrated").is_dir());
        assert!(marker.is_file());
        assert_eq!(
            migrate(&old_dir, &new_dir, &marker, OLD_IDENTIFIER).unwrap(),
            MigrationOutcome::AlreadyDecided
        );

        let _ = fs::remove_dir_all(&root);
    }
}
