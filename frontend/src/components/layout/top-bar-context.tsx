"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
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

/* Split contexts:
 * - SetterContext: stable identity; views subscribe here via useTopBar, no re-render on content change.
 * - ContentContext: changes on every set(); only TopBar subscribes.
 */
const SetterContext = createContext<Setter | null>(null);
const ContentContext = createContext<TopBarContent>({});

export function TopBarProvider({ children }: { children: ReactNode }) {
  const [content, setContent] = useState<TopBarContent>({});

  const setter = useMemo<Setter>(
    () => ({
      set: (value) => setContent(value),
      clear: () => setContent({}),
    }),
    [],
  );

  return (
    <SetterContext.Provider value={setter}>
      <ContentContext.Provider value={content}>
        {children}
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
