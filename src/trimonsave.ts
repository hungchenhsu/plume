// Save-time trim-trailing-whitespace gate (ROADMAP.md v0.7 Track C,
// adversarial-review addition). main.ts's runSaveFlow is wired directly
// into the DOM/editor/IPC and isn't unit-testable on its own (see
// savemutex.ts/savecompletion.ts's own header comments for the same
// reasoning) — this is that flow's own tiny decision table, pulled out so
// the "does the preference actually gate the trim" behavior gets direct
// vitest coverage instead of only being reachable through the full save
// flow.

export interface TrimGateInput {
  /** preferences().trimTrailingWhitespaceOnSave, read fresh by the caller
   *  right before this save's content capture. */
  preferenceOn: boolean;
  /** Whether the doc being saved is the live editor's own active tab —
   *  i.e. `doc.id === tabs.activeId` in main.ts. Trimming any other doc
   *  would have to bypass the live CodeMirror view entirely (there is
   *  nothing else to dispatch a transaction against), and with it the
   *  normal onDocChanged revision/dirty/backup bookkeeping every other
   *  edit gets (see main.ts's onDocChanged doc comment) — reproducing
   *  that bookkeeping by hand for a path this rare (a save whose doc
   *  stopped being active mid-flight: the Save As/first-save dialog's own
   *  await, or a save coalesced behind another in-flight save/reload —
   *  see savemutex.ts) was judged not worth the risk of the two silently
   *  drifting apart. Such a save's content is written as-is, same as the
   *  preference being off — a documented scope limit, not a bug.
   */
  isActiveDoc: boolean;
}

/**
 * Whether runSaveFlow should call `editor.trimTrailingWhitespaceForSave()`
 * before capturing this save's content. `true` only when both the
 * preference is on and the saving doc is the doc the live editor view is
 * currently showing — see `TrimGateInput.isActiveDoc`'s own doc comment
 * for why the second condition exists at all.
 */
export function shouldTrimTrailingWhitespaceOnSave(input: TrimGateInput): boolean {
  return input.preferenceOn && input.isActiveDoc;
}
