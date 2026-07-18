//! Shared file-fingerprint guard: a fail-closed check that a file at a path
//! is still, on disk, the exact file some earlier metadata snapshot
//! described. Used at commit time — immediately before an atomic rename —
//! to detect an external replace (another process's atomic rename, a sync
//! tool, a second Plume window/instance) that happened between reading a
//! file and writing it back to the same path, so that write can abort
//! instead of silently clobbering the newer content.
//!
//! Introduced for the large-file streaming replace path (issue #94,
//! `streamreplace.rs`) and shared with the regular save path (issue #113,
//! `save_document` in `lib.rs`) and per-file batch conversion (issue #114,
//! `commit_conversion` in `batch.rs`) so all three commit-time checks rest
//! on exactly one implementation.
//!
//! Cross-platform identity: on Unix, `(dev, ino)` — from
//! `std::os::unix::fs::MetadataExt` — uniquely identifies the underlying
//! inode no matter what path currently names it. On Windows, the
//! equivalent identity (`nFileIndex` / `dwVolumeSerialNumber`, exposed by
//! `std::os::windows::fs::MetadataExt::file_index` / `volume_serial_number`)
//! is still gated behind the unstable `windows_by_handle` feature
//! (rust-lang/rust#63010 — the tracking issue is still open, and
//! `file_index`/`volume_serial_number` are marked `#[unstable]` in the
//! standard library source as of this writing), so it is not available on
//! stable Rust and this struct carries no Windows identity field at all.
//! Windows therefore relies on `len` + `modified` alone — a weaker signal
//! than inode identity, but sufficient for the actual threat model: a
//! replacement landing with the same byte length and the same
//! filesystem-timestamp-resolution mtime as the file a fingerprint
//! describes is exceedingly unlikely once any non-trivial time has passed.
//!
//! `Fingerprint` is `Serialize`/`Deserialize` so it can cross IPC as an
//! opaque value: the frontend stores whatever `open_document` /
//! `save_document` hand back and passes it right back, unexamined, as the
//! next save's expected baseline (see `src/tabs.ts` `Doc.fingerprint`).

use serde::{Deserialize, Serialize};
use std::path::Path;

/// Epoch-relative instant that serializes for *any* mtime, including one
/// before `UNIX_EPOCH`: serde's built-in `SystemTime` serialization rejects
/// pre-epoch values outright ("SystemTime must be later than UNIX_EPOCH" in
/// serde's `ser/impls.rs`), which would have turned a merely odd mtime
/// (`touch -t 196001010000` makes one) into a hard `open_document` failure
/// once the fingerprint rode along in the response — a file that opened
/// fine before #113 would have stopped opening at all (issue #113 review,
/// M1). `i64` seconds rather than `i128` nanoseconds because serde_json
/// does not guarantee 128-bit integer support.
///
/// Canonical form: `secs` is the whole-second offset from the epoch
/// (negative before it), and `nanos` counts *forward* from that second,
/// always in `0..1_000_000_000` — the same normalized shape `Duration`
/// uses, applied symmetrically on both sides of the epoch. Every instant
/// has exactly one representation, so `==` on this type is equivalent to
/// `==` on the `SystemTime` it was built from (locked by
/// `epoch_offset_conversion_round_trips_across_epoch`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct EpochOffset {
    pub(crate) secs: i64,
    pub(crate) nanos: u32,
}

impl From<std::time::SystemTime> for EpochOffset {
    fn from(t: std::time::SystemTime) -> Self {
        match t.duration_since(std::time::UNIX_EPOCH) {
            Ok(after) => Self {
                secs: after.as_secs() as i64,
                nanos: after.subsec_nanos(),
            },
            Err(e) => {
                // `e.duration()` is how far *before* the epoch `t` lies.
                // Re-express "epoch - before" in the canonical
                // forward-counting form: borrow one second when there is a
                // fractional part, so nanos stays in 0..1e9.
                let before = e.duration();
                if before.subsec_nanos() == 0 {
                    Self {
                        secs: -(before.as_secs() as i64),
                        nanos: 0,
                    }
                } else {
                    Self {
                        secs: -(before.as_secs() as i64) - 1,
                        nanos: 1_000_000_000 - before.subsec_nanos(),
                    }
                }
            }
        }
    }
}

/// Inverse of the conversion above; the two round-trip exactly (see
/// `epoch_offset_conversion_round_trips_across_epoch`). Panics only if the
/// offset lies outside `SystemTime`'s representable range — impossible for
/// a value that came out of a real `SystemTime` in the first place.
impl From<EpochOffset> for std::time::SystemTime {
    fn from(o: EpochOffset) -> Self {
        if o.secs >= 0 {
            std::time::UNIX_EPOCH + std::time::Duration::new(o.secs as u64, o.nanos)
        } else if o.nanos == 0 {
            std::time::UNIX_EPOCH - std::time::Duration::new(o.secs.unsigned_abs(), 0)
        } else {
            // Un-borrow the second the forward conversion borrowed.
            std::time::UNIX_EPOCH
                - std::time::Duration::new(o.secs.unsigned_abs() - 1, 1_000_000_000 - o.nanos)
        }
    }
}

