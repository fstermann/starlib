import type { Page, Route } from "@playwright/test";

import { expect, test } from "./fixtures";

const DEVICE_ID = "/Volumes/TESTUSB";
const DEVICE = { id: DEVICE_ID, label: "TESTUSB", mount_path: DEVICE_ID };

const USB_PLAYLISTS = [
  {
    id: "usb-pl-1",
    name: "USB Set",
    parent_id: null,
    is_folder: false,
    is_smart: false,
    track_count: 1,
  },
];

const USB_TRACKS = [
  {
    id: "u-1",
    title: "On The Stick",
    artist: "DJ USB",
    album: null,
    genre: "House",
    bpm: 126,
    key: "8A",
    duration_seconds: 300,
    file_path: "/Contents/DJ USB/On The Stick.mp3",
    comment: null,
    soundcloud_id: null,
    date_added: "2025-05-01",
    release_date: "2025-04-01",
    has_artwork: true,
    has_waveform: true,
  },
];

const TINY_JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==",
  "base64",
);
const WAVEFORM_BYTES = Buffer.alloc(7200);

function makeSilentWav(): Buffer {
  const numSamples = 800;
  const buf = Buffer.alloc(44 + numSamples);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + numSamples, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(8000, 24);
  buf.writeUInt32LE(8000, 28);
  buf.writeUInt16LE(1, 32);
  buf.writeUInt16LE(8, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(numSamples, 40);
  buf.fill(0x80, 44);
  return buf;
}

function jsonRoute(body: unknown) {
  return (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
}

/** Mock everything except device discovery (each test drives that itself). */
async function mockLibrary(page: Page): Promise<void> {
  await page.route(
    /\/api\/rekordbox\/status/,
    jsonRoute({ available: true, reason: null }),
  );
  await page.route(/\/api\/rekordbox\/playlists(\?|$)/, (route) =>
    jsonRoute({
      playlists: route.request().url().includes("device=") ? USB_PLAYLISTS : [],
    })(route),
  );
  await page.route(
    /\/api\/rekordbox\/playlists\/[^/]+\/tracks/,
    jsonRoute({ tracks: USB_TRACKS }),
  );
  await page.route(/\/api\/rekordbox\/tracks\/[^/]+\/artwork/, (route) =>
    route.fulfill({ status: 200, contentType: "image/jpeg", body: TINY_JPEG }),
  );
  await page.route(/\/api\/rekordbox\/tracks\/[^/]+\/waveform/, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/octet-stream",
      body: WAVEFORM_BYTES,
    }),
  );
}

async function selectDevice(page: Page): Promise<void> {
  await page.getByRole("combobox").click();
  await page.getByRole("option", { name: "TESTUSB" }).click();
  await expect(page).toHaveURL(/device=/);
}

test.describe("Library: Rekordbox USB export", () => {
  test("select device, load its playlists, and play routes to the USB audio endpoint", async ({
    page,
  }) => {
    let usbAudioHit: string | null = null;
    await mockLibrary(page);
    await page.route(
      /\/api\/rekordbox\/usb\/devices/,
      jsonRoute({ devices: [DEVICE] }),
    );
    await page.route(/\/api\/rekordbox\/tracks\/[^/]+\/audio/, (route) => {
      usbAudioHit = route.request().url();
      return route.fulfill({
        status: 200,
        contentType: "audio/wav",
        body: makeSilentWav(),
      });
    });

    await page.goto("/library?source=rekordbox");
    await selectDevice(page);

    const usbSet = page.getByText("USB Set");
    await expect(usbSet).toBeVisible();
    await usbSet.click();
    const tracks = page.getByTestId("rekordbox-tracks");
    await expect(
      tracks.getByText("On The Stick", { exact: true }),
    ).toBeVisible();

    await tracks.getByRole("button", { name: "Play On The Stick" }).click();
    await expect(page.getByTestId("waveform-player")).toBeVisible();
    await expect
      .poll(() => usbAudioHit)
      .toMatch(/\/api\/rekordbox\/tracks\/u-1\/audio\?device=/);
  });

  test("waveform-style setting switches the player to the Rekordbox coloured waveform", async ({
    page,
  }) => {
    const waveformVariants: string[] = [];
    await mockLibrary(page);
    await page.route(
      /\/api\/rekordbox\/usb\/devices/,
      jsonRoute({ devices: [DEVICE] }),
    );
    await page.route(/\/api\/rekordbox\/tracks\/[^/]+\/audio/, (route) =>
      route.fulfill({
        status: 200,
        contentType: "audio/wav",
        body: makeSilentWav(),
      }),
    );
    // Re-route waveform to record the requested variant (color | blue).
    await page.route(/\/api\/rekordbox\/tracks\/[^/]+\/waveform/, (route) => {
      const v =
        new URL(route.request().url()).searchParams.get("variant") ?? "color";
      waveformVariants.push(v);
      return route.fulfill({
        status: 200,
        contentType: "application/octet-stream",
        body: WAVEFORM_BYTES,
      });
    });

    await page.goto("/library?source=rekordbox");
    await selectDevice(page);
    await page.getByText("USB Set").click();
    const tracks = page.getByTestId("rekordbox-tracks");
    await tracks.getByRole("button", { name: "Play On The Stick" }).click();
    await expect(page.getByTestId("waveform-player")).toBeVisible();

    // Default style: the Starlib (WaveSurfer) waveform, no Rekordbox overlay.
    await expect(page.getByTestId("player-rekordbox-waveform")).toHaveCount(0);

    // Switch to Rekordbox Blue via Settings → Library.
    await page.locator('button[aria-label="Settings"]').click();
    const dialog = page.locator('[data-slot="dialog-content"]');
    await dialog.getByText("Library", { exact: true }).click();
    await dialog.getByRole("radio", { name: "Rekordbox Blue" }).click();
    await page.keyboard.press("Escape");

    // The coloured overlay renders and the blue PWAV variant is fetched.
    const overlay = page.getByTestId("player-rekordbox-waveform");
    await expect(overlay).toBeVisible();
    await expect(overlay).toHaveAttribute("data-variant", "blue");
    await expect.poll(() => waveformVariants).toContain("blue");
  });

  test("eject button unmounts the device and returns to the local install", async ({
    page,
  }) => {
    let ejectHit: string | null = null;
    await mockLibrary(page);
    await page.route(
      /\/api\/rekordbox\/usb\/devices/,
      jsonRoute({ devices: [DEVICE] }),
    );
    await page.route(/\/api\/rekordbox\/usb\/eject/, (route) => {
      ejectHit = route.request().url();
      return jsonRoute({ ok: true })(route);
    });

    await page.goto("/library?source=rekordbox");
    await selectDevice(page);

    await page.getByRole("button", { name: "Eject USB" }).click();
    await expect.poll(() => ejectHit).toMatch(/\/usb\/eject\?device=/);
    // Selection falls back to the local install.
    await expect(page).not.toHaveURL(/device=/);
    await expect(page.getByRole("button", { name: "Eject USB" })).toHaveCount(
      0,
    );
  });

  test("auto-recovers to the local install when the device is unplugged", async ({
    page,
  }) => {
    let present = true;
    await mockLibrary(page);
    await page.route(/\/api\/rekordbox\/usb\/devices/, (route) =>
      jsonRoute({ devices: present ? [DEVICE] : [] })(route),
    );

    await page.goto("/library?source=rekordbox");
    await selectDevice(page);

    // Unplug: the next device poll (every 4s) no longer lists it.
    present = false;
    await expect(page).not.toHaveURL(/device=/, { timeout: 8000 });
  });
});
