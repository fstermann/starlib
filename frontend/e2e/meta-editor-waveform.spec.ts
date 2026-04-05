import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

/** Minimal 100ms silent WAV (8kHz mono 8-bit PCM) for mocking audio responses. */
function makeSilentWav(): Buffer {
  const sampleRate = 8000;
  const numSamples = 800; // 100ms
  const buf = Buffer.alloc(44 + numSamples);
  let off = 0;
  buf.write('RIFF', off); off += 4;
  buf.writeUInt32LE(36 + numSamples, off); off += 4;
  buf.write('WAVE', off); off += 4;
  buf.write('fmt ', off); off += 4;
  buf.writeUInt32LE(16, off); off += 4;
  buf.writeUInt16LE(1, off); off += 2; // PCM
  buf.writeUInt16LE(1, off); off += 2; // mono
  buf.writeUInt32LE(sampleRate, off); off += 4;
  buf.writeUInt32LE(sampleRate, off); off += 4; // byte rate
  buf.writeUInt16LE(1, off); off += 2; // block align
  buf.writeUInt16LE(8, off); off += 2; // bits per sample
  buf.write('data', off); off += 4;
  buf.writeUInt32LE(numSamples, off); off += 4;
  buf.fill(0x80, off); // silence (128 = mid-point for unsigned 8-bit PCM)
  return buf;
}

const MOCK_FILE = {
  file_path: 'track.mp3',
  file_name: 'track.mp3',
  file_size: 5 * 1024 * 1024,
  file_format: '.mp3',
  has_artwork: false,
};

const MOCK_TRACK_INFO = {
  file_path: 'track.mp3',
  file_name: 'track.mp3',
  title: 'Test Track',
  artist: 'Test Artist',
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
};

test.describe('Meta editor waveform visibility', () => {
  test.beforeEach(async ({ page }) => {
    // Override file listing to return one file
    await page.route('**/api/metadata/folders/*/files*', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ items: [MOCK_FILE], total: 1, page: 1, size: 50, pages: 1 }),
      }),
    );

    // Mock track info endpoint
    await page.route('**/api/metadata/files/*/info', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(MOCK_TRACK_INFO),
      }),
    );

    // Mock peaks endpoint to prevent errors in WaveformPlayer
    await page.route('**/api/metadata/files/*/peaks*', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ peaks: Array(200).fill(0.3) }),
      }),
    );
  });

  async function selectFileAndWaitForPlayer(page: Page) {
    await page.goto('/meta-editor');
    await page.waitForLoadState('networkidle');
    await page.locator('[data-file-path="track.mp3"]').click();
    await expect(page.getByTestId('waveform-player')).toBeVisible();
  }

  test('waveform is hidden when switching collection modes', async ({ page }) => {
    await selectFileAndWaitForPlayer(page);

    // Switch from 'prepare' to 'collection' mode
    await page.getByRole('radio', { name: 'collection' }).click();

    await expect(page.getByTestId('waveform-player')).not.toBeVisible();
  });

  test('waveform is hidden when navigating away from meta editor', async ({ page }) => {
    await selectFileAndWaitForPlayer(page);

    // Navigate to the home page via the sidebar logo
    await page.locator('aside').getByRole('link', { name: /Starlib/i }).click();
    await expect(page).toHaveURL('/');

    await expect(page.getByTestId('waveform-player')).not.toBeVisible();
  });
});

test.describe('Meta editor track playback', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/metadata/folders/*/files*', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ items: [MOCK_FILE], total: 1, page: 1, size: 50, pages: 1 }),
      }),
    );

    await page.route('**/api/metadata/files/*/info', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(MOCK_TRACK_INFO),
      }),
    );

    await page.route('**/api/metadata/files/*/peaks*', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ peaks: Array(200).fill(0.3) }),
      }),
    );

    // Mock the audio endpoint with a real WAV so the browser resolves audio.duration.
    await page.route('**/api/metadata/files/*/audio', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'audio/wav',
        headers: { 'Accept-Ranges': 'bytes' },
        body: makeSilentWav(),
      }),
    );
  });

  test('play button becomes enabled after selecting a track', async ({ page }) => {
    await page.goto('/meta-editor');
    await page.waitForLoadState('networkidle');
    await page.locator('[data-file-path="track.mp3"]').click();

    await expect(page.getByTestId('waveform-player')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Play' })).toBeEnabled({ timeout: 10_000 });
  });

  test('clicking play switches button to pause', async ({ page }) => {
    await page.goto('/meta-editor');
    await page.waitForLoadState('networkidle');
    await page.locator('[data-file-path="track.mp3"]').click();

    const playBtn = page.getByRole('button', { name: 'Play' });
    await expect(playBtn).toBeEnabled({ timeout: 10_000 });
    await playBtn.click();

    await expect(page.getByRole('button', { name: 'Pause' })).toBeVisible();
  });
});
