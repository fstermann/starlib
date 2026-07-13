import { expect, test } from "./fixtures";

/**
 * Bugfix: a SoundCloud → SoundCloud auto-mix chain crossfading TWICE in a row
 * threw `InvalidStateError: Media element is already associated with an audio
 * source node` (WebKit wording) — an element can only be wrapped in a
 * `MediaElementAudioSourceNode` once. Element decks now fade via
 * `element.volume` and never touch the Web Audio graph, so any number of
 * consecutive transitions must run cleanly; the pageerror filter stays as a
 * tripwire against reintroducing per-element source nodes.
 */

/** Silent mono 8-bit WAV of `seconds` at 8kHz — long enough that the ~6s fade
 * leaves a real mix-out point and the element playhead advances to reach it. */
function makeSilentWav(seconds: number): Buffer {
  const rate = 8000;
  const numSamples = rate * seconds;
  const buf = Buffer.alloc(44 + numSamples);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + numSamples, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate, 28);
  buf.writeUInt16LE(1, 32);
  buf.writeUInt16LE(8, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(numSamples, 40);
  buf.fill(0x80, 44);
  return buf;
}

function scTrack(id: number, title: string) {
  return {
    id,
    urn: `soundcloud:tracks:${id}`,
    title,
    user: { id: 1, username: "me" },
    duration: 200_000,
    permalink_url: `https://soundcloud.com/me/${title.toLowerCase()}`,
    waveform_url: `https://wave.sndcdn.com/${id}.png`,
  };
}

async function setup(page: import("@playwright/test").Page) {
  await page.addInitScript(() => {
    window.localStorage.setItem("access_token", "fake-token");
    window.localStorage.setItem(
      "token_expires_at",
      String(Date.now() + 60 * 60 * 1000),
    );
    window.localStorage.setItem(
      "sc_user",
      JSON.stringify({
        id: 1,
        username: "me",
        permalink: "me",
        avatar_url: null,
      }),
    );
  });

  await page.route("https://api.soundcloud.com/me/likes/tracks*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        collection: [
          scTrack(101, "Alpha"),
          scTrack(102, "Beta"),
          scTrack(103, "Gamma"),
        ],
        next_href: null,
      }),
    }),
  );
  await page.route("https://api.soundcloud.com/tracks*", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "[]" }),
  );
  await page.route("https://api.soundcloud.com/me/playlists*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ collection: [], next_href: null }),
    }),
  );
  await page.route("https://api.soundcloud.com/me/feed/tracks*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ collection: [], next_href: null }),
    }),
  );
  await page.route("**/api/metadata/collection/soundcloud-ids", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "[]" }),
  );
  await page.route("**/api/bpm/soundcloud/bulk", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ bpms: {} }),
    }),
  );
  await page.route("**/api/settings/root-folder", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ root_music_folder: "/music" }),
    }),
  );

  // Each track resolves to its own short WAV so the element path actually plays
  // and reaches the mix-out point (a real crossfade, not an .m3u8 stub).
  await page.route("**/api/soundcloud/tracks/*/stream*", (route) => {
    const id =
      route
        .request()
        .url()
        .match(/tracks\/(\d+)\/stream/)?.[1] ?? "0";
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        url: `https://cdn.example.com/sc-${id}.wav`,
        expires_at: new Date(Date.now() + 3600_000).toISOString(),
      }),
    });
  });
  // Distinct lengths so the current-track `duration` changes on each adoption —
  // that's what re-runs the arm effect and fires the *second* crossfade (real
  // tracks always differ; identical lengths would silently skip the re-arm).
  const wavSeconds: Record<string, number> = {
    "101": 10,
    "102": 20,
    "103": 13,
  };
  await page.route("https://cdn.example.com/sc-*.wav", (route) => {
    const id =
      route
        .request()
        .url()
        .match(/sc-(\d+)\.wav/)?.[1] ?? "101";
    route.fulfill({
      status: 200,
      contentType: "audio/wav",
      body: makeSilentWav(wavSeconds[id] ?? 10),
    });
  });
  // SoundCloud pre-baked waveform (fetched as .json): alternating tall/zero
  // samples, so the overlay canvas assertions below can tell bucket-max
  // sampling (every bar tall) apart from point-sampling (half the bars zero).
  await page.route("https://wave.sndcdn.com/*.json", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        width: 1800,
        height: 140,
        samples: Array.from({ length: 1800 }, (_, i) => (i % 2 === 0 ? 0 : 84)),
      }),
    }),
  );
}

