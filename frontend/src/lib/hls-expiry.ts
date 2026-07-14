/**
 * Shared hls.js expired-stream detection. A fatal NETWORK_ERROR with a 403
 * response means the signed CDN URL expired (or the track is restricted) —
 * the player maps that to a stream-URL refresh. Used by both the normal
 * attach path and a crossfade-adopted deck's Hls instance.
 */

import Hls, { type ErrorData, type Events } from "hls.js";

/** Call `onExpired` when `hls` hits a fatal 403 network error. Returns an
 * unsubscribe fn (destroying the Hls instance also detaches the listener). */
export function onHlsFatalExpiry(hls: Hls, onExpired: () => void): () => void {
  const handler = (_evt: Events.ERROR, data: ErrorData) => {
    if (!data.fatal) return;
    const status = data.response?.code;
    if (data.type === Hls.ErrorTypes.NETWORK_ERROR && status === 403) {
      onExpired();
    }
  };
  hls.on(Hls.Events.ERROR, handler);
  return () => hls.off(Hls.Events.ERROR, handler);
}
