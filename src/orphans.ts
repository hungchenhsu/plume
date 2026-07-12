/**
 * Hot-exit orphan recovery. The session index (session.json) is the only
 * record of which files under backups/ hold a document's unsaved content;
 * if that index is missing/corrupt (issue #62) or merely stale (a backup
 * was written but the index update that would reference it never landed),
 * some backups end up on disk with nothing pointing at them. This finds
 * those orphans — backups in `all` that no session entry in `referenced`
 * points to — so the caller can resurrect each one as its own tab instead
 * of leaving it unreachable forever.
 */
export function orphanBackups(
  referenced: (string | null | undefined)[],
  all: string[],
): string[] {
  const referencedNames = new Set(
    referenced.filter((name): name is string => !!name),
  );
  return all.filter((name) => !referencedNames.has(name));
}
