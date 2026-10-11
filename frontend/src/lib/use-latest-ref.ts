import { useLayoutEffect, useRef } from "react";

/** A ref that always holds the latest committed `value`, for reading inside
 *  effects, timers and event handlers without re-subscribing on change. */
export function useLatestRef<T>(value: T) {
  const ref = useRef(value);
  useLayoutEffect(() => {
    ref.current = value;
  });
  return ref;
}
