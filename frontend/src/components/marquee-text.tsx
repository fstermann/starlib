"use client";

import { useEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";

const GAP_PX = 40; // space between the end of one copy and the start of the next
const PX_PER_SEC = 22; // scroll speed
const PAUSE_FRACTION = 0.12; // brief stop at the wrap point each cycle

/**
 * Single-line text that continuously loops (one direction, with a brief stop at
 * the wrap) to reveal its full content when it overflows the container, and
 * stays static (clipped) when it fits. Overflowing text is duplicated so the
 * scroll wraps seamlessly. Respects `prefers-reduced-motion`. The container
 * shrinks like `truncate` (min-width 0 via `overflow-hidden`), so it drops into
 * flex rows in place of a truncating span.
 */
export function MarqueeText({
  text,
  className,
  title,
}: {
  text: string;
  className?: string;
  title?: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);
  const [overflow, setOverflow] = useState(0);

  useEffect(() => {
    const container = containerRef.current;
    const el = textRef.current;
    if (!container || !el) return;
    const measure = () => {
      const diff = el.scrollWidth - container.clientWidth;
      setOverflow(diff > 1 ? diff : 0);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(container);
    ro.observe(el);
    return () => ro.disconnect();
  }, [text]);

  useEffect(() => {
    const track = trackRef.current;
    const el = textRef.current;
    if (!track || !el || overflow <= 0) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    // One copy width + gap: at cycle end the second copy sits exactly where the
    // first started, so restarting is seamless.
    const distance = el.scrollWidth + GAP_PX;
    const moveMs = (distance / PX_PER_SEC) * 1000;
    const duration = moveMs / (1 - PAUSE_FRACTION);
    const anim = track.animate(
      [
        { transform: "translateX(0)", offset: 0 },
        { transform: "translateX(0)", offset: PAUSE_FRACTION },
        { transform: `translateX(-${distance}px)`, offset: 1 },
      ],
      { duration, iterations: Infinity, easing: "linear" },
    );
    return () => anim.cancel();
  }, [overflow, text]);

  return (
    <div ref={containerRef} className="min-w-0 overflow-hidden">
      <div
        ref={trackRef}
        className="flex w-max"
        style={{ gap: overflow > 0 ? GAP_PX : 0 }}
      >
        <span
          ref={textRef}
          className={cn("whitespace-nowrap", className)}
          title={title}
        >
          {text}
        </span>
        {overflow > 0 && (
          <span aria-hidden className={cn("whitespace-nowrap", className)}>
            {text}
          </span>
        )}
      </div>
    </div>
  );
}
