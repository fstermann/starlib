/**
 * Decide whether the "Apply rules" button can run, and why not.
 *
 * Rules can only run on a saved track (#371): unsaved edits would mean the
 * rules act on a different version than what's on disk. Required-attribute
 * checks come second; loading state always wins.
 */
export type ApplyRulesGateInput = {
  loading: boolean;
  hasUnsavedChanges: boolean;
  hasMissingRequired: boolean;
};

export type ApplyRulesGate = {
  disabled: boolean;
  reason: "loading" | "unsaved" | "missing-required" | null;
};

export function applyRulesGate(input: ApplyRulesGateInput): ApplyRulesGate {
  if (input.loading) return { disabled: true, reason: "loading" };
  if (input.hasUnsavedChanges) return { disabled: true, reason: "unsaved" };
  if (input.hasMissingRequired)
    return { disabled: true, reason: "missing-required" };
  return { disabled: false, reason: null };
}
