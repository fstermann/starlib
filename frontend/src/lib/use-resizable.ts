import { useCallback, useEffect, useRef, useState } from "react";

interface UseResizableOptions {
  defaultWidth: number;
  minWidth: number;
  maxWidth: number;
  storageKey: string;
  /** Resize direction: 'right' means the handle is on the right edge, 'left' on the left. */
  direction?: "right" | "left";
}

export function useResizable({
  defaultWidth,
  minWidth,
  maxWidth,
  storageKey,
  direction = "right",
}: UseResizableOptions) {
  const [width, setWidth] = useState<number>(() => {
    try {
      const stored = localStorage.getItem(storageKey);
      return stored
        ? Math.max(minWidth, Math.min(maxWidth, Number(stored)))
        : defaultWidth;
    } catch {
      return defaultWidth;
    }
  });
  const [isAnimating, setIsAnimating] = useState(false);
  const draggingRef = useRef(false);
  const startXRef = useRef(0);
  const startWidthRef = useRef(0);

  useEffect(() => {
    try {
      localStorage.setItem(storageKey, String(width));
    } catch {}
  }, [width, storageKey]);

  const handleResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      draggingRef.current = true;
      startXRef.current = e.clientX;
      startWidthRef.current = width;
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";

      const sign = direction === "right" ? 1 : -1;

      const handleMove = (ev: MouseEvent) => {
        if (!draggingRef.current) return;
        const delta = (ev.clientX - startXRef.current) * sign;
        setWidth(
          Math.max(minWidth, Math.min(maxWidth, startWidthRef.current + delta)),
        );
      };

      const handleUp = () => {
        draggingRef.current = false;
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        document.removeEventListener("mousemove", handleMove);
        document.removeEventListener("mouseup", handleUp);
      };

      document.addEventListener("mousemove", handleMove);
      document.addEventListener("mouseup", handleUp);
    },
    [width, direction, minWidth, maxWidth],
  );

  const handleDoubleClick = useCallback(() => {
    setIsAnimating(true);
    setWidth(defaultWidth);
    setTimeout(() => setIsAnimating(false), 200);
  }, [defaultWidth]);

  return { width, isAnimating, handleResizeStart, handleDoubleClick };
}
