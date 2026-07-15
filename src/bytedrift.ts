// Lazy byte-drift detection gate for the save path (issue #96, part 2/3)
// [danger]: a handful of legacy multi-byte encodings (Big5, Shift_JIS, GBK)
// have non-injective decode mappings, so an ordinary save can silently
// canonicalize byte sequences the user never touched even though nothing is
// malformed or unmappable — see src-tauri/src/encoding.rs's module doc and
// src-tauri/src/bytedrift.rs's `detect_byte_drift`, which this gate calls
// into (ipc.ts's `checkByteDrift`) at most once per document per session,
// right before its first save.
//
// Pulled out as pure decision functions — main.ts's runSaveFlow is wired
// directly into the DOM/editor/IPC and isn't unit-testable on its own (see
// savecompletion.ts's/savemutex.ts's header comments for the same pattern
// applied to issue #112/#124) — plus a small async orchestrator that takes
// the IPC call and the confirm dialog as injected callbacks rather than
// importing ipc.ts/the native `confirm()` plugin directly, so the whole
// call/skip/cancel/proceed sequence is vitest-coverable without a WebView or
// a real Tauri backend (main.ts's runSaveFlow supplies the real closures;
// bytedrift.test.ts supplies fakes — same "stand-in" technique as
// savemutex.test.ts's harness, scaled down to this feature's actual shape:
// one sequential gate, not a concurrency race).

export interface ByteDriftGateInput {
  /** doc.byteDriftChecked as of right now — true once check_byte_drift has
   *  already run for this doc's current on-disk baseline this session. */
  alreadyChecked: boolean;
}

/** Whether runSaveFlow should call the check_byte_drift IPC command for
 *  this save attempt. Mirrors savemutex.ts's mustDefer shape: a named,
 *  independently-tested gate rather than an inline `!` check scattered
 *  through main.ts. Callers are also expected to skip this entirely for a
 *  Save As / untitled-document first save (`path !== oldPath` in
 *  runSaveFlow) — there is no on-disk baseline for issue #96 to apply to
 *  in that case, the same reasoning runSaveFlow already applies to
 *  `expectedFingerprint`, so it stays an inline condition there rather
 *  than being duplicated into this input shape. */
export function shouldCheckByteDrift(input: ByteDriftGateInput): boolean {
  return !input.alreadyChecked;
}

export interface ByteDriftCheckResult {
  drift: boolean;
  skipped: boolean;
  reason: string | null;
}

/** Whether a check_byte_drift response should show the one-time
 *  informed-consent dialog before the save proceeds. `skipped` always wins
 *  over `drift`: Mixed line endings, a Unicode target, and a malformed
 *  decode are src-tauri/src/bytedrift.rs's own calls that this drift
 *  verdict isn't meaningful, not "no drift found". */
export function shouldPromptByteDrift(result: ByteDriftCheckResult): boolean {
  return result.drift && !result.skipped;
}

/**
 * Runs the whole byte-drift gate for one save attempt: calls
 * `checkByteDrift` at most once per doc per session (guarded by
 * `shouldCheckByteDrift`), and — only when the result actually warrants it
 * (`shouldPromptByteDrift`) — awaits `confirmDialog` and aborts the save on
 * a decline. Resolves `true` when the save should proceed, `false` when the
 * user declined the drift dialog.
 *
 * Both IO calls are injected rather than imported directly, so this
 * orchestration itself has no DOM/Tauri dependency — see the module doc.
 *
 * A rejected `checkByteDrift` (e.g. the file briefly locked, or deleted
 * externally) fails open — this is a best-effort, informed-consent nicety
 * layered on top of `save_document`'s own atomic-write and
 * fingerprint-staleness guarantees, not a correctness check, so an IO
 * hiccup must not block the save — but deliberately does NOT spend
 * `doc.byteDriftChecked` (critic-review P3 on this feature's first
 * version, which flipped the flag before the await): the one-per-session
 * ask is only consumed by a check that actually ran to a verdict, so a
 * transient failure is retried on the next save instead of silencing the
 * dialog for the rest of the session.
 */
export async function runByteDriftGate(
  doc: { byteDriftChecked: boolean },
  checkByteDrift: () => Promise<ByteDriftCheckResult>,
  confirmDialog: () => Promise<boolean>,
): Promise<boolean> {
  if (!shouldCheckByteDrift({ alreadyChecked: doc.byteDriftChecked })) return true;
  let result: ByteDriftCheckResult;
  try {
    result = await checkByteDrift();
  } catch {
    return true;
  }
  doc.byteDriftChecked = true;
  if (!shouldPromptByteDrift(result)) return true;
  return confirmDialog();
}