/// A metadata snapshot of a file at one point in time, fail-closed
/// comparable against the same path later — see [`Fingerprint::matches_path`].
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Fingerprint {
    pub(crate) len: u64,
    pub(crate) modified: EpochOffset,
    #[cfg(unix)]
    pub(crate) identity: (u64, u64), // (dev, ino)
}

impl Fingerprint {
    /// Capture from already-resolved `Metadata`. Callers choose where that
    /// comes from: an open handle's `File::metadata()` ties the snapshot to
    /// the exact inode that handle refers to, even if the path is later
    /// renamed out from under it (what `streamreplace.rs` needs, since it
    /// keeps the source file open for the whole streaming run — see
    /// [`Self::from_file`]); a fresh `fs::metadata(path)` is the only option
    /// once no handle is being kept open across an IPC round trip (what
    /// `open_document`/`save_document` need — see [`Self::from_path`]).
    pub fn from_metadata(meta: &std::fs::Metadata) -> std::io::Result<Self> {
        Ok(Self {
            len: meta.len(),
            modified: meta.modified()?.into(),
            #[cfg(unix)]
            identity: unix_identity(meta),
        })
    }

    /// Capture tied to `file`'s exact inode (Unix) via its already-open
    /// handle, rather than re-`stat`ing the path it was opened from.
    pub fn from_file(file: &std::fs::File) -> std::io::Result<Self> {
        Self::from_metadata(&file.metadata()?)
    }

    /// Capture a fresh snapshot of `path` right now.
    pub fn from_path(path: &Path) -> std::io::Result<Self> {
        Self::from_metadata(&std::fs::metadata(path)?)
    }

    /// Fail-closed: true only if `path` currently exists and its metadata
    /// still matches this fingerprint exactly (size, mtime, and — on Unix —
    /// inode identity). Any mismatch — including the path no longer
    /// existing at all, or a stat error — is `false`. There is no case
    /// where proceeding anyway is the safe choice once the on-disk contents
    /// can no longer be shown to be the ones this fingerprint was captured
    /// from.
    ///
    /// A `true` result is a snapshot, not a lock: the caller's follow-up
    /// action (typically a rename) happens after this returns, leaving an
    /// irreducible microsecond-scale TOCTOU window — no portable rename is
    /// conditional on file identity. Callers use this to *narrow* the
    /// unguarded race from the whole read-to-commit span down to that
    /// window, never to close it (issues #94/#102/#113).
    pub fn matches_path(&self, path: &Path) -> bool {
        matches!(Self::from_path(path), Ok(current) if current == *self)
    }
}

