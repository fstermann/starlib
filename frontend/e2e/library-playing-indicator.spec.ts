import type { Page } from "@playwright/test";

import { expect, test } from "./fixtures";

/**
 * The filesystem library marks the *playing* track — green highlight
 * (aria-current) + a persistent Pause on its cover — the same way the
 * SoundCloud and Rekordbox tables do. Crucially this follows the track in the
 * player, not the row whose single-track editor is open. Regression: the
 * filesystem cover's play/pause state (and the green row) tracked the *edited*
 * row, so a track played from its cover had no constant indicator.
 */

/** Silent mono 8-bit WAV of `seconds` at 8kHz. Long enough that playback does
 * not finish (and auto-advance) during the assertions. */
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

function file(name: string) {
  return {
    file_path: name,
    file_name: name,
    file_size: 5 * 1024 * 1024,
    file_format: ".mp3",
    has_artwork: false,
  };
}

async function setup(page: Page) {
  const listing = {
    items: [file("a.mp3"), file("b.mp3")],
    total: 2,
    page: 1,
    size: 50,
    pages: 1,
  };
  await page.route("**/api/metadata/folders/*/browse*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(listing),
    }),
  );
  await page.route(/\/api\/metadata\/folders\/browse-path\?/, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(listing),
    }),
  );
  await page.route("**/api/metadata/files/*/info", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        file_path: "a.mp3",
        file_name: "a.mp3",
        title: null,
        artist: null,
        bpm: null,
        key: null,
        genre: null,
        comment: null,
        release_date: null,
        remixers: [],
        has_artwork: false,
        is_ready: false,
        missing_fields: [],
        issues: [],
      }),
    }),
  );
  await page.route("**/api/metadata/files/*/peaks*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ peaks: Array(200).fill(0.3) }),
    }),
  );
  await page.route("**/api/metadata/files/*/audio", (route) =>
    route.fulfill({
      status: 200,
      contentType: "audio/wav",
      body: makeSilentWav(30),
    }),
  );
}

const rowFor = (page: Page, name: string) =>
  page.locator(`[role="row"]:has([data-file-path="${name}"])`).first();

const coverOverlay = (page: Page, name: string) =>
  page
    .getByRole("button", { name: new RegExp(name.replace(".", "\\.")) })
    .locator("span")
    .first();

test("filesystem marks the playing track green + Pause, not the edited row", async ({
  page,
}) => {
  await setup(page);
  await page.goto("/library");
  await page.waitForLoadState("networkidle");

  const rowA = rowFor(page, "a.mp3");
  const rowB = rowFor(page, "b.mp3");

  // Open A's single-track editor by clicking its row (also loads A, paused).
  await rowA.locator('[data-file-path="a.mp3"]').click();
  await expect(page.getByTestId("waveform-player")).toBeVisible();

  // Now play B from its cover. B becomes the playing track while the editor
  // stays open on A.
  await page.getByRole("button", { name: "Play b.mp3" }).click();
  await page.mouse.move(0, 0);

  // B is the playing row: marked, with a persistent Pause overlay (no hover).
  await expect(rowB).toHaveAttribute("aria-current", "true");
  await expect(page.getByRole("button", { name: "Pause b.mp3" })).toBeVisible();
  await expect(coverOverlay(page, "b.mp3")).toHaveCSS("opacity", "1");

  // A — still the edited row — is NOT marked as playing and its cover is idle.
  await expect(rowA).not.toHaveAttribute("aria-current", "true");
  await expect(page.getByRole("button", { name: "Play a.mp3" })).toBeVisible();
  await expect(coverOverlay(page, "a.mp3")).toHaveCSS("opacity", "0");
});
