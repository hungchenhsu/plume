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
//! Every file this module writes is `fsync`'d individually before the
//! operation that depends on it (verification, or the marker being
//! considered written) proceeds. Where that file lands matters just as
//! much as the sync itself:
//!
//! - Full-transfer ([`migrate_dir`]) copies into the `.partial` staging
//!   directory, which is wholly discarded and rebuilt from scratch on any
//!   retry — a torn file left there by a crash is simply never looked at
//!   again, so a plain `fsync`-after-copy ([`copy_file_synced`]) is enough.
//! - Merge-recovery ([`merge_recover`]) writes directly into the *live*
//!   `new_dir`, which is never discarded and whose "already exists" state
//!   is exactly the never-overwrite signal the whole merge is built on. A
//!   crash mid-copy there would otherwise leave a file that exists (at its
//!   final name) but is truncated, which a later run would then protect
//!   forever as if it were real data. So every merge-copied file instead
//!   lands via [`copy_file_atomic_no_overwrite`]: written to a
//!   same-directory `<name>.merge-tmp`, `fsync`'d, then `rename`'d onto the
//!   final path only once complete. A crash can now only ever leave the
//!   *temp* file torn — recognizable by its suffix, discarded and retried
//!   on the next run — never the final one.
//!
//! The renames that make a decision final — the `.partial` → `new_dir`
//! publish, each merge-copied file's temp → final rename, `old_dir` →
//! `.migrated` retirement, and the marker's own temp-file → final-name
//! rename (via `crate::atomic_write`) — are, for the three *directory*-level
//! ones, each followed by an `fsync` of their parent directory on Unix, so
//! the directory entry change itself survives a crash immediately after.
//! Windows has no directory-fsync API (`FlushFileBuffers` doesn't support
//! directory handles portably across Windows versions), so that half is
//! `#[cfg(unix)]` and documented best-effort on Windows: the file-level
//! syncs still apply there, only the "rename itself is crash-durable"
//! guarantee is unavailable.
//!
//! ## Concurrency: two instances of *this* build racing to migrate
//!
//! [`run`] moves the whole decision ahead of `tauri::Builder` (see its own
//! doc), which means it runs before `tauri-plugin-single-instance`
//! (Windows/Linux) has registered its own guard — and macOS has no such
//! plugin in this codebase regardless. Two processes of this same build
//! can therefore both reach [`migrate`] at once. [`migrate_locked`] closes
//! that race with a blocking OS-level advisory lock (`std::fs::File::lock`,
//! stable since Rust 1.89 — this repo has no MSRV pin and CI installs
//! current `stable`, so no new dependency was needed) held for the whole
//! decision: the second process simply waits for the first to finish, and
//! by the time it acquires the lock the first's marker (if migration
//! completed) already exists, so it sees
//! [`MigrationOutcome::AlreadyDecided`] and does nothing. See
//! [`migrate_locked`]'s doc for the concrete data-loss scenario this
//! prevents.
//!
//! ## Known limitation: concurrent old + new *installs*
//!
//! The lock above only helps two processes of *this* build coordinate —
//! it says nothing about an old-identifier (`app.plume.editor`) install of
//! the pre-rename app running at the same time. The old and new builds use
//! different identifiers, so `tauri-plugin-single-instance`'s lock key
//! differs between them too, and the old binary has no idea this lock file
//! exists at all. If both happen to write to `old_dir`/`new_dir`
//! concurrently their writes can still interleave. Not guarded against
//! here (doing so would require changes to a binary that's already
//! shipped); mitigated operationally by telling users in release notes to
//! close the old install before launching this one.

use std::collections::HashSet;
use std::fs::{self, File};
use std::io;
use std::path::{Path, PathBuf};

/// Bundle identifier this app used before the Mojidori rename.
const OLD_IDENTIFIER: &str = "app.plume.editor";

/// Suffix for the durable completion marker file — see the module doc.
const MARKER_SUFFIX: &str = ".migration-complete";

/// Suffix for the OS-level advisory lock file that serializes concurrent
/// migration attempts — see [`acquire_migration_lock`] and the module
/// doc's Concurrency section.
const LOCK_SUFFIX: &str = ".migration-lock";

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

/// Create `dst` fresh for writing, with permissions that are never wider
/// than `src_permissions` at any point after this call returns — not even
/// during the brief window before the caller writes any bytes or calls
/// `fs::set_permissions` again.
///
/// - Unix: `src_permissions`' mode is passed directly to `open()` (via
///   `OpenOptionsExt::mode`), so `dst` is created with that mode from the
///   very first instant it exists. The kernel still masks the requested
///   mode against the process umask, but masking only *removes* bits, so
///   the result is never more permissive than requested — a `0600`
///   source can never produce a `dst` that's briefly `0644`. It can,
///   however, come out *more* restrictive than `src` if the umask clears
///   bits `src` actually had (e.g. a `0664` source under a `0022` umask
///   lands at `0644`); callers that care about an exact match still call
///   `fs::set_permissions` again after writing to restore any bits the
///   umask stripped — safe to do afterwards specifically because it can
///   only ever *loosen* back toward `src`'s original mode, never beyond
///   it, and by then the file's content is already fully written.
/// - Windows: there's no mode to pass at creation time — only the
///   coarse-grained readonly attribute, which would also block writing
///   the copy's own bytes if applied up front. This falls back to a plain
///   `File::create`; the caller's later `fs::set_permissions` (readonly
///   attribute only) is the sole mechanism there. Accepted platform
///   difference: Windows' readonly attribute isn't a confidentiality
///   boundary the way Unix mode bits are, so there's nothing narrower to
///   protect during the write window on Windows in the first place.
#[cfg(unix)]
fn create_file_no_wider_than_source(
    dst: &Path,
    src_permissions: &fs::Permissions,
) -> io::Result<File> {
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
    fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(src_permissions.mode())
        .open(dst)
}

