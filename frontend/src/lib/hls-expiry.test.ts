import { describe, expect, it, vi } from "vitest";

import { onHlsFatalExpiry } from "@/lib/hls-expiry";

// The helper only reads the error-type constants and (un)subscribes — no
// media pipeline needed.
vi.mock("hls.js", () => ({
  default: {
    Events: { ERROR: "hlsError" },
    ErrorTypes: { NETWORK_ERROR: "networkError", MEDIA_ERROR: "mediaError" },
  },
}));

type ErrorHandler = (evt: string, data: unknown) => void;

/** Minimal Hls stand-in capturing the registered ERROR handler. */
function makeHls() {
  const handlers = new Set<ErrorHandler>();
  return {
    hls: {
      on: (_evt: string, fn: ErrorHandler) => handlers.add(fn),
      off: (_evt: string, fn: ErrorHandler) => handlers.delete(fn),
    },
    emit: (data: unknown) => handlers.forEach((fn) => fn("hlsError", data)),
    handlerCount: () => handlers.size,
  };
}

describe("onHlsFatalExpiry", () => {
  it("fires onExpired for a fatal 403 network error", () => {
    const { hls, emit } = makeHls();
    const onExpired = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    onHlsFatalExpiry(hls as any, onExpired);
    emit({
      fatal: true,
      type: "networkError",
      response: { code: 403 },
    });
    expect(onExpired).toHaveBeenCalledTimes(1);
  });

  it("ignores non-fatal errors", () => {
    const { hls, emit } = makeHls();
    const onExpired = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    onHlsFatalExpiry(hls as any, onExpired);
    emit({ fatal: false, type: "networkError", response: { code: 403 } });
    expect(onExpired).not.toHaveBeenCalled();
  });

  it("ignores fatal errors that are not 403 network errors", () => {
    const { hls, emit } = makeHls();
    const onExpired = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    onHlsFatalExpiry(hls as any, onExpired);
    emit({ fatal: true, type: "networkError", response: { code: 404 } });
    emit({ fatal: true, type: "mediaError", response: { code: 403 } });
    emit({ fatal: true, type: "networkError" });
    expect(onExpired).not.toHaveBeenCalled();
  });

  it("stops firing after the returned unsubscribe", () => {
    const { hls, emit, handlerCount } = makeHls();
    const onExpired = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const off = onHlsFatalExpiry(hls as any, onExpired);
    off();
    expect(handlerCount()).toBe(0);
    emit({ fatal: true, type: "networkError", response: { code: 403 } });
    expect(onExpired).not.toHaveBeenCalled();
  });
});
