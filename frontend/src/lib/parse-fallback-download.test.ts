import { describe, expect, it } from "vitest";

import { parseFallbackDownloadUrl } from "./parse-fallback-download";

describe("parseFallbackDownloadUrl", () => {
  it("returns null for empty / nullish input", () => {
    expect(parseFallbackDownloadUrl(null)).toBeNull();
    expect(parseFallbackDownloadUrl(undefined)).toBeNull();
    expect(parseFallbackDownloadUrl("")).toBeNull();
  });

  it("returns null when no known platform URL is present", () => {
    expect(parseFallbackDownloadUrl("Free download below!")).toBeNull();
    expect(
      parseFallbackDownloadUrl("Check out https://example.com/foo.zip"),
    ).toBeNull();
  });

  it("matches bandcamp subdomains", () => {
    expect(
      parseFallbackDownloadUrl(
        "Out now: https://artist.bandcamp.com/track/song-title — enjoy!",
      ),
    ).toBe("https://artist.bandcamp.com/track/song-title");
  });

  it("matches hypeddit URLs", () => {
    expect(
      parseFallbackDownloadUrl("Free DL: http://hypeddit.com/abc123"),
    ).toBe("http://hypeddit.com/abc123");
  });

  it("matches beatport URLs", () => {
    expect(
      parseFallbackDownloadUrl(
        "Buy it: https://www.beatport.com/track/foo/12345.",
      ),
    ).toBe("https://www.beatport.com/track/foo/12345");
  });

  it("returns the first matching URL when multiple are present", () => {
    const desc =
      "Bandcamp: https://artist.bandcamp.com/track/a\nBeatport: https://beatport.com/track/b/2";
    expect(parseFallbackDownloadUrl(desc)).toBe(
      "https://artist.bandcamp.com/track/a",
    );
  });

  it("ignores URLs with similar-looking but unrelated hostnames", () => {
    expect(
      parseFallbackDownloadUrl("https://notbandcamp.fake.com/track/x"),
    ).toBeNull();
    expect(parseFallbackDownloadUrl("https://bandcamp.evil.com/x")).toBeNull();
  });
});
