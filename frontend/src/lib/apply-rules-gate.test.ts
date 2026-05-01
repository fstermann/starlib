import { describe, expect, it } from "vitest";

import { applyRulesGate } from "./apply-rules-gate";

describe("applyRulesGate", () => {
  const base = {
    loading: false,
    hasUnsavedChanges: false,
    hasMissingRequired: false,
  };

  it("enables when track is saved and complete", () => {
    expect(applyRulesGate(base)).toEqual({ disabled: false, reason: null });
  });

  it("disables with reason 'unsaved' when there are unsaved edits (#371)", () => {
    expect(applyRulesGate({ ...base, hasUnsavedChanges: true })).toEqual({
      disabled: true,
      reason: "unsaved",
    });
  });

  it("'unsaved' takes precedence over missing-required so the user fixes the save state first", () => {
    expect(
      applyRulesGate({
        ...base,
        hasUnsavedChanges: true,
        hasMissingRequired: true,
      }),
    ).toEqual({ disabled: true, reason: "unsaved" });
  });

  it("loading wins over everything else", () => {
    expect(
      applyRulesGate({
        loading: true,
        hasUnsavedChanges: true,
        hasMissingRequired: true,
      }),
    ).toEqual({ disabled: true, reason: "loading" });
  });

  it("falls through to missing-required when saved but incomplete", () => {
    expect(applyRulesGate({ ...base, hasMissingRequired: true })).toEqual({
      disabled: true,
      reason: "missing-required",
    });
  });
});
