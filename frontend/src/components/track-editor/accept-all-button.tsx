"use client";

import { Sparkles } from "lucide-react";

import { Button } from "@/components/ui/button";

interface AcceptAllSuggestionsButtonProps {
  pendingCount: number;
  onAcceptAll: () => void;
  /** Hover lifecycle hooks — drive the editor's in-place preview state that
   *  fills inputs with suggested values while the cursor is on the button. */
  onPreviewStart?: () => void;
  onPreviewEnd?: () => void;
}

/**
 * Toolbar control that applies the top-ranked suggestion for every field at
 * once. The "what would change" preview lives in the input fields themselves
 * (driven by ``onPreviewStart``/``onPreviewEnd``) — no extra tooltip layer.
 */
export function AcceptAllSuggestionsButton({
  pendingCount,
  onAcceptAll,
  onPreviewStart,
  onPreviewEnd,
}: AcceptAllSuggestionsButtonProps) {
  const disabled = pendingCount === 0;
  const label = `Accept ${pendingCount || 0} suggestion${pendingCount === 1 ? "" : "s"}`;

  // Both pointer and keyboard focus trigger the preview so the affordance is
  // reachable without a mouse. ``mouseLeave`` and ``blur`` always wind it
  // down — including when the click handler causes a focus change.
  const start = () => {
    if (!disabled) onPreviewStart?.();
  };
  const end = () => onPreviewEnd?.();

  return (
    <Button
      variant="outline"
      size="sm"
      className="h-7 gap-1.5 text-xs"
      disabled={disabled}
      onClick={() => {
        end();
        onAcceptAll();
      }}
      onMouseEnter={start}
      onMouseLeave={end}
      onFocus={start}
      onBlur={end}
      data-command-id="suggestion-accept-all"
    >
      <Sparkles className="size-3" />
      {label}
    </Button>
  );
}
