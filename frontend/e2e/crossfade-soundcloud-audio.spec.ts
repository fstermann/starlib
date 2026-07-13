import { expect, test } from "./fixtures";

/**
 * Bugfix: SoundCloud → SoundCloud crossfades were inaudible as fades — the
 * incoming deck started at full volume and the out-going one didn't fade.
 * Element decks used to be faded through the Web Audio graph
 * (`createMediaElementSource` → gain), but WebKit (Tauri's WKWebView, Safari)
 * never captures MSE-backed elements into the graph, so the gain ramp
 * controlled silence while the element played on at full volume. Element decks
 * now fade via `element.volume`, which every engine honors — this spec asserts
 * both elements' volumes actually crossfade.
 */

/** Silent mono 8-bit WAV of `seconds` at 8kHz — the fade is asserted on
 * `element.volume`, so the content can stay silent. */
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
        collection: [scTrack(101, "Alpha"), scTrack(102, "Beta")],
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
  await page.route("https://cdn.example.com/sc-*.wav", (route) =>
    route.fulfill({
      status: 200,
      contentType: "audio/wav",
      body: makeSilentWav(10),
    }),
  );
}

test.describe(
  "Auto-mix crossfade — SoundCloud volume fade",
  { tag: "@slow" },
  () => {
    test("both elements' volumes crossfade (incoming does not start at full volume)", async ({
      page,
    }) => {
      test.setTimeout(60_000);
      await setup(page);
      await page.goto("/library?source=soundcloud");

      await expect(page.locator("[data-index]")).toHaveCount(2, {
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

      // Sample element volumes through the fade. DOM order: [0] = out-going
      // deck A (created at init), [1] = incoming deck B (created at arming).
      // Require a mid-fade sample where BOTH are strictly between the endpoints
      // — the old Web Audio path left them pinned at 1 and 0 for the whole fade.
      let midFade: { a: number; b: number } | null = null;
      const first = await page.evaluate(() =>
        Array.from(document.querySelectorAll("audio")).map((a) => a.volume),
      );
      for (let i = 0; i < 20 && !midFade; i++) {
        const vols = await page.evaluate(() =>
          Array.from(document.querySelectorAll("audio")).map((a) => a.volume),
        );
        if (
          vols.length === 2 &&
          vols[0]! > 0.1 &&
          vols[0]! < 0.9 &&
          vols[1]! > 0.1 &&
          vols[1]! < 0.9
        ) {
          midFade = { a: vols[0]!, b: vols[1]! };
        }
        if (!midFade) await page.waitForTimeout(250);
      }
      expect(first.length).toBe(2);
      expect(midFade).not.toBeNull();

      // The fade completes: Beta is adopted and its element sits at full volume.
      await expect(player.getByTitle("Beta", { exact: true })).toBeVisible({
        timeout: 20000,
      });
      await expect
        .poll(
          () =>
            page.evaluate(() =>
              Array.from(document.querySelectorAll("audio")).map(
                (a) => a.volume,
              ),
            ),
          { timeout: 15000 },
        )
        .toEqual([1]);
    });
  },
);
