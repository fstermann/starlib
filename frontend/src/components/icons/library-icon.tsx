import type { SVGProps } from "react";

/**
 * Library icon derived from the three inner bars of the Starlib mark.
 * Rendered as a lucide-style outline so it sits alongside `lucide-react` icons.
 */
export function LibraryIcon({
  size = 24,
  strokeWidth = 2,
  ...props
}: SVGProps<SVGSVGElement> & {
  size?: number | string;
  strokeWidth?: number | string;
}) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <rect x="3" y="8" width="3.5" height="12" />
      <rect x="8.5" y="5" width="3.5" height="15" />
      <path d="M14.5 5 L18 4 L21.5 19 L18 20 Z" />
    </svg>
  );
}
