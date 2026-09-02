"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

type TopBarContent = {
  title?: ReactNode;
  actions?: ReactNode;
};

type Setter = {
  set: (value: TopBarContent) => void;
  clear: () => void;
};

type ReloadApi = {
  /** Register a handler to run when the global reload button fires. Returns
   * an unregister fn — call it on unmount. Last writer wins. */
  register: (fn: (() => void | Promise<void>) | null) => () => void;
  /** Invoke the active handler (no-op when none registered). */
  trigger: () => void;
};

/* Split contexts:
 * - SetterContext: stable identity; views subscribe here via useTopBar, no re-render on content change.
 * - ContentContext: changes on every set(); only TopBar subscribes.
 * - ReloadContext: stable identity; TopBar reads `hasHandler` from a separate state slice.
 */
const SetterContext = createContext<Setter | null>(null);
const ContentContext = createContext<TopBarContent>({});
const ReloadContext = createContext<ReloadApi | null>(null);
const ReloadStateContext = createContext<{ hasHandler: boolean }>({
  hasHandler: false,
});

export function TopBarProvider({ children }: { children: ReactNode }) {
  const [content, setContent] = useState<TopBarContent>({});
  const [hasHandler, setHasHandler] = useState(false);
  const handlerRef = useRef<(() => void | Promise<void>) | null>(null);

  const setter = useMemo<Setter>(
    () => ({
      set: (value) => setContent(value),
      clear: () => setContent({}),
    }),
    [],
  );

  const reload = useMemo<ReloadApi>(
    () => ({
      register: (fn) => {
        handlerRef.current = fn;
        setHasHandler(!!fn);
        return () => {
          // Only clear if still the active handler — otherwise a remount race
          // would wipe the new view's registration.
          if (handlerRef.current === fn) {
            handlerRef.current = null;
            setHasHandler(false);
          }
        };
      },
      trigger: () => {
        const fn = handlerRef.current;
        if (fn) void fn();
      },
    }),
    [],
  );

  const reloadState = useMemo(() => ({ hasHandler }), [hasHandler]);

  return (
    <SetterContext.Provider value={setter}>
      <ContentContext.Provider value={content}>
        <ReloadContext.Provider value={reload}>
          <ReloadStateContext.Provider value={reloadState}>
            {children}
          </ReloadStateContext.Provider>
        </ReloadContext.Provider>
      </ContentContext.Provider>
    </SetterContext.Provider>
  );
}

export function useTopBarContent(): TopBarContent {
  return useContext(ContentContext);
}

/**
 * Sets the top-bar title and actions for the lifetime of the calling component.
 * Clears on unmount so stale content never leaks between views.
 *
 * The calling component does NOT re-render when other views update the top bar —
 * it only subscribes to the stable setter, not the content.
 */
export function useTopBar(value: TopBarContent) {
  const setter = useContext(SetterContext);
  if (!setter)
    throw new Error("useTopBar must be used inside <TopBarProvider>");

  // Push the latest value on every render. Only TopBar subscribes to content,
  // so the calling view doesn't re-render from this.
  useEffect(() => {
    setter.set(value);
  });

  // Clear on unmount.
  useEffect(() => {
    return () => setter.clear();
  }, [setter]);
}

// Kept in case future callers want the imperative API.
export function useTopBarSetter(): Setter {
  const setter = useContext(SetterContext);
  if (!setter)
    throw new Error("useTopBarSetter must be used inside <TopBarProvider>");
  return setter;
}

/**
 * Register a reload handler for the global top-bar reload button. Auto-clears
 * on unmount. Pass `null` to disable the button while mounted.
 */
export function useReloadHandler(fn: (() => void | Promise<void>) | null) {
  const ctx = useContext(ReloadContext);
  if (!ctx)
    throw new Error("useReloadHandler must be used inside <TopBarProvider>");

  // Always register the latest closure but only re-run the effect when the
  // enabled/disabled state changes — avoids a register/unregister churn on
  // every parent render.
  const fnRef = useRef(fn);
  useEffect(() => {
    fnRef.current = fn;
  });
  const enabled = fn != null;
  useEffect(() => {
    if (!enabled) return;
    return ctx.register(() => fnRef.current?.());
  }, [ctx, enabled]);
}

export function useReloadTrigger(): {
  trigger: () => void;
  hasHandler: boolean;
} {
  const ctx = useContext(ReloadContext);
  const state = useContext(ReloadStateContext);
  if (!ctx)
    throw new Error("useReloadTrigger must be used inside <TopBarProvider>");
  // Stable callback identity is nice for memoized children.
  const trigger = useCallback(() => ctx.trigger(), [ctx]);
  return { trigger, hasHandler: state.hasHandler };
}
