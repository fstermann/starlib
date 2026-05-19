import { useCallback, useEffect, useReducer, useRef, useState } from "react";

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

type Status = "idle" | "running" | "aborted" | "finished";

interface RunnerState {
  completed: number;
  failed: number;
  total: number;
  status: Status;
}

type RunnerAction =
  | { type: "start"; total: number }
  | { type: "complete" }
  | { type: "fail" }
  | { type: "abort" }
  | { type: "finish" };

const initialState: RunnerState = {
  completed: 0,
  failed: 0,
  total: 0,
  status: "idle",
};

function reducer(state: RunnerState, action: RunnerAction): RunnerState {
  switch (action.type) {
    case "start":
      return {
        completed: 0,
        failed: 0,
        total: action.total,
        status: "running",
      };
    case "complete":
      return { ...state, completed: state.completed + 1 };
    case "fail":
      // A failure also counts as a completion — `done` in the UI is "units
      // of work finished" whether they succeeded or not.
      return {
        ...state,
        completed: state.completed + 1,
        failed: state.failed + 1,
      };
    case "abort":
      if (state.status !== "running") return state;
      return { ...state, status: "aborted" };
    case "finish":
      if (state.status === "aborted") return state;
      return { ...state, status: "finished" };
    default:
      return state;
  }
}

/** Pure batch executor — runs `run(key)` over `keys` with bounded concurrency.
 *
 * Exposed separately from the React hook so it can be unit-tested without a
 * DOM. Workers claim indices from a shared cursor atomically (no closure
 * counter races); aborting flips a status flag that each worker checks before
 * picking up its next job.
 */
export async function runBatch<TKey>(
  keys: TKey[],
  run: (key: TKey, signal: AbortSignal) => Promise<void>,
  opts: {
    concurrency: number;
    signal: AbortSignal;
    onProgress?: (snapshot: {
      completed: number;
      failed: number;
      total: number;
    }) => void;
  },
): Promise<{ completed: number; failures: number; cancelled: boolean }> {
  const total = keys.length;
  if (total === 0) return { completed: 0, failures: 0, cancelled: false };

  const state = { cursor: 0, completed: 0, failed: 0 };

  const claimNext = (): number | null => {
    if (opts.signal.aborted) return null;
    if (state.cursor >= total) return null;
    return state.cursor++;
  };

  const emit = () =>
    opts.onProgress?.({
      completed: state.completed,
      failed: state.failed,
      total,
    });

  const worker = async () => {
    while (true) {
      if (opts.signal.aborted) return;
      const idx = claimNext();
      if (idx === null) return;
      try {
        await run(keys[idx], opts.signal);
        state.completed++;
      } catch {
        state.completed++;
        state.failed++;
      }
      emit();
    }
  };

  emit();
  await Promise.all(
    Array.from({ length: Math.max(1, opts.concurrency) }, () => worker()),
  );

  return {
    completed: state.completed,
    failures: state.failed,
    cancelled: opts.signal.aborted,
  };
}

export function useBatchBpmRunner(concurrency: number) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const abortRef = useRef<AbortController | null>(null);

  // Abort the in-flight batch when the owning component unmounts so we don't
  // keep chewing through work against a detached toast sink.
  useEffect(() => () => abortRef.current?.abort(), []);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    dispatch({ type: "abort" });
  }, []);

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

      dispatch({ type: "start", total: keys.length });

      // Translate executor snapshots into reducer deltas. Executor's
      // `completed` is total-finished (success + fail); `fail` action in the
      // reducer already bumps the completed counter, so we fire one action
      // per unit of work: a `fail` when the failure count rose, else a
      // `complete`.
      let lastCompleted = 0;
      let lastFailed = 0;
      const result = await runBatch(keys, run, {
        concurrency,
        signal: abort.signal,
        onProgress: ({ completed, failed }) => {
          const failDelta = failed - lastFailed;
          const totalDelta = completed - lastCompleted;
          const successDelta = totalDelta - failDelta;
          for (let i = 0; i < failDelta; i++) dispatch({ type: "fail" });
          for (let i = 0; i < successDelta; i++) dispatch({ type: "complete" });
          lastCompleted = completed;
          lastFailed = failed;
        },
      });

      dispatch({ type: "finish" });
      return result;
    },
    [concurrency],
  );

  return {
    running: state.status === "running",
    total: state.total,
    done: state.completed,
    failed: state.failed,
    cancel,
    start,
  };
}

/** localStorage-backed "use consensus (median-of-3-windows) mode" toggle,
 * shared across the SC and filesystem batch buttons. */
const CONSENSUS_KEY = "starlib:bpm:batch:consensus";
/** localStorage-backed "use stronger (DP beat-tracker) algorithm" toggle.
 * Composes orthogonally with the consensus toggle: consensus controls
 * *which windows* we score, strong controls *which tempo estimator*
 * scores them. */
const STRONG_KEY = "starlib:bpm:batch:strong";

function usePersistedBool(key: string): [boolean, (v: boolean) => void] {
  const [value, setValue] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem(key) === "1";
  });
  const set = useCallback(
    (v: boolean) => {
      setValue(v);
      if (typeof window !== "undefined") {
        window.localStorage.setItem(key, v ? "1" : "0");
      }
    },
    [key],
  );
  return [value, set];
}

export function useConsensusPref(): [boolean, (v: boolean) => void] {
  return usePersistedBool(CONSENSUS_KEY);
}

export function useStrongPref(): [boolean, (v: boolean) => void] {
  return usePersistedBool(STRONG_KEY);
}
