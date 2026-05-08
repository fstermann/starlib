/**
 * Tiny event bus used to invalidate cached ruleset lists across the app
 * (filesystem tree right-click menu, track editor, settings dialog).
 *
 * Each surface fetches `api.getRulesets()` once on mount and would otherwise
 * miss rulesets created or renamed elsewhere — see #374. Anything that
 * mutates the rulesets collection should call `dispatchRulesetsChanged()`;
 * subscribers re-fetch.
 */
export const RULESETS_CHANGED_EVENT = "rulesets-changed";

export function dispatchRulesetsChanged(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(RULESETS_CHANGED_EVENT));
}

export function onRulesetsChanged(handler: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(RULESETS_CHANGED_EVENT, handler);
  return () => window.removeEventListener(RULESETS_CHANGED_EVENT, handler);
}
