import { useCallback, useEffect, useRef, useState } from "react";

/** Generic task-runner for BPM batch scans: bounded concurrency, cancellable,
 * progress counters. The caller supplies one `run(key)` function and the list
 * of keys to work through. */
export interface BatchRunnerState {
  running: boolean;
  total: number;
  done: number;
  failed: number;
  cancel: () => void;
}

export function useBatchBpmRunner(concurrency: number) {
  const [running, setRunning] = useState(false);
  const [total, setTotal] = useState(0);
  const [done, setDone] = useState(0);
  const [failed, setFailed] = useState(0);
  const abortRef = useRef<AbortController | null>(null);

  // Abort the in-flight batch when the owning component unmounts so we don't
  // keep chewing through work against a detached toast sink.
  useEffect(() => () => abortRef.current?.abort(), []);

  const cancel = useCallback(() => abortRef.current?.abort(), []);

  const start = useCallback(
    async <TKey>(
      keys: TKey[],
      run: (key: TKey, signal: AbortSignal) => Promise<void>,
    ) => {
      if (keys.length === 0)
        return { completed: 0, failures: 0, cancelled: false };
      abortRef.current?.abort();
      const abort = new AbortController();
      abortRef.current = abort;
      setRunning(true);
      setTotal(keys.length);
      setDone(0);
      setFailed(0);

      let cursor = 0;
      let completed = 0;
      let failures = 0;

      const worker = async () => {
        while (!abort.signal.aborted) {
          const idx = cursor++;
          if (idx >= keys.length) return;
          try {
            await run(keys[idx], abort.signal);
          } catch {
            failures++;
            setFailed(failures);
          }
          completed++;
          setDone(completed);
        }
      };

      await Promise.all(
        Array.from({ length: Math.max(1, concurrency) }, () => worker()),
      );
      setRunning(false);
      return {
        completed,
        failures,
        cancelled: abort.signal.aborted,
      };
    },
    [concurrency],
  );

  return { running, total, done, failed, cancel, start };
}

/** localStorage-backed "use high accuracy (consensus) mode" toggle, shared
 * across the SC and filesystem batch buttons. */
const STORAGE_KEY = "bpm.batch.consensus";

export function useConsensusPref(): [boolean, (v: boolean) => void] {
  const [value, setValue] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem(STORAGE_KEY) === "1";
  });
  const set = useCallback((v: boolean) => {
    setValue(v);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(STORAGE_KEY, v ? "1" : "0");
    }
  }, []);
  return [value, set];
}
