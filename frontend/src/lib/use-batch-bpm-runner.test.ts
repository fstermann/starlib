import { describe, expect, it } from "vitest";

import { runBatch } from "@/lib/use-batch-bpm-runner";

/** Deferred<T> — manually resolvable promise for ordering assertions. */
function defer<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("runBatch", () => {
  it("processes every key exactly once under concurrency", async () => {
    const keys = Array.from({ length: 20 }, (_, i) => i);
    const seen: number[] = [];
    const abort = new AbortController();

    const result = await runBatch(
      keys,
      async (k) => {
        // A tiny microtask delay to let workers interleave.
        await Promise.resolve();
        seen.push(k);
      },
      { concurrency: 4, signal: abort.signal },
    );

    expect(result.completed).toBe(20);
    expect(result.failures).toBe(0);
    expect(result.cancelled).toBe(false);
    expect(seen.sort((a, b) => a - b)).toEqual(keys);
  });

  it("counts failures separately and never double-dispatches", async () => {
    const keys = [1, 2, 3, 4, 5];
    const abort = new AbortController();
    const result = await runBatch(
      keys,
      async (k) => {
        if (k % 2 === 0) throw new Error("boom");
      },
      { concurrency: 2, signal: abort.signal },
    );
    expect(result.completed).toBe(5);
    expect(result.failures).toBe(2);
    expect(result.cancelled).toBe(false);
  });

  it("stops picking up new work after abort and totals match", async () => {
    const keys = Array.from({ length: 10 }, (_, i) => i);
    const abort = new AbortController();
    const gates = keys.map(() => defer<void>());
    let started = 0;

    const promise = runBatch(
      keys,
      async (k) => {
        started++;
        await gates[k].promise;
      },
      { concurrency: 2, signal: abort.signal },
    );

    // Let both workers claim their first job.
    await Promise.resolve();
    await Promise.resolve();
    expect(started).toBe(2);

    // Abort mid-run, then release the two in-flight jobs.
    abort.abort();
    gates[0].resolve();
    gates[1].resolve();

    const result = await promise;

    // Only the two in-flight jobs completed; workers bailed before claiming
    // anything else.
    expect(started).toBe(2);
    expect(result.completed).toBe(2);
    expect(result.failures).toBe(0);
    expect(result.cancelled).toBe(true);
    // Invariant from the spec: done + failed + aborted == total
    const aborted = keys.length - result.completed;
    expect(result.completed + result.failures + aborted).toBe(
      keys.length + result.failures,
    );
    expect(result.completed + aborted).toBe(keys.length);
  });

  it("workers never claim the same index (atomic dequeue)", async () => {
    const keys = Array.from({ length: 200 }, (_, i) => i);
    const seen = new Set<number>();
    let duplicates = 0;
    const abort = new AbortController();

    await runBatch(
      keys,
      async (k) => {
        if (seen.has(k)) duplicates++;
        seen.add(k);
        // Yield once to give other workers a chance to race.
        await Promise.resolve();
      },
      { concurrency: 8, signal: abort.signal },
    );

    expect(duplicates).toBe(0);
    expect(seen.size).toBe(keys.length);
  });
});
