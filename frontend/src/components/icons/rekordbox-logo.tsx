import type { CSSProperties } from "react";

/**
 * Rekordbox brand logomark (icon only, no wordmark).
 * Mirrors the SoundCloudLogo pattern — renders as an SVG that accepts
 * `className` for sizing and color via currentColor.
 */
export function RekordboxLogo({
  className,
  style,
}: {
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <svg
      viewBox="0 0 22.5 26"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      style={style}
      aria-label="Rekordbox"
      role="img"
    >
      <path d="M18.115 11.405c.249.729.385 1.506.385 2.316 0 3.51-2.5 6.437-5.811 7.094v5.09l8.913-5.146c.57-.329.922-.938.922-1.603v-10.3l-4.409 2.549ZM5.843 8.943a7.217 7.217 0 0 1 5.419-2.452c2.156 0 4.096.954 5.418 2.452l4.41-2.548-8.906-5.147a1.862 1.862 0 0 0-1.852 0L1.42 6.395l4.408 2.548h.016Zm-1.819 4.778c0-.81.136-1.587.385-2.316L0 8.855v10.293c0 .657.353 1.274.922 1.603l8.913 5.146v-5.09a7.227 7.227 0 0 1-5.811-7.094v.008Zm10.861-.001a3.62 3.62 0 0 1-3.623 3.624 3.62 3.62 0 0 1-3.623-3.623 3.62 3.62 0 0 1 3.623-3.623 3.62 3.62 0 0 1 3.623 3.623Z" />
    </svg>
  );
}