#[cfg(not(unix))]
fn create_file_no_wider_than_source(
    dst: &Path,
    _src_permissions: &fs::Permissions,
) -> io::Result<File> {
    File::create(dst)
}

/// Copy `src` to `dst` and `fsync` the destination file before returning,
/// so a crash immediately after this call can't leave a copy that looks
/// complete (right length) but has data still sitting in a write cache.
///
/// Writes via a handle opened by [`create_file_no_wider_than_source`] and
/// `fsync`s *that same* handle, rather than `fs::copy` followed by a
/// fresh `File::open(dst)` + `sync_all()`: on Windows, `FlushFileBuffers`
/// (what `sync_all()` calls there) requires the handle to have been
/// opened with write access, and a bare `File::open` is read-only — that
/// combination fails with `ERROR_ACCESS_DENIED` (os error 5) on every
/// write, which is invisible on Unix (`fsync` on a read-only fd is
/// perfectly legal there) and so only ever surfaces on Windows.
///
/// `dst`'s permissions are set to match `src`'s twice: once at creation
/// (via `create_file_no_wider_than_source`, so `dst` is never wider than
/// `src` even for the instant before any bytes are written) and once more
/// after writing (to restore any bits the process umask stripped from the
/// first attempt, now that content is in place). Without either, a user's
/// `0600` session/hot-exit-backup file would spend part of migration
/// readable by every other local user — the first fixes the write-time
/// window, the second exactness. Cross-platform: on Unix this is mode
/// bits; on Windows the same `fs::set_permissions` API carries the
/// readonly attribute across instead.
fn copy_file_synced(src: &Path, dst: &Path) -> io::Result<u64> {
    let mut reader = File::open(src)?;
    let src_permissions = fs::metadata(src)?.permissions();
    let mut writer = create_file_no_wider_than_source(dst, &src_permissions)?;
    let bytes = io::copy(&mut reader, &mut writer)?;
    fs::set_permissions(dst, src_permissions)?;
    writer.sync_all()?;
    Ok(bytes)
}

/// `fsync` a directory so a rename that changed one of its entries is
/// durable across a crash, not just the renamed file/dir's own contents.
/// Unix only — Windows has no portable directory-handle-flush API; this is
/// documented best-effort there, relying solely on the file-level
/// `sync_all()` calls that already happen before any such rename. (Unlike
/// [`copy_file_synced`]'s pitfall above, this one specific case is fine as
/// a read-only `File::open`: it's `#[cfg(unix)]`-only and never runs on
/// Windows at all, so the write-handle requirement never applies to it.)
#[cfg(unix)]
fn fsync_dir(dir: &Path) -> io::Result<()> {
    File::open(dir)?.sync_all()
}

#[cfg(not(unix))]
fn fsync_dir(_dir: &Path) -> io::Result<()> {
    Ok(())
}

/// Recursively `fsync` every directory under (and including) `root`, so
/// every directory-entry within the tree — not just `root`'s own entry in
/// *its* parent — survives a crash. Unix only, see [`fsync_dir`]. Used
/// after [`migrate_dir`]'s publish rename, where `root` is the
/// just-published `new_dir`: the whole tree is what this run just wrote,
/// so walking all of it is bounded by the migration's own size (unlike
/// merge-recovery, which must avoid walking `new_dir` wholesale — it can
/// contain unrelated, possibly large pre-existing live data — and instead
/// fsyncs only the specific directories it touched).
#[cfg(unix)]
fn fsync_dir_tree(root: &Path) {
    let _ = fsync_dir(root);
    if let Ok(entries) = fs::read_dir(root) {
        for entry in entries.flatten() {
            if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                fsync_dir_tree(&entry.path());
            }
        }
    }
}

#[cfg(not(unix))]
fn fsync_dir_tree(_root: &Path) {}

/// `fs::create_dir_all(dst)`, then immediately set `dst`'s permissions to
/// match `src`'s — closing the window (rather than fixing it up only
/// after `dst` is fully populated) so a directory whose source is more
/// restrictive than the process umask is never briefly more permissive
/// than intended while its contents are being written. `dst` is
/// necessarily created and owned by this process, so this assumes `src`'s
/// mode still leaves the owner able to write into it (true for every real
/// directory this module ever copies — its own config/backup
/// directories, always created rwx-for-owner by this app or its plugins);
/// a source directory stripped of owner write access would fail here,
/// but that's not a scenario this module's own data can produce.
fn create_dir_matching_permissions(src: &Path, dst: &Path) -> io::Result<()> {
    fs::create_dir_all(dst)?;
    fs::set_permissions(dst, fs::metadata(src)?.permissions())
}

