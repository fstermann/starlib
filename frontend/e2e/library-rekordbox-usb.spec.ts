import type { Route } from "@playwright/test";

import { expect, test } from "./fixtures";

const DEVICE_ID = "/Volumes/TESTUSB";

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
    comment: "soundcloud_id=999",
    soundcloud_id: 999,
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

test.describe("Library: Rekordbox USB export", () => {
  test("select device, load its playlists, and play routes to the USB audio endpoint", async ({
    page,
  }) => {
    let usbAudioHit: string | null = null;

    // One discovered stick.
    await page.route(
      /\/api\/rekordbox\/usb\/devices/,
      jsonRoute({
        devices: [{ id: DEVICE_ID, label: "TESTUSB", mount_path: DEVICE_ID }],
      }),
    );
    // Status available for both local and device.
    await page.route(
      /\/api\/rekordbox\/status/,
      jsonRoute({ available: true, reason: null }),
    );
    // Playlists differ by source: local returns none, the device returns its set.
    await page.route(/\/api\/rekordbox\/playlists(\?|$)/, (route) => {
      const onDevice = route.request().url().includes("device=");
      return jsonRoute({ playlists: onDevice ? USB_PLAYLISTS : [] })(route);
    });
    await page.route(
      /\/api\/rekordbox\/playlists\/[^/]+\/tracks/,
      jsonRoute({ tracks: USB_TRACKS }),
    );
    await page.route(/\/api\/rekordbox\/tracks\/[^/]+\/artwork/, (route) =>
      route.fulfill({
        status: 200,
        contentType: "image/jpeg",
        body: TINY_JPEG,
      }),
    );
    await page.route(/\/api\/rekordbox\/tracks\/[^/]+\/waveform/, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/octet-stream",
        body: WAVEFORM_BYTES,
      }),
    );
    // USB audio endpoint — record that playback routed here (with a device).
    await page.route(/\/api\/rekordbox\/tracks\/[^/]+\/audio/, (route) => {
      usbAudioHit = route.request().url();
      return route.fulfill({
        status: 200,
        contentType: "audio/wav",
        body: makeSilentWav(),
      });
    });

    await page.goto("/library?source=rekordbox");

    // The device picker appears because a stick was discovered.
    const picker = page.getByRole("combobox");
    await expect(picker).toBeVisible();
    await picker.click();
    await page.getByRole("option", { name: "TESTUSB" }).click();

    // Selecting the device puts it in the URL and loads its playlists.
    await expect(page).toHaveURL(/device=/);
    const usbSet = page.getByText("USB Set");
    await expect(usbSet).toBeVisible();

    await usbSet.click();
    const tracks = page.getByTestId("rekordbox-tracks");
    await expect(
      tracks.getByText("On The Stick", { exact: true }),
    ).toBeVisible();

    // Play the track — the cover overlay is the accessible control.
    await tracks.getByRole("button", { name: "Play On The Stick" }).click();
    await expect(page.getByTestId("waveform-player")).toBeVisible();

    // Playback hit the device-scoped audio endpoint, not the local file route.
    await expect
      .poll(() => usbAudioHit)
      .toMatch(/\/api\/rekordbox\/tracks\/u-1\/audio\?device=/);
  });
});