test.describe("Auto-mix crossfade — SoundCloud chain", { tag: "@slow" }, () => {
  test("crossfades twice in a row without re-sourcing the adopted element", async ({
    page,
  }) => {
    // Two full ~10s playback→fade cycles run end-to-end.
    test.setTimeout(120_000);
    const sourceNodeErrors: string[] = [];
    page.on("pageerror", (err) => {
      if (/already associated with an audio source node/.test(err.message)) {
        sourceNodeErrors.push(err.message);
      }
    });

    await setup(page);
    await page.goto("/library?source=soundcloud");

    await expect(page.locator("[data-index]")).toHaveCount(3, {
      timeout: 5000,
    });

    // Play Alpha (queues all three; Alpha is current).
    await page
      .locator('[data-index="0"]')
      .getByRole("button", { name: /play/i })
      .first()
      .click()
      .catch(async () => {
        await page.locator('[data-index="0"]').click();
      });

    const player = page.getByTestId("waveform-player");
    await expect(player).toBeVisible();
    await expect(player).toContainText("Alpha");

    // Enable auto-mix (time crossfade — the default mode).
    await player.getByTestId("mix-controls-trigger").click();
    await page.getByTestId("mix-enabled-toggle").click();
    await page.keyboard.press("Escape");

    // First fade (Alpha → Beta) fires at the mix-out point and adopts Beta.
    await expect(player).toHaveAttribute("data-mix-state", "transitioning", {
      timeout: 20000,
    });
    await expect(player.getByTestId("player-next-chip")).toContainText("Beta");
    await expect(player.getByTitle("Beta", { exact: true })).toBeVisible({
      timeout: 20000,
    });
    await expect(player).not.toHaveAttribute(
      "data-mix-state",
      "transitioning",
      {
        timeout: 20000,
      },
    );

    // Second fade (Beta → Gamma) is the regression: it must arm and run over the
    // adopted Beta element instead of throwing on a duplicate source node.
    await expect(player).toHaveAttribute("data-mix-state", "transitioning", {
      timeout: 25000,
    });
    await expect(player.getByTestId("player-next-chip")).toContainText("Gamma");
    await expect(player.getByTitle("Gamma", { exact: true })).toBeVisible({
      timeout: 20000,
    });

    expect(sourceNodeErrors).toEqual([]);
  });

  test("beatgrid mode warns that SoundCloud tracks fall back to crossfade", async ({
    page,
  }) => {
    await setup(page);
    await page.goto("/library?source=soundcloud");
    await expect(page.locator("[data-index]")).toHaveCount(3, {
      timeout: 5000,
    });
    await page
      .locator('[data-index="0"]')
      .getByRole("button", { name: /play/i })
      .first()
      .click()
      .catch(async () => {
        await page.locator('[data-index="0"]').click();
      });
    const player = page.getByTestId("waveform-player");
    await expect(player).toBeVisible();

    // SoundCloud streams have no Rekordbox beatgrid: selecting the beatgrid
    // mode surfaces the crossfade-fallback warning inside its card.
    await player.getByTestId("mix-controls-trigger").click();
    await page.getByTestId("mix-mode-beatgrid").click();
    await expect(
      page
        .getByTestId("mix-mode-beatgrid-card")
        .getByTestId("mix-beatgrid-unavailable"),
    ).toBeVisible();
  });

  test("crossfade overlay renders bars like the resting overview (bucket-max, normalized)", async ({
    page,
  }) => {
    // The overlay's PeaksWaveform must render each bar from the MAX of its
    // bucket of peaks, normalized to the tallest — exactly like the resting
    // WaveSurfer overview. The mocked SC waveform alternates zero/tall
    // samples: bucket-max makes EVERY bar full height, while the old
    // point-sampling left roughly half the bars near zero — the out-going
    // track visibly shrank and got "spikier" the moment the fade began.
    test.setTimeout(60_000);
    await setup(page);
    await page.goto("/library?source=soundcloud");
    await expect(page.locator("[data-index]")).toHaveCount(3, {
      timeout: 5000,
    });
    await page
      .locator('[data-index="0"]')
      .getByRole("button", { name: /play/i })
      .first()
      .click()
      .catch(async () => {
        await page.locator('[data-index="0"]').click();
      });
    const player = page.getByTestId("waveform-player");
    await expect(player).toBeVisible();
    await player.getByTestId("mix-controls-trigger").click();
    await page.getByTestId("mix-enabled-toggle").click();
    await page.keyboard.press("Escape");

    await expect(player).toHaveAttribute("data-mix-state", "transitioning", {
      timeout: 20000,
    });

    const canvas = player
      .getByTestId("player-overview-swipe")
      .locator("canvas")
      .first();
    await expect(canvas).toBeVisible();

    // Fraction of bar columns whose paint reaches the top band of the canvas.
    // Bucket-max + normalize: every bar is full height (→ ~1.0). Point
    // sampling of alternating peaks: roughly half the bars sit at zero.
    let coverage = 0;
    for (let i = 0; i < 8 && coverage < 0.85; i++) {
      coverage = await canvas.evaluate((el: HTMLCanvasElement) => {
        const ctx = el.getContext("2d");
        if (!ctx || el.width === 0 || el.height === 0) return 0;
        const band = Math.max(1, Math.floor(el.height * 0.15));
        const { data } = ctx.getImageData(0, 0, el.width, band);
        const step = 3; // bar width 2px + 1px gap (dpr 1 in the test browser)
        const bars = Math.max(1, Math.floor(el.width / step));
        let tall = 0;
        for (let b = 0; b < bars; b++) {
          const x = b * step;
          let hit = false;
          for (let y = 0; y < band && !hit; y++) {
            if (data[(y * el.width + x) * 4 + 3]! > 0) hit = true;
          }
          if (hit) tall++;
        }
        return tall / bars;
      });
      if (coverage < 0.85) await page.waitForTimeout(300);
    }
    expect(coverage).toBeGreaterThanOrEqual(0.85);
  });

  test("crossfade overlay holds through the adoption seam until the waveform is ready", async ({
    page,
  }) => {
    // When the fade completes and the queue advances, the rebuilt player's
    // waveform takes a moment (peaks + WaveSurfer init). The overlay's settled
    // frame must stay painted across that seam — unmounting it early flashes
    // the stale/blank base row. Beta's full-res peaks are prefetched during
    // Alpha's playback and the adopted init awaits that same in-flight
    // promise, so delaying only the FIRST Beta waveform request (the
    // prefetch) past the fade's end stretches the seam to an observable ~3s
    // without touching the fade itself (the arm-time low-res fetch is the
    // second request).
    test.setTimeout(60_000);
    await setup(page);
    let betaWaveformRequests = 0;
    await page.route("https://wave.sndcdn.com/102.json", async (route) => {
      betaWaveformRequests += 1;
      if (betaWaveformRequests === 1) {
        await new Promise((r) => setTimeout(r, 13_000));
      }
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          width: 1800,
          height: 140,
          samples: Array.from({ length: 1800 }, (_, i) =>
            i % 2 === 0 ? 0 : 84,
          ),
        }),
      });
    });
    await page.goto("/library?source=soundcloud");
    await expect(page.locator("[data-index]")).toHaveCount(3, {
      timeout: 5000,
    });
    await page
      .locator('[data-index="0"]')
      .getByRole("button", { name: /play/i })
      .first()
      .click()
      .catch(async () => {
        await page.locator('[data-index="0"]').click();
      });
    const player = page.getByTestId("waveform-player");
    await expect(player).toBeVisible();
    await player.getByTestId("mix-controls-trigger").click();
    await page.getByTestId("mix-enabled-toggle").click();
    await page.keyboard.press("Escape");

    const overlay = player.getByTestId("player-crossfade-overview");
    await expect(player).toHaveAttribute("data-mix-state", "transitioning", {
      timeout: 20000,
    });
    await expect(overlay).toBeVisible();

    // Fade completes (mix state resets, queue advanced) — the overlay must
    // still be painted in seam mode, since the adopted track's waveform is
    // still seconds away.
    await expect(player).not.toHaveAttribute(
      "data-mix-state",
      "transitioning",
      { timeout: 20000 },
    );
    await expect(overlay).toBeVisible();
    await expect(overlay).toHaveAttribute("data-overlay-mode", "seam");
    // Once the rebuilt waveform is ready the overlay gives way to it.
    await expect(overlay).toBeHidden({ timeout: 10000 });
    await expect(player.getByTitle("Beta", { exact: true })).toBeVisible();
  });

  test("incoming deck fades in already pitched to the target BPM", async ({
    page,
  }) => {
    // With the pitcher active (target 144), the arm step must resolve the
    // incoming track's BPM (backend cache here — Beta has no queue hint) and
    // cue deck B at 144/120 = 1.2 for the whole fade. And the resolved value
    // must stick through adoption: without the queue-hint patch the pitcher
    // reseeds to "unknown" and snaps the rate back to 1.
    test.setTimeout(60_000);
    await setup(page);
    // Alpha carries a BPM hint; Beta's is only in the backend BPM cache.
    await page.route("https://api.soundcloud.com/me/likes/tracks*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          collection: [
            { ...scTrack(101, "Alpha"), bpm: 120 },
            scTrack(102, "Beta"),
            scTrack(103, "Gamma"),
          ],
          next_href: null,
        }),
      }),
    );
    // The table's bulk prefill (many ids) misses; the arm step's single-id
    // lookup for Beta hits.
    await page.route("**/api/bpm/soundcloud/bulk", (route) => {
      const ids = (route.request().postDataJSON() as { track_ids?: number[] })
        ?.track_ids;
      const isArmLookup = ids?.length === 1 && ids[0] === 102;
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ bpms: isArmLookup ? { "102": 120 } : {} }),
      });
    });
    await page.goto("/library?source=soundcloud");
    await expect(page.locator("[data-index]")).toHaveCount(3, {
      timeout: 5000,
    });
    await page
      .locator('[data-index="0"]')
      .getByRole("button", { name: /play/i })
      .first()
      .click()
      .catch(async () => {
        await page.locator('[data-index="0"]').click();
      });
    const player = page.getByTestId("waveform-player");
    await expect(player).toBeVisible();

    // Pitch to 144 BPM globally.
    await page.getByTestId("bpm-pitcher-trigger").click();
    const target = page.getByTestId("bpm-pitcher-target-input");
    await target.fill("144");
    await target.press("Enter");
    await page.getByTestId("bpm-pitcher-toggle").click();
    await page.keyboard.press("Escape");

    await player.getByTestId("mix-controls-trigger").click();
    await page.getByTestId("mix-enabled-toggle").click();
    await page.keyboard.press("Escape");

    await expect(player).toHaveAttribute("data-mix-state", "transitioning", {
      timeout: 20000,
    });
    // Mid-fade, BOTH elements run pitched: deck A at 144/120 and deck B
    // already at 144/120 — not at its natural rate.
    await expect
      .poll(
        () =>
          page.evaluate(() =>
            Array.from(document.querySelectorAll("audio")).map(
              (a) => Math.round(a.playbackRate * 100) / 100,
            ),
          ),
        { timeout: 5000 },
      )
      .toEqual([1.2, 1.2]);

    // After adoption the rate must hold at 1.2 — no snap back to 1 while the
    // pitcher "re-detects" what the arm step already knew.
    await expect(player).not.toHaveAttribute(
      "data-mix-state",
      "transitioning",
      { timeout: 20000 },
    );
    for (let i = 0; i < 6; i++) {
      const rates = await page.evaluate(() =>
        Array.from(document.querySelectorAll("audio")).map(
          (a) => Math.round(a.playbackRate * 100) / 100,
        ),
      );
      expect(rates[0]).toBe(1.2);
      await page.waitForTimeout(250);
    }
  });

  test("slow BPM resolution never blocks the crossfade from arming", async ({
    page,
  }) => {
    // The arm step resolves the incoming track's BPM in the background — a
    // cache lookup or (Tauri) full analysis can outlast the time left to the
    // mix-out point, or hang outright. The fade must still fire on schedule,
    // merely unpitched.
    test.setTimeout(60_000);
    await setup(page);
    await page.route("https://api.soundcloud.com/me/likes/tracks*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          collection: [
            { ...scTrack(101, "Alpha"), bpm: 120 },
            scTrack(102, "Beta"),
            scTrack(103, "Gamma"),
          ],
          next_href: null,
        }),
      }),
    );
    // The BPM backend never answers — worst case for the arm-time resolution.
    await page.route("**/api/bpm/soundcloud/bulk", () => {
      /* hang forever */
    });
    await page.goto("/library?source=soundcloud");
    await expect(page.locator("[data-index]")).toHaveCount(3, {
      timeout: 5000,
    });
    await page
      .locator('[data-index="0"]')
      .getByRole("button", { name: /play/i })
      .first()
      .click()
      .catch(async () => {
        await page.locator('[data-index="0"]').click();
      });
    const player = page.getByTestId("waveform-player");
    await expect(player).toBeVisible();

    await page.getByTestId("bpm-pitcher-trigger").click();
    const target = page.getByTestId("bpm-pitcher-target-input");
    await target.fill("144");
    await target.press("Enter");
    await page.getByTestId("bpm-pitcher-toggle").click();
    await page.keyboard.press("Escape");

    await player.getByTestId("mix-controls-trigger").click();
    await page.getByTestId("mix-enabled-toggle").click();
    await page.keyboard.press("Escape");

    // The fade fires despite the hung resolution (deck B at its natural rate).
    await expect(player).toHaveAttribute("data-mix-state", "transitioning", {
      timeout: 20000,
    });
    await expect(player.getByTitle("Beta", { exact: true })).toBeVisible({
      timeout: 20000,
    });
  });
});