#[cfg(unix)]
fn unix_identity(meta: &std::fs::Metadata) -> (u64, u64) {
    use std::os::unix::fs::MetadataExt;
    (meta.dev(), meta.ino())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("plume-fsguard-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn matches_path_true_when_file_untouched() {
        let dir = fixture_dir("untouched");
        let file = dir.join("doc.txt");
        std::fs::write(&file, b"hello").unwrap();

        let fp = Fingerprint::from_path(&file).unwrap();
        assert!(fp.matches_path(&file));

        std::fs::remove_dir_all(&dir).ok();
    }

    /// Two consecutive `std::fs::write` calls to the same path (open +
    /// truncate + write, never unlink) don't necessarily change Unix inode
    /// identity, so the byte-length mismatch has to carry this case on its
    /// own — exactly the signal `save_document`'s own regression test
    /// leans on (see `lib.rs`).
    #[test]
    fn matches_path_false_after_size_change() {
        let dir = fixture_dir("size-change");
        let file = dir.join("doc.txt");
        std::fs::write(&file, b"hello").unwrap();
        let fp = Fingerprint::from_path(&file).unwrap();

        std::fs::write(&file, b"hello, world - now longer").unwrap();

        assert!(!fp.matches_path(&file));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn matches_path_false_when_file_deleted() {
        let dir = fixture_dir("deleted");
        let file = dir.join("doc.txt");
        std::fs::write(&file, b"hello").unwrap();
        let fp = Fingerprint::from_path(&file).unwrap();

        std::fs::remove_file(&file).unwrap();

        assert!(!fp.matches_path(&file));
        std::fs::remove_dir_all(&dir).ok();
    }

    /// `from_file` ties the snapshot to the open handle's inode (Unix),
    /// which must still detect an external replace performed via rename
    /// over the same path — the exact mechanism issues #94 and #113 defend
    /// against — even though the handle itself keeps referring to the
    /// original (now-unlinked) inode after the rename.
    #[cfg(unix)]
    #[test]
    fn from_file_detects_external_rename_over_same_path() {
        let dir = fixture_dir("external-rename");
        let file = dir.join("doc.txt");
        std::fs::write(&file, b"original").unwrap();

        let handle = std::fs::File::open(&file).unwrap();
        let fp = Fingerprint::from_file(&handle).unwrap();

        let replacement = dir.join("replacement.txt");
        std::fs::write(&replacement, b"newer content from elsewhere").unwrap();
        std::fs::rename(&replacement, &file).unwrap();

        assert!(!fp.matches_path(&file));
        drop(handle);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Issue #113 review, M1 (failing-test-first): serde's built-in
    /// `SystemTime` serialization rejects any instant before `UNIX_EPOCH`
    /// outright ("SystemTime must be later than UNIX_EPOCH", serde's own
    /// `ser/impls.rs`), so storing `modified` as a bare `SystemTime`
    /// turned a merely odd mtime — `touch -t 196001010000` creates one —
    /// into a hard `open_document` failure once the fingerprint rode
    /// along in the response: a file that opened fine before #113 stopped
    /// opening at all. Red against the `SystemTime`-typed field; green
    /// with [`EpochOffset`]. (The fixture constructs the pre-epoch value
    /// directly rather than `touch`-ing a real file: setting a file's
    /// mtime from Rust would need a new dependency, which this repo
    /// forbids without strong justification.)
    #[test]
    fn fingerprint_with_pre_epoch_mtime_round_trips_through_json() {
        // Mid-times-1960s instant, with subsecond nanos so the conversion's
        // normalized-nanos borrow is exercised, not just whole seconds.
        let pre_epoch = std::time::UNIX_EPOCH - std::time::Duration::new(315_532_800, 500_000_000);
        let fp = Fingerprint {
            len: 42,
            modified: pre_epoch.into(),
            #[cfg(unix)]
            identity: (3, 7),
        };

        let json = serde_json::to_string(&fp).expect("pre-epoch mtime must serialize");
        let restored: Fingerprint = serde_json::from_str(&json).unwrap();
        assert_eq!(fp, restored);
        assert_eq!(std::time::SystemTime::from(restored.modified), pre_epoch);
    }

    /// Pins the normalized-nanos math on both sides of the epoch: `nanos`
    /// always counts forward within `0..1e9` so each instant has exactly
    /// one representation, the `SystemTime` conversion round-trips
    /// exactly in both directions, and instants one nanosecond apart —
    /// including straddling the epoch itself — never collide.
    #[test]
    fn epoch_offset_conversion_round_trips_across_epoch() {
        // Sub-second offsets are multiples of 100ns throughout: Windows
        // `SystemTime` is FILETIME-backed (100ns intervals), so a 1ns
        // offset like `UNIX_EPOCH - Duration::new(0, 1)` silently
        // truncates back to the epoch there and the pre-epoch cases stop
        // being pre-epoch at all (caught by the first real Windows CI run
        // after #123 merged; Unix, with nanosecond resolution, represents
        // either just fine). 100ns is exact on both platforms, so these
        // fixtures exercise the same normalization/borrow paths everywhere.
        let cases = [
            std::time::UNIX_EPOCH,
            std::time::UNIX_EPOCH + std::time::Duration::new(5, 100),
            std::time::UNIX_EPOCH - std::time::Duration::new(0, 100),
            std::time::UNIX_EPOCH - std::time::Duration::new(1, 0),
            std::time::UNIX_EPOCH - std::time::Duration::new(1, 999_999_900),
        ];
        for t in cases {
            let offset = EpochOffset::from(t);
            assert!(offset.nanos < 1_000_000_000, "{offset:?} not normalized");
            assert_eq!(std::time::SystemTime::from(offset), t, "{offset:?}");
        }
        // The smallest cross-platform-representable step on either side of
        // the epoch must stay distinct.
        let just_before =
            EpochOffset::from(std::time::UNIX_EPOCH - std::time::Duration::new(0, 100));
        let at_epoch = EpochOffset::from(std::time::UNIX_EPOCH);
        assert_eq!(
            just_before,
            EpochOffset {
                secs: -1,
                nanos: 999_999_900
            }
        );
        assert_eq!(at_epoch, EpochOffset { secs: 0, nanos: 0 });
        assert_ne!(just_before, at_epoch);
    }

    /// Locks the property the design depends on: `Fingerprint` really is
    /// `Serialize`/`Deserialize`-round-trippable, so passing it out to the
    /// frontend as opaque JSON and back in on the next save reconstructs an
    /// equivalent value that still compares correctly against disk.
    #[test]
    fn fingerprint_round_trips_through_json() {
        let dir = fixture_dir("json-roundtrip");
        let file = dir.join("doc.txt");
        std::fs::write(&file, b"hello").unwrap();
        let fp = Fingerprint::from_path(&file).unwrap();

        let json = serde_json::to_string(&fp).unwrap();
        let restored: Fingerprint = serde_json::from_str(&json).unwrap();

        assert_eq!(fp, restored);
        assert!(restored.matches_path(&file));
        std::fs::remove_dir_all(&dir).ok();
    }
}
