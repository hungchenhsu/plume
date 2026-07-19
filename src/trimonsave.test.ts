import { describe, expect, it } from "vitest";
import { shouldTrimTrailingWhitespaceOnSave } from "./trimonsave";

// ROADMAP.md v0.7 Track C "trim trailing whitespace on save" — full branch
// table for the gate main.ts's runSaveFlow consults right before capturing
// a save's content. See trimonsave.ts's own doc comment for why this is
// pulled out as a pure function instead of only being reachable through the
// full (untestable) save flow.
describe("shouldTrimTrailingWhitespaceOnSave — full branch table", () => {
  // (a) preference off: save must not trim, regardless of which doc.
  it("preference off, active doc: does not trim (current behavior unchanged)", () => {
    expect(
      shouldTrimTrailingWhitespaceOnSave({ preferenceOn: false, isActiveDoc: true }),
    ).toBe(false);
  });

  it("preference off, inactive doc: does not trim", () => {
    expect(
      shouldTrimTrailingWhitespaceOnSave({ preferenceOn: false, isActiveDoc: false }),
    ).toBe(false);
  });

  // (b) preference on, active doc: the one case that actually trims.
  it("preference on, active doc: trims", () => {
    expect(
      shouldTrimTrailingWhitespaceOnSave({ preferenceOn: true, isActiveDoc: true }),
    ).toBe(true);
  });

  // Documented scope limit: a save whose doc isn't the live view's active
  // tab (a Save As/first-save dialog await, or a save coalesced behind
  // another in-flight save/reload — see savemutex.ts) skips trimming even
  // with the preference on, rather than risk hand-rolling the live view's
  // onDocChanged bookkeeping for a doc it was never dispatched against.
  it("preference on, inactive doc: does not trim (documented scope limit)", () => {
    expect(
      shouldTrimTrailingWhitespaceOnSave({ preferenceOn: true, isActiveDoc: false }),
    ).toBe(false);
  });
});