/// Recursively copy every file and subdirectory of `src` into `dst`,
/// creating `dst` (and nested subdirectories) as needed, each with `src`'s
/// own permissions (see [`create_dir_matching_permissions`] — every
/// directory level may have a different mode, so this is done per level,
/// not just once at the top). Each file is synced individually (see
/// [`copy_file_synced`], which does the equivalent for file permissions).
fn copy_dir_recursive(src: &Path, dst: &Path) -> io::Result<()> {
    create_dir_matching_permissions(src, dst)?;
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

/// Path of the OS-level advisory lock file for the migration whose
/// destination is `new_dir` — a sibling file, `<new_dir>.migration-lock`.
/// Deliberately a sibling of `new_dir`, not a file inside it: a file
/// inside `new_dir` would corrupt the very "is `new_dir` empty" check
/// [`migrate`] and [`migrate_dir`] both make (and would need to be
/// excluded from every count/verify/publish-rename step besides).
fn lock_path(new_dir: &Path) -> PathBuf {
    let name = format!(
        "{}{}",
        new_dir
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("new"),
        LOCK_SUFFIX
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
    // Fsync every directory *inside* the newly-published tree too (e.g.
    // `new_dir/backups/`) — the parent fsync above only durably records
    // that `new_dir` itself exists, not that its interior directories
    // durably contain the entries the copy just wrote into them. Bounded
    // by the size of what this run just migrated (it's exactly the tree
    // that was just published, nothing else), unlike merge-recovery's
    // equivalent step, which must avoid walking `new_dir` wholesale.
    fsync_dir_tree(new_dir);

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
    /// Every directory that received a new entry (a copied file, or a
    /// freshly created subdirectory) during this run, deduplicated. Each
    /// gets `fsync`'d before [`merge_recover`] hands back success, so a
    /// crash right after can't leave the *directory entry* for a
    /// successfully-copied, successfully-verified file un-persisted —
    /// see the module doc's Durability section.
    touched_dirs: HashSet<PathBuf>,
}

/// Suffix for the per-file staging temp used while merge-copying a single
/// file into place — see [`copy_file_atomic_no_overwrite`].
const MERGE_TMP_SUFFIX: &str = ".merge-tmp";

/// Path of the staging temp file for a merge-copy landing at `dst`.
fn merge_tmp_path(dst: &Path) -> PathBuf {
    let mut name = dst
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("file")
        .to_string();
    name.push_str(MERGE_TMP_SUFFIX);
    dst.with_file_name(name)
}

/// Copy `src` to `dst` durably and atomically, *without ever overwriting an
/// existing `dst`*: write to a same-directory temp file
/// (`<dst-name>.merge-tmp`), `fsync` it, then `rename` it onto `dst` only
/// if `dst` still doesn't exist.
///
/// Unlike [`copy_file_synced`] (used by the full-transfer path, where
/// files land in a `.partial` staging directory that's wholly discarded
/// and rebuilt from scratch on any retry), merge-recovery writes directly
/// into the live `new_dir` — a crash mid-`fs::copy` there would leave a
/// file that *exists* at its final path but is truncated/incomplete, and
/// on the next run `merge_dir_recursive`'s "already exists, skip"
/// never-overwrite rule would then protect that torn file forever, mistaking
/// it for real data instead of retrying. Landing every file via a
/// same-named-but-suffixed temp + atomic rename means a crash can only ever
/// leave the *temp* file torn, never the final one — the final path either
/// doesn't exist yet (safe to retry) or holds a complete, verified copy.
///
/// Any pre-existing temp file at the computed path is discarded before
/// this attempt starts — it can only be debris from an interrupted
/// previous attempt at this exact file. Returns `Ok(None)` (temp discarded,
/// nothing written) if `dst` already exists — either found so up front, or
/// found so in a final check right before the rename — rather than ever
/// overwriting it.
fn copy_file_atomic_no_overwrite(src: &Path, dst: &Path) -> io::Result<Option<u64>> {
    if dst.exists() {
        return Ok(None);
    }
    let tmp = merge_tmp_path(dst);
    let _ = fs::remove_file(&tmp);

    // Written and synced via the same write-mode handle, not `fs::copy`
    // followed by a fresh read-only `File::open` + `sync_all()` — see
    // `copy_file_synced`'s doc comment for why that combination fails on
    // Windows (`ERROR_ACCESS_DENIED`) despite working fine on Unix. The
    // temp file is created via `create_file_no_wider_than_source` (never
    // wider than `src` even for the instant before any bytes land) and
    // has `src`'s permissions set again after writing (restoring any bits
    // the umask stripped) before the rename publishes it under `dst`'s
    // final name — same two-step rationale as `copy_file_synced`.
    let write_result = (|| -> io::Result<u64> {
        let mut reader = File::open(src)?;
        let src_permissions = fs::metadata(src)?.permissions();
        let mut writer = create_file_no_wider_than_source(&tmp, &src_permissions)?;
        let bytes = io::copy(&mut reader, &mut writer)?;
        fs::set_permissions(&tmp, src_permissions)?;
        writer.sync_all()?;
        Ok(bytes)
    })();
    let bytes = match write_result {
        Ok(bytes) => bytes,
        Err(e) => {
            let _ = fs::remove_file(&tmp);
            return Err(e);
        }
    };
    if dst.exists() {
        let _ = fs::remove_file(&tmp);
        return Ok(None);
    }
    match fs::rename(&tmp, dst) {
        Ok(()) => Ok(Some(bytes)),
        Err(e) => {
            let _ = fs::remove_file(&tmp);
            Err(e)
        }
    }
}

/// Record that `path`'s *parent* directory gained a new entry (`path`
/// itself — a copied-in file, or a freshly created subdirectory) and
/// therefore needs an `fsync` before this migration step is considered
/// durable. Call this at every point that creates a filesystem entry
/// under `new_dir`, so [`merge_recover`]'s final fsync pass never misses
/// one — see the module doc's Durability section.
///
/// This only ever needs to record the *parent*: `path` itself, if it's a
/// directory, becomes someone else's `parent` in a later call in its own
/// right (either a file placed inside it, or a further-nested
/// subdirectory), so its own turn to be recorded happens naturally as the
/// walk continues.
fn record_touched_parent(touched_dirs: &mut HashSet<PathBuf>, path: &Path) {
    if let Some(parent) = path.parent() {
        touched_dirs.insert(parent.to_path_buf());
    }
}

/// Recursively copy every file/subdirectory of `src` into `dst`, used when
/// merging a subtree that `new_dir` doesn't have at all yet. `dst` may
/// already partially exist here (not just be freshly created) if a
/// previous merge attempt was interrupted partway through this same
/// subtree; each file is still placed via [`copy_file_atomic_no_overwrite`],
/// so a file already correctly in place from that earlier attempt is left
/// alone (never re-copied, never overwritten) rather than assumed absent.
fn copy_dir_recursive_tracked(
    src: &Path,
    dst: &Path,
    progress: &mut MergeProgress,
) -> io::Result<()> {
    // `create_dir_matching_permissions` is safe to call even when `dst`
    // already exists (from an interrupted earlier attempt at this same
    // subtree, per this function's own doc): `create_dir_all` is already
    // a no-op then, and re-applying `src`'s permissions is idempotent —
    // including retroactively fixing up a directory an *older*, buggy
    // build of this code left with umask-derived permissions instead.
    create_dir_matching_permissions(src, dst)?;
    progress.touched_dirs.insert(dst.to_path_buf());
    // `dst` is itself a brand new entry in *its own* parent's directory
    // listing (e.g. `new_dir` gaining a `backups` entry it didn't have
    // before) -- distinct from `dst`'s own interior contents, and easy to
    // miss: the line above only covers "fsync `dst` so its own future
    // children are durable", not "fsync whoever `dst` just became a child
    // of".
    record_touched_parent(&mut progress.touched_dirs, dst);
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let dst_path = dst.join(entry.file_name());
        if file_type.is_dir() {
            copy_dir_recursive_tracked(&entry.path(), &dst_path, progress)?;
        } else if file_type.is_file() {
            if let Some(bytes) = copy_file_atomic_no_overwrite(&entry.path(), &dst_path)? {
                progress.copied.push((dst_path, bytes));
                progress.files_copied += 1;
                progress.bytes_copied += bytes;
            }
            // `None`: `dst_path` already existed -- durably placed there by
            // an earlier, interrupted attempt at this same subtree (that
            // placement was itself atomic, so trusting it is safe and
            // avoids redundant work).
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
                record_touched_parent(&mut progress.touched_dirs, &dst_path);
                match copy_file_atomic_no_overwrite(&src_path, &dst_path)? {
                    Some(bytes) => {
                        progress.copied.push((dst_path, bytes));
                        progress.files_copied += 1;
                        progress.bytes_copied += bytes;
                    }
                    None => {
                        // dst_path came into existence between the check
                        // above and the copy (not expected in this
                        // single-threaded flow, but never overwrite
                        // either way).
                        progress.files_skipped += 1;
                    }
                }
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

    // Unlike migrate_dir's single publish rename (whose containing
    // directory entry alone tells the whole story), merge-recovery places
    // files one at a time via per-file renames scattered across
    // `new_dir`'s own tree — including newly-created nested directories
    // like `backups/`. Fsyncing only `new_dir`'s parent (below) would
    // durably record that `new_dir` itself exists, but says nothing about
    // whether its *interior* directories durably contain the entries this
    // run just added. Fsync every directory this run actually touched
    // (deduplicated) before returning success, so a crash right after
    // can't leave the completion marker (written next, by the caller)
    // durable while one of the files it vouches for has quietly lost its
    // directory entry.
    for dir in &progress.touched_dirs {
        let _ = fsync_dir(dir);
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

/// Acquire the OS-level exclusive advisory lock at `lock_path`, creating
/// the lock file (and its parent directory) if needed, and **blocking**
/// until it's held. Returns the open `File` — the lock is held for as
/// long as that value stays alive, and is released automatically (by the
/// OS, on every platform this targets) when it drops, including on every
/// early-return path via `?`. There is no explicit `unlock()` call here;
/// none is needed.
///
/// The lock file itself is created once and then left in place forever —
/// it is never deleted. Deleting it would reopen exactly the race this
/// exists to close (a second process could recreate it and lock a
/// different underlying file than a first process already holds a lock
/// on), and an empty, permanently-lingering marker-adjacent file is
/// harmless.
fn acquire_migration_lock(lock_path: &Path) -> Result<File, String> {
    if let Some(parent) = lock_path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let file = fs::OpenOptions::new()
        .create(true)
        // The lock file's content (there is none — it's a 0-byte marker)
        // is irrelevant; explicit about not truncating an existing one on
        // every open regardless, since the lock semantics don't depend on
        // it either way.
        .truncate(false)
        .write(true)
        .open(lock_path)
        .map_err(|e| format!("cannot open migration lock {}: {e}", lock_path.display()))?;
    file.lock()
        .map_err(|e| format!("cannot acquire migration lock {}: {e}", lock_path.display()))?;
    Ok(file)
}

/// [`migrate`], wrapped in the OS-level advisory lock at `lock_path` for
/// the whole duration of the call.
///
/// Moving migration ahead of the whole `tauri::Builder` (see [`run`])
/// means it now runs *before* `tauri-plugin-single-instance` (Windows/
/// Linux) has had any chance to register — that plugin's own guard
/// against a second process getting this far simply isn't active yet.
/// Two processes of this same build can therefore both reach here at
/// once: a double-click launch, a file-association open racing an
/// already-in-flight startup, or (macOS has no single-instance plugin at
/// all in this codebase) any double-launch there. Without a lock, both
/// could observe "no marker yet" and both enter [`migrate`] concurrently
/// — e.g. one finishes a merge-recovery and writes the marker while the
/// other, mid-merge itself, hits an unrelated failure and rolls back
/// *its* copied files, deleting some of the first process's just-placed
/// data out from under it. The marker then exists, so every future launch
/// is permanently short-circuited past ever noticing files are missing.
///
/// Blocking on the lock instead makes the second process simply wait for
/// the first to finish; by the time it acquires the lock, the first
/// process's marker (if migration completed) is already there, so it
/// sees [`MigrationOutcome::AlreadyDecided`] and does nothing.
pub fn migrate_locked(
    old_dir: &Path,
    new_dir: &Path,
    marker_path: &Path,
    lock_path: &Path,
    source_identifier: &str,
) -> Result<MigrationOutcome, String> {
    let _lock = acquire_migration_lock(lock_path)?;
    migrate(old_dir, new_dir, marker_path, source_identifier)
}

/// Production entry point: runs [`migrate_locked`] for `identifier` (this
/// build's bundle identifier, e.g. `app.mojidori.editor`), computing
/// `new_dir` as `dirs::config_dir().join(identifier)` — the same
/// computation `tauri::AppHandle::path().app_config_dir()` does internally
/// (same crate, same version; see the module doc) — and `old_dir` via
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
/// makes the ordering actually correct — but it's also exactly why
/// [`migrate_locked`]'s own lock is necessary rather than relying on
/// `tauri-plugin-single-instance`; see that function's doc.
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
    let lock = lock_path(&new_dir);

    let outcome = migrate_locked(&old_dir, &new_dir, &marker, &lock, OLD_IDENTIFIER)?;
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
    fn merge_tracks_new_dir_itself_as_touched_when_copying_a_whole_missing_subtree() {
        // Regression for a gap in the fix above: copying a whole missing
        // subtree (e.g. `backups/`) into new_dir must also mark `new_dir`
        // itself as touched -- `backups` is a brand new entry in
        // *new_dir's own* directory listing, not just a directory whose
        // own interior needs flushing. Missing this meant a crash right
        // after a successful, verified, marker-written merge could still
        // lose the `backups` directory *entry* on Unix (the file data and
        // the `backups`/`nested` levels themselves were tracked; `new_dir`
        // -> `backups` was not), with no further retry once the marker
        // short-circuits every later launch.
        let root = temp_dir("merge-tracks-new-dir-itself");
        let old_dir = root.join("app.plume.editor");
        let new_dir = root.join("app.mojidori.editor");

        fs::create_dir_all(old_dir.join("backups").join("nested")).unwrap();
        fs::write(
            old_dir.join("backups").join("nested").join("deep.bak"),
            b"hot-exit backup content",
        )
        .unwrap();

        fs::create_dir_all(&new_dir).unwrap();
        fs::write(new_dir.join(".window-state.json"), b"unrelated").unwrap();

        let mut progress = MergeProgress::default();
        merge_dir_recursive(&old_dir, &new_dir, &mut progress).unwrap();

        assert!(
            progress.touched_dirs.contains(&new_dir),
            "new_dir itself must be marked touched -- it gained a new \
             `backups` entry; touched_dirs was {:?}",
            progress.touched_dirs
        );
        assert!(progress.touched_dirs.contains(&new_dir.join("backups")));
        assert!(progress
            .touched_dirs
            .contains(&new_dir.join("backups").join("nested")));

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn merge_cleans_up_stray_merge_tmp_debris_before_copying() {
        // A `.merge-tmp` file at the computed staging path can only be
        // debris from an interrupted previous attempt at copying this
        // exact file. It must not be mistaken for the real thing, and
        // must not block (or corrupt) a fresh copy.
        let root = temp_dir("merge-cleans-stray-tmp");
        let old_dir = root.join("app.plume.editor");
        let new_dir = root.join("app.mojidori.editor");

        fs::create_dir_all(&old_dir).unwrap();
        fs::write(old_dir.join("preferences.json"), b"real content").unwrap();

        fs::create_dir_all(&new_dir).unwrap();
        fs::write(new_dir.join(".window-state.json"), b"unrelated").unwrap();
        let stray_tmp = merge_tmp_path(&new_dir.join("preferences.json"));
        fs::write(&stray_tmp, b"GARBAGE-FROM-AN-INTERRUPTED-ATTEMPT").unwrap();

        let (files_copied, bytes_copied, files_skipped) =
            merge_recover(&old_dir, &new_dir).unwrap();
        assert_eq!(files_copied, 1);
        assert_eq!(bytes_copied, b"real content".len() as u64);
        assert_eq!(files_skipped, 0);

        assert_eq!(
            fs::read(new_dir.join("preferences.json")).unwrap(),
            b"real content"
        );
        assert!(
            !stray_tmp.exists(),
            "the stray temp file must not survive the completed copy"
        );

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn merge_places_the_file_after_a_simulated_death_right_before_the_final_rename() {
        // Simulates a crash between the temp file's `fsync` and its
        // `rename` onto the final path: the temp file is fully written
        // (it would have been, at that point — `fs::copy` + `sync_all`
        // already completed), but the final path doesn't exist yet. The
        // next merge run must still place the file (not treat the temp's
        // mere presence as "already handled" or skip it) and must end up
        // with the *source's* content, not whatever was in the temp file.
        let root = temp_dir("merge-death-before-rename");
        let old_dir = root.join("app.plume.editor");
        let new_dir = root.join("app.mojidori.editor");

        fs::create_dir_all(&old_dir).unwrap();
        fs::write(
            old_dir.join("session.json"),
            b"authoritative source content",
        )
        .unwrap();

        fs::create_dir_all(&new_dir).unwrap();
        let final_path = new_dir.join("session.json");
        let tmp_path = merge_tmp_path(&final_path);
        // The temp file exists (as if `fs::copy` + `sync_all` had already
        // run last time); the final file does not.
        fs::write(&tmp_path, b"stale bytes from the interrupted run").unwrap();
        assert!(!final_path.exists());

        let (files_copied, _, files_skipped) = merge_recover(&old_dir, &new_dir).unwrap();
        assert_eq!(files_copied, 1, "the file must not be skipped");
        assert_eq!(files_skipped, 0);

        assert_eq!(
            fs::read(&final_path).unwrap(),
            b"authoritative source content",
            "must be re-copied from old_dir, not resurrected from the stale temp"
        );
        assert!(!tmp_path.exists());

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

    /// Two threads each doing their own `File::open()` on `lock_path`
    /// creates two independent OS-level open file descriptions/handles,
    /// subject to the exact same lock contention rules the OS would apply
    /// across two separate *processes* — so this genuinely exercises
    /// [`migrate_locked`]'s cross-process guarantee, not just an
    /// in-process convention. Reproduces the exact scenario from the
    /// module doc: `new_dir` already has a stray file (routing to the
    /// merge path) and two racers both try to recover `old_dir` into it
    /// at once.
    #[test]
    fn concurrent_migrate_locked_calls_migrate_exactly_once_and_lose_no_data() {
        let root = temp_dir("concurrent-lock");
        let old_dir = root.join("app.plume.editor");
        let new_dir = root.join("app.mojidori.editor");
        let marker = marker_path(&new_dir);
        let lock = lock_path(&new_dir);

        fs::create_dir_all(&old_dir).unwrap();
        fs::write(old_dir.join("preferences.json"), b"real prefs").unwrap();
        fs::create_dir_all(old_dir.join("backups")).unwrap();
        fs::write(old_dir.join("backups").join("tab-1.bak"), b"unsaved buffer").unwrap();

        // A stray file already in new_dir, no marker yet -- the exact
        // precondition that routes migrate() to the merge path, which is
        // where the module doc's data-loss scenario happens without a
        // lock.
        fs::create_dir_all(&new_dir).unwrap();
        fs::write(
            new_dir.join(".window-state.json"),
            b"unrelated, must survive",
        )
        .unwrap();

        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));

        let (tx_a, rx_a) = std::sync::mpsc::channel();
        {
            let old_dir = old_dir.clone();
            let new_dir = new_dir.clone();
            let marker = marker.clone();
            let lock = lock.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                let result = migrate_locked(&old_dir, &new_dir, &marker, &lock, OLD_IDENTIFIER);
                let _ = tx_a.send(result);
            });
        }

        let (tx_b, rx_b) = std::sync::mpsc::channel();
        {
            let old_dir = old_dir.clone();
            let new_dir = new_dir.clone();
            let marker = marker.clone();
            let lock = lock.clone();
            std::thread::spawn(move || {
                barrier.wait();
                let result = migrate_locked(&old_dir, &new_dir, &marker, &lock, OLD_IDENTIFIER);
                let _ = tx_b.send(result);
            });
        }

        let timeout = std::time::Duration::from_secs(10);
        let result_a = rx_a
            .recv_timeout(timeout)
            .expect("racer A did not return -- lock likely deadlocked");
        let result_b = rx_b
            .recv_timeout(timeout)
            .expect("racer B did not return -- lock likely deadlocked");

        let results = [&result_a, &result_b];
        let did_work = results
            .iter()
            .filter(|r| !matches!(r, Ok(MigrationOutcome::AlreadyDecided)))
            .count();
        let already_decided = results
            .iter()
            .filter(|r| matches!(r, Ok(MigrationOutcome::AlreadyDecided)))
            .count();
        assert_eq!(
            did_work, 1,
            "expected exactly one racer to perform the migration, got {results:?}"
        );
        assert_eq!(
            already_decided, 1,
            "expected exactly one racer to see AlreadyDecided, got {results:?}"
        );

        // No data lost, whichever racer "won" the lock first.
        assert_eq!(
            fs::read(new_dir.join("preferences.json")).unwrap(),
            b"real prefs"
        );
        assert_eq!(
            fs::read(new_dir.join("backups").join("tab-1.bak")).unwrap(),
            b"unsaved buffer"
        );
        assert_eq!(
            fs::read(new_dir.join(".window-state.json")).unwrap(),
            b"unrelated, must survive"
        );
        assert!(marker.is_file());
        assert!(!old_dir.exists());
        assert!(root.join("app.plume.editor.migrated").is_dir());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn migrate_locked_reentry_within_a_single_process_does_not_deadlock() {
        let root = temp_dir("locked-reentry");
        let old_dir = root.join("app.plume.editor");
        let new_dir = root.join("app.mojidori.editor");
        let marker = marker_path(&new_dir);
        let lock = lock_path(&new_dir);

        fs::create_dir_all(&old_dir).unwrap();
        fs::write(old_dir.join("preferences.json"), b"data").unwrap();

        let first = migrate_locked(&old_dir, &new_dir, &marker, &lock, OLD_IDENTIFIER).unwrap();
        assert!(matches!(first, MigrationOutcome::Migrated { files: 1, .. }));

        // The lock acquired inside the first call must have been released
        // (by `_lock` dropping) before it returned -- otherwise this
        // second call would block forever waiting on itself. Bounded with
        // a timeout so a regression here fails fast instead of hanging
        // the test suite.
        let (old_dir2, new_dir2, marker2, lock2) = (
            old_dir.clone(),
            new_dir.clone(),
            marker.clone(),
            lock.clone(),
        );
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let result = migrate_locked(&old_dir2, &new_dir2, &marker2, &lock2, OLD_IDENTIFIER);
            let _ = tx.send(result);
        });
        let second = rx
            .recv_timeout(std::time::Duration::from_secs(10))
            .expect("second migrate_locked call did not return -- lock not released")
            .unwrap();
        assert_eq!(second, MigrationOutcome::AlreadyDecided);

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    #[cfg(unix)]
    fn full_transfer_preserves_source_file_permissions() {
        // Regression: `copy_file_synced` writes via `File::create`, whose
        // permissions come from the process umask (commonly 0644), not
        // `src`'s -- without an explicit fix-up, a user's 0600 config
        // directory would come out of a full-transfer migration
        // world/group-readable.
        use std::os::unix::fs::PermissionsExt;

        let root = temp_dir("full-transfer-preserves-perms");
        let old_dir = root.join("app.plume.editor");
        let new_dir = root.join("app.mojidori.editor");

        fs::create_dir_all(&old_dir).unwrap();
        let src = old_dir.join("session.json");
        fs::write(&src, b"unsaved buffer content").unwrap();
        fs::set_permissions(&src, fs::Permissions::from_mode(0o600)).unwrap();

        let outcome = migrate_dir(&old_dir, &new_dir).unwrap();
        assert!(matches!(outcome, MigrationOutcome::Migrated { .. }));

        let mode = fs::metadata(new_dir.join("session.json"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o600, "expected mode 0600, got {mode:o}");

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    #[cfg(unix)]
    fn merge_recovery_preserves_source_file_permissions() {
        // Same regression as `full_transfer_preserves_source_file_permissions`,
        // for `copy_file_atomic_no_overwrite`'s temp-file-then-rename path.
        use std::os::unix::fs::PermissionsExt;

        let root = temp_dir("merge-preserves-perms");
        let old_dir = root.join("app.plume.editor");
        let new_dir = root.join("app.mojidori.editor");

        fs::create_dir_all(&old_dir).unwrap();
        let src = old_dir.join("session.json");
        fs::write(&src, b"unsaved buffer content").unwrap();
        fs::set_permissions(&src, fs::Permissions::from_mode(0o600)).unwrap();

        // Route to the merge path: new_dir already has unrelated content.
        fs::create_dir_all(&new_dir).unwrap();
        fs::write(new_dir.join(".window-state.json"), b"unrelated").unwrap();

        let (files_copied, _, _) = merge_recover(&old_dir, &new_dir).unwrap();
        assert_eq!(files_copied, 1);

        let mode = fs::metadata(new_dir.join("session.json"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o600, "expected mode 0600, got {mode:o}");

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    #[cfg(unix)]
    fn full_transfer_preserves_source_directory_permissions() {
        // Regression: file permissions were fixed (the two tests above),
        // but directories created via `fs::create_dir_all` still came out
        // with umask-derived permissions -- a source `backups/` directory
        // at 0700 (whose 0644 files were only actually private *because*
        // the containing directory wasn't traversable by other local
        // users) would come out of migration listable/readable by anyone
        // on the machine.
        use std::os::unix::fs::PermissionsExt;

        let root = temp_dir("full-transfer-preserves-dir-perms");
        let old_dir = root.join("app.plume.editor");
        let new_dir = root.join("app.mojidori.editor");

        fs::create_dir_all(old_dir.join("backups")).unwrap();
        fs::write(old_dir.join("backups").join("tab-1.bak"), b"unsaved").unwrap();
        fs::set_permissions(old_dir.join("backups"), fs::Permissions::from_mode(0o700)).unwrap();

        let outcome = migrate_dir(&old_dir, &new_dir).unwrap();
        assert!(matches!(outcome, MigrationOutcome::Migrated { .. }));

        let mode = fs::metadata(new_dir.join("backups"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o700, "expected mode 0700, got {mode:o}");

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    #[cfg(unix)]
    fn merge_recovery_preserves_source_directory_permissions() {
        // Same regression as `full_transfer_preserves_source_directory_permissions`,
        // for `copy_dir_recursive_tracked`'s whole-missing-subtree copy in
        // the merge path.
        use std::os::unix::fs::PermissionsExt;

        let root = temp_dir("merge-preserves-dir-perms");
        let old_dir = root.join("app.plume.editor");
        let new_dir = root.join("app.mojidori.editor");

        fs::create_dir_all(old_dir.join("backups")).unwrap();
        fs::write(old_dir.join("backups").join("tab-1.bak"), b"unsaved").unwrap();
        fs::set_permissions(old_dir.join("backups"), fs::Permissions::from_mode(0o700)).unwrap();

        // Route to the merge path: new_dir already has unrelated content,
        // and doesn't have `backups/` at all yet -- a whole-subtree copy.
        fs::create_dir_all(&new_dir).unwrap();
        fs::write(new_dir.join(".window-state.json"), b"unrelated").unwrap();

        let (files_copied, _, _) = merge_recover(&old_dir, &new_dir).unwrap();
        assert_eq!(files_copied, 1);

        let mode = fs::metadata(new_dir.join("backups"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o700, "expected mode 0700, got {mode:o}");

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    #[cfg(unix)]
    fn create_file_no_wider_than_source_is_never_more_permissive_at_creation_instant() {
        // Regression: `copy_file_synced`/`copy_file_atomic_no_overwrite`
        // used to `File::create` (umask-derived permissions) *then* write
        // bytes *then* fix up permissions afterwards -- leaving a real
        // window, while bytes were being written, where a 0600
        // session/hot-exit-backup file existed on disk at 0644 and was
        // readable by every other local user. Calling
        // `create_file_no_wider_than_source` directly (bypassing the
        // write step entirely) and inspecting the file's mode immediately
        // proves there's no such window: the file is never wider than its
        // source, not even for the instant right after creation.
        use std::os::unix::fs::PermissionsExt;

        let root = temp_dir("create-file-no-wider-than-source");
        let src = root.join("source.txt");
        fs::write(&src, b"source content").unwrap();
        fs::set_permissions(&src, fs::Permissions::from_mode(0o600)).unwrap();
        let src_permissions = fs::metadata(&src).unwrap().permissions();

        let dst = root.join("dest.txt");
        // Created but deliberately never written to -- the mode is
        // checked at the earliest possible instant.
        let _file = create_file_no_wider_than_source(&dst, &src_permissions).unwrap();

        let mode = fs::metadata(&dst).unwrap().permissions().mode() & 0o777;
        assert_eq!(
            mode & !0o600,
            0,
            "dest file must never be wider than the 0600 source, got mode {mode:o}"
        );
        // Under any normal umask, 0600 requests no bits a typical umask
        // would need to strip, so this should land exactly on 0600.
        assert_eq!(mode, 0o600, "expected exact mode 0600, got {mode:o}");

        let _ = fs::remove_dir_all(&root);
    }
}
