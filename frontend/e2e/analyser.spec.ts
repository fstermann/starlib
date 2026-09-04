import { type Page, type Route } from "@playwright/test";

import { expect, test } from "./fixtures";

/**
 * E2E coverage for the Set Analyser feature (#403).
 *
 * The analyser pipeline is fully mocked at the API boundary — the real
 * Rust subprocess + SoundCloud + Shazam never run. The fixtures here mimic
 * the SSE stream the backend would emit for a job so we can validate the
 * URL paste flow, live timeline updates, and re-analyse round-trip without
 * a running backend.
 */

const FAKE_JOB_ID = "test-job-1";

interface FakeSseLine {
  event: string;
  data: Record<string, unknown>;
}

/** A minimal, valid PCM WAV of ``seconds`` of silence so WaveSurfer can
 *  actually decode + play the set audio in tests (an empty body never
 *  reaches "ready", so the playhead never advances). */
function silentWav(seconds = 2): Buffer {
  const sampleRate = 8000;
  const numSamples = sampleRate * seconds;
  const dataSize = numSamples * 2; // 16-bit mono
  const buf = Buffer.alloc(44 + dataSize);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write("data", 36);
  buf.writeUInt32LE(dataSize, 40);
  return buf; // samples left zeroed = silence
}

function sseBody(lines: FakeSseLine[]): string {
  return (
    lines
      .map(
        ({ event, data }) =>
          `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
      )
      .join("") + "\n"
  );
}

async function mockAnalyserApi(page: Page) {
  // The new SetWaveform component fetches the cached audio. Mock it as
  // an empty body (the WaveSurfer instance won't decode anything but
  // tests don't hover/play it, so this is fine).
  await page.route(/\/api\/analyser\/sets\/[^/?]+\/audio$/, (route) =>
    route.fulfill({
      status: 200,
      contentType: "audio/mp4",
      headers: { "Accept-Ranges": "bytes" },
      body: "",
    }),
  );
  await page.route(/\/api\/analyser\/sets$/, (route: Route) => {
    if (route.request().method() === "POST") {
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ job_id: FAKE_JOB_ID }),
      });
      return;
    }
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ jobs: [] }),
    });
  });

  await page.route(/\/api\/analyser\/sets\/[^/?]+\?/, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ jobs: [] }),
    }),
  );

  await page.route(new RegExp(`/api/analyser/sets/${FAKE_JOB_ID}$`), (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        id: FAKE_JOB_ID,
        soundcloud_id: 12345,
        source_url: "https://soundcloud.com/dj/test-set",
        title: "Test Set",
        artist: "Test Artist",
        duration_s: 90.0,
        status: "running",
        options: {
          pitch_strategy: "none",
          window_s: 30,
          hop_s: 25,
          min_section_gap_s: 30,
          sections_enabled: true,
          scan_cadence_s: 45,
          scan_window_s: 12,
        },
        error: null,
        created_at: 0,
        updated_at: 0,
        windows: [],
        sections: [],
        scans: [],
        timeline: [],
      }),
    }),
  );

  await page.route(
    new RegExp(`/api/analyser/sets/${FAKE_JOB_ID}/events$`),
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        headers: { "Cache-Control": "no-cache" },
        body: sseBody([
          {
            event: "meta",
            data: {
              type: "meta",
              job_id: FAKE_JOB_ID,
              duration_s: 90.0,
              sample_rate: 22050,
              title: "Test Set",
              artist: "Test Artist",
            },
          },
          {
            event: "window.bpm",
            data: {
              type: "window.bpm",
              job_id: FAKE_JOB_ID,
              start_s: 0,
              end_s: 30,
              bpm: 128.0,
              confidence: "high",
            },
          },
          {
            event: "window.bpm",
            data: {
              type: "window.bpm",
              job_id: FAKE_JOB_ID,
              start_s: 25,
              end_s: 55,
              bpm: 128.0,
              confidence: "high",
            },
          },
          {
            event: "section.detected",
            data: {
              type: "section.detected",
              job_id: FAKE_JOB_ID,
              section_index: 0,
              start_s: 0.0,
              end_s: 45.0,
              confidence: 1.0,
            },
          },
          {
            event: "section.detected",
            data: {
              type: "section.detected",
              job_id: FAKE_JOB_ID,
              section_index: 1,
              start_s: 45.0,
              end_s: 90.0,
              confidence: 0.0,
            },
          },
          {
            event: "shazam.scan",
            data: {
              type: "shazam.scan",
              job_id: FAKE_JOB_ID,
              scan_s: 0.0,
              title: "Mock Track A",
              artist: "Mock Artist A",
              shazam_id: "abc123",
              confidence: 0.9,
              pitch_offset: 0.0,
            },
          },
          {
            event: "track.timeline",
            data: {
              type: "track.timeline",
              job_id: FAKE_JOB_ID,
              start_s: 0.0,
              end_s: 30.0,
              title: "Mock Track A",
              artist: "Mock Artist A",
              shazam_id: "abc123",
              confidence: 0.9,
              source: "shazam",
              override_id: 1,
            },
          },
          {
            event: "job.complete",
            data: { type: "job.complete", job_id: FAKE_JOB_ID },
          },
        ]),
      }),
  );

  let reanalysePosts = 0;
  await page.route(
    new RegExp(`/api/analyser/sets/${FAKE_JOB_ID}/reanalyse$`),
    (route) => {
      reanalysePosts += 1;
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          job_id: FAKE_JOB_ID,
          scheduled_ranges: [{ start_s: 0, end_s: 30 }],
        }),
      });
    },
  );

  return {
    reanalyseCallCount: () => reanalysePosts,
  };
}

test.describe("Set Analyser", () => {
  test("paste-url flow loads timeline + tracks from SSE", async ({ page }) => {
    await mockAnalyserApi(page);
    await page.goto("/analyser");

    await expect(page.getByTestId("analyser-start-screen")).toBeVisible();
    await page
      .getByTestId("analyser-url-input")
      .fill("https://soundcloud.com/dj/test-set");
    await page.getByTestId("analyser-start-button").click();

    await expect(page.getByTestId("analyser-main")).toBeVisible();
    await expect(page).toHaveURL(/\/analyser\?job=test-job-1/);
    await expect(page.getByTestId("analyser-header")).toContainText("Test Set");
    await expect(page.getByTestId("analyser-status")).toHaveText(/Complete/i);

    // Matched track surfaces from the SSE replay.
    await expect(page.getByTestId("tracklist-rows")).toContainText(
      "Mock Track A",
    );
    await expect(page.getByTestId("track-band")).toHaveCount(1);
    // BPM-run labels are gated on a minimum number of consecutive
    // windows sharing a rounded BPM — the mock only has 2 windows so
    // no label is rendered. (Covered separately below with a longer
    // window stream.)
    await expect(page.getByTestId("bpm-run-label")).toHaveCount(0);
  });

  test("navigating to a different ?job= URL switches the loaded job", async ({
    page,
  }) => {
    const SECOND_JOB = "test-job-2";

    await mockAnalyserApi(page);
    // Snapshot + SSE for the second job so the page can render it after nav.
    await page.route(new RegExp(`/api/analyser/sets/${SECOND_JOB}$`), (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          id: SECOND_JOB,
          soundcloud_id: 67890,
          source_url: null,
          title: "Second Set",
          artist: "Second Artist",
          duration_s: 60.0,
          status: "complete",
          options: {
            pitch_strategy: "none",
            window_s: 30,
            hop_s: 25,
            min_section_gap_s: 30,
            sections_enabled: true,
          },
          error: null,
          created_at: 0,
          updated_at: 0,
          windows: [],
          sections: [],
          scans: [],
          timeline: [],
        }),
      }),
    );
    await page.route(
      new RegExp(`/api/analyser/sets/${SECOND_JOB}/events$`),
      (route) =>
        route.fulfill({
          status: 200,
          contentType: "text/event-stream",
          headers: { "Cache-Control": "no-cache" },
          body: sseBody([
            {
              event: "meta",
              data: {
                type: "meta",
                job_id: SECOND_JOB,
                duration_s: 60.0,
                sample_rate: 22050,
                title: "Second Set",
                artist: "Second Artist",
              },
            },
            {
              event: "job.complete",
              data: { type: "job.complete", job_id: SECOND_JOB },
            },
          ]),
        }),
    );

    await page.goto(`/analyser?job=${FAKE_JOB_ID}`);
    await expect(page.getByTestId("analyser-header")).toContainText("Test Set");

    // Navigate to a different job through the URL — the page must pick
    // up the new id rather than continuing to render the original one.
    await page.goto(`/analyser?job=${SECOND_JOB}`);
    await expect(page.getByTestId("analyser-header")).toContainText(
      "Second Set",
    );
  });

  test("EventSource closes after job.complete (no auto-reconnect)", async ({
    page,
  }) => {
    let eventsRequests = 0;
    await page.route(/\/api\/analyser\/sets$/, (route) => {
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ jobs: [] }),
      });
    });
    await page.route(
      new RegExp(`/api/analyser/sets/${FAKE_JOB_ID}$`),
      (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            id: FAKE_JOB_ID,
            soundcloud_id: null,
            source_url: null,
            title: "Test Set",
            artist: "Test Artist",
            duration_s: 30.0,
            status: "complete",
            options: {
              pitch_strategy: "none",
              window_s: 30,
              hop_s: 25,
              min_section_gap_s: 30,
              sections_enabled: true,
              scan_cadence_s: 45,
              scan_window_s: 12,
            },
            error: null,
            created_at: 0,
            updated_at: 0,
            windows: [],
            sections: [],
            scans: [],
            timeline: [],
          }),
        }),
    );
    await page.route(
      new RegExp(`/api/analyser/sets/${FAKE_JOB_ID}/events$`),
      (route) => {
        eventsRequests += 1;
        route.fulfill({
          status: 200,
          contentType: "text/event-stream",
          headers: { "Cache-Control": "no-cache" },
          body: sseBody([
            {
              event: "meta",
              data: {
                type: "meta",
                job_id: FAKE_JOB_ID,
                duration_s: 30.0,
                sample_rate: 22050,
                title: "Test Set",
                artist: "Test Artist",
              },
            },
            {
              event: "job.complete",
              data: { type: "job.complete", job_id: FAKE_JOB_ID },
            },
          ]),
        });
      },
    );

    await page.goto(`/analyser?job=${FAKE_JOB_ID}`);
    await expect(page.getByTestId("analyser-status")).toHaveText(/Complete/i);

    // Without the fix, the native EventSource would re-open the stream
    // after the body closes — driving up the request count over time.
    await page.waitForTimeout(1500);
    expect(eventsRequests).toBeLessThanOrEqual(1);
  });

  test("header progress strip reflects BPM and Shazam phases", async ({
    page,
  }) => {
    const PROGRESS_JOB = "test-progress-job";
    await page.route(/\/api\/analyser\/sets$/, (route) => {
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ jobs: [] }),
      });
    });
    await page.route(
      new RegExp(`/api/analyser/sets/${PROGRESS_JOB}$`),
      (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            id: PROGRESS_JOB,
            soundcloud_id: 1,
            source_url: null,
            title: "Progress Set",
            artist: "DJ Tester",
            duration_s: 100.0,
            status: "running",
            options: {
              pitch_strategy: "none",
              window_s: 30,
              hop_s: 25,
              min_section_gap_s: 30,
              sections_enabled: true,
              scan_cadence_s: 25,
              scan_window_s: 12,
            },
            error: null,
            created_at: 0,
            updated_at: 0,
            windows: [],
            sections: [],
            scans: [],
            timeline: [],
          }),
        }),
    );
    await page.route(
      new RegExp(`/api/analyser/sets/${PROGRESS_JOB}/events$`),
      (route) =>
        route.fulfill({
          status: 200,
          contentType: "text/event-stream",
          headers: { "Cache-Control": "no-cache" },
          body: sseBody([
            {
              event: "meta",
              data: {
                type: "meta",
                job_id: PROGRESS_JOB,
                duration_s: 100.0,
                sample_rate: 22050,
                title: "Progress Set",
                artist: "DJ Tester",
              },
            },
            {
              event: "window.bpm",
              data: {
                type: "window.bpm",
                job_id: PROGRESS_JOB,
                start_s: 0,
                end_s: 30,
                bpm: 128.0,
                confidence: "high",
              },
            },
            {
              event: "window.bpm",
              data: {
                type: "window.bpm",
                job_id: PROGRESS_JOB,
                start_s: 25,
                end_s: 50,
                bpm: 128.0,
                confidence: "high",
              },
            },
          ]),
        }),
    );

    await page.goto(`/analyser?job=${PROGRESS_JOB}`);
    await expect(page.getByTestId("analyser-progress")).toBeVisible();
    await expect(page.getByTestId("analyser-progress")).toContainText(
      "Analysing BPM",
    );
    // Last window ends at 50/100 → 50%.
    await expect(page.getByTestId("analyser-progress-percent")).toHaveText(
      "50%",
    );
  });

  test("timeline renders iteratively from scan events while running", async ({
    page,
  }) => {
    const ITER_JOB = "test-iter-job";
    await page.route(/\/api\/analyser\/sets$/, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ jobs: [] }),
      }),
    );
    await page.route(new RegExp(`/api/analyser/sets/${ITER_JOB}$`), (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          id: ITER_JOB,
          soundcloud_id: 1,
          source_url: null,
          title: "Iterative Set",
          artist: "Tester",
          duration_s: 200.0,
          status: "running",
          options: {
            pitch_strategy: "none",
            window_s: 30,
            hop_s: 25,
            min_section_gap_s: 30,
            sections_enabled: true,
            scan_cadence_s: 60,
            scan_window_s: 12,
          },
          error: null,
          created_at: 0,
          updated_at: 0,
          windows: [],
          sections: [],
          scans: [],
          timeline: [],
        }),
      }),
    );
    // SSE stream emits two consecutive Shazam matches followed by a miss
    // — the frontend should aggregate the two hits into a single track
    // run *before* any backend ``track.timeline`` event arrives.
    await page.route(
      new RegExp(`/api/analyser/sets/${ITER_JOB}/events$`),
      (route) =>
        route.fulfill({
          status: 200,
          contentType: "text/event-stream",
          headers: { "Cache-Control": "no-cache" },
          body: sseBody([
            {
              event: "meta",
              data: {
                type: "meta",
                job_id: ITER_JOB,
                duration_s: 200.0,
                sample_rate: 22050,
                title: "Iterative Set",
                artist: "Tester",
              },
            },
            {
              event: "shazam.scan",
              data: {
                type: "shazam.scan",
                job_id: ITER_JOB,
                scan_s: 0.0,
                title: "Live Track",
                artist: "Live Artist",
                shazam_id: "k1",
                confidence: 0.9,
                pitch_offset: 0.0,
              },
            },
            {
              event: "shazam.scan",
              data: {
                type: "shazam.scan",
                job_id: ITER_JOB,
                scan_s: 60.0,
                title: "Live Track",
                artist: "Live Artist",
                shazam_id: "k1",
                confidence: 0.9,
                pitch_offset: 0.0,
              },
            },
            {
              event: "shazam.scan",
              data: {
                type: "shazam.scan",
                job_id: ITER_JOB,
                scan_s: 120.0,
                title: null,
                artist: null,
                shazam_id: null,
                confidence: 0.0,
                pitch_offset: 0.0,
              },
            },
          ]),
        }),
    );

    await page.goto(`/analyser?job=${ITER_JOB}`);
    await expect(page.getByTestId("analyser-main")).toBeVisible();

    // Track label appears from local aggregation, no backend track.timeline.
    await expect(page.getByTestId("tracklist-rows")).toContainText(
      "Live Track",
    );
    await expect(page.getByTestId("track-band")).toHaveCount(1);
    // 3 scan ticks rendered — two matched, one miss.
    await expect(page.getByTestId("scan-tick")).toHaveCount(3);
    await expect(
      page.locator('[data-testid="scan-tick"][data-matched="true"]'),
    ).toHaveCount(2);
  });

  test("tracklist row plays the section through the audio endpoint", async ({
    page,
  }) => {
    const handle = await mockAnalyserApi(page);
    let audioRequests = 0;
    await page.route(
      new RegExp(`/api/analyser/sets/${FAKE_JOB_ID}/audio$`),
      (route) => {
        audioRequests += 1;
        // 1-second silent MP4 frame stand-in is fine — the test only
        // checks that the request fires and the row enters playing state.
        route.fulfill({
          status: 200,
          contentType: "audio/mp4",
          headers: { "Accept-Ranges": "bytes", "Content-Length": "0" },
          body: "",
        });
      },
    );

    await page.goto(`/analyser?job=${FAKE_JOB_ID}`);
    await expect(page.getByTestId("tracklist-panel")).toBeVisible();
    await expect(page.getByTestId("tracklist-row")).toHaveCount(1);

    await page.getByTestId("play-section").click();
    // Browser fires a request for src on first play().
    await expect.poll(() => audioRequests).toBeGreaterThan(0);

    // The "find on SoundCloud" affordance is a button (resolves + plays
    // inline); the static search link is gone now. The "open on Shazam"
    // link now lives inside the Shazam preview popover (asserted in the
    // preview-popover test, which has a preview clip to open).
    await expect(page.getByTestId("find-soundcloud")).toBeVisible();
    // This row's match has no preview clip, so the Shazam button stays as
    // a disabled, grayed-out slot — keeping the button columns aligned.
    const shazamBtn = page.getByTestId("shazam-preview");
    await expect(shazamBtn).toHaveAttribute("data-available", "false");
    await expect(shazamBtn).toBeDisabled();

    // Avoid the unused-handle lint warning when the helper has no
    // assertions in this particular test.
    void handle;
  });

  test("track band fills with a blurred artwork echo", async ({ page }) => {
    await mockAnalyserApi(page);
    // Seed a non-expired access token so `ensureValidToken` returns
    // synchronously without hitting the refresh endpoint.
    await page.addInitScript(() => {
      const future = Date.now() + 60 * 60 * 1000;
      localStorage.setItem("access_token", "fake-token");
      localStorage.setItem("token_expires_at", String(future));
    });
    // Artwork lookup runs through SC track search; answer with a
    // data-URI cover so the echo <img> actually loads offline (a dead
    // URL would fire onError and hide the element).
    const pixelPng =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    await page.route(/api\.soundcloud\.com\/tracks/, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          {
            id: 999111,
            urn: "soundcloud:tracks:999111",
            title: "Mock Track A — Official",
            permalink_url: "https://soundcloud.com/dj/mock-track-a",
            waveform_url: null,
            artwork_url: pixelPng,
            user: { username: "Mock Artist A", urn: "soundcloud:users:1" },
          },
        ]),
      }),
    );

    await page.goto(`/analyser?job=${FAKE_JOB_ID}`);
    await expect(page.getByTestId("track-band")).toHaveCount(1);
    await expect(page.getByTestId("track-band-echo")).toBeVisible();
  });

  test("bands use persisted artwork and don't merge distant tracks", async ({
    page,
  }) => {
    const JOB = "test-bands-job";
    const coverPersisted =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const coverSearch = "data:image/png;base64,V1JPTkdDT1ZFUg==";

    await page.addInitScript(() => {
      const future = Date.now() + 60 * 60 * 1000;
      localStorage.setItem("access_token", "fake-token");
      localStorage.setItem("token_expires_at", String(future));
    });
    await page.route(/\/api\/analyser\/sets$/, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ jobs: [] }),
      }),
    );
    await page.route(new RegExp(`/api/analyser/sets/${JOB}/audio$`), (route) =>
      route.fulfill({ status: 200, contentType: "audio/mp4", body: "" }),
    );
    await page.route(new RegExp(`/api/analyser/sets/${JOB}/events$`), (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        headers: { "Cache-Control": "no-cache" },
        body: sseBody([
          {
            event: "job.complete",
            data: { type: "job.complete", job_id: JOB },
          },
        ]),
      }),
    );
    // The fuzzy search fallback must NOT win over persisted artwork.
    await page.route(/api\.soundcloud\.com\/tracks/, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          {
            id: 7,
            urn: "soundcloud:tracks:7",
            title: "X",
            artwork_url: coverSearch,
          },
        ]),
      }),
    );
    await page.route(new RegExp(`/api/analyser/sets/${JOB}$`), (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          id: JOB,
          soundcloud_id: 1,
          source_url: null,
          title: "Bands Set",
          artist: "Tester",
          duration_s: 3384, // 56:24 → group gap ≈ 40 s
          status: "complete",
          options: {
            pitch_strategy: "none",
            window_s: 30,
            hop_s: 25,
            min_section_gap_s: 30,
            sections_enabled: true,
            scan_cadence_s: 45,
            scan_window_s: 12,
          },
          error: null,
          created_at: 0,
          updated_at: 0,
          windows: [],
          sections: [],
          scans: [],
          timeline: [
            {
              // Long Shazam run: end_s abuts the next track's start.
              id: 1,
              start_s: 653, // 10:53
              end_s: 1320, // 22:00
              title: "It's All I Dream About",
              artist: "S3PPA",
              shazam_id: "shz-a",
              confidence: 0.9,
              source: "shazam",
              soundcloud_id: null,
              soundcloud_permalink_url: null,
              artwork_url: coverPersisted,
              duration_s: null,
              confirmed: false,
              user_edited: false,
              set_bpm: 145,
              pitch_offset: 0,
            },
            {
              id: 2,
              start_s: 1331, // 22:11 — 11 min after A's start
              end_s: 1331,
              title: "Get It",
              artist: "mischluft",
              shazam_id: "shz-b",
              confidence: 0.9,
              source: "shazam",
              soundcloud_id: null,
              soundcloud_permalink_url: null,
              artwork_url: coverSearch,
              duration_s: null,
              confirmed: false,
              user_edited: false,
              set_bpm: 145,
              pitch_offset: 0,
            },
          ],
        }),
      }),
    );

    await page.goto(`/analyser?job=${JOB}`);
    await expect(page.getByTestId("tracklist-panel")).toBeVisible();

    // Two distinct tracks → two separate bands, neither a merged group.
    await expect(page.getByTestId("track-band")).toHaveCount(2);
    await expect(
      page.locator('[data-testid="track-band"][data-group-size="1"]'),
    ).toHaveCount(2);

    // The first band paints the track's own persisted cover, not the
    // fuzzy search result.
    await expect(
      page.getByTestId("track-band").first().getByTestId("track-band-echo"),
    ).toHaveAttribute("src", coverPersisted);
  });

  test("set search lists long tracks and starts analysis from a result", async ({
    page,
  }) => {
    await mockAnalyserApi(page);
    // Seed a non-expired access token so `ensureValidToken` returns
    // synchronously without hitting the refresh endpoint.
    await page.addInitScript(() => {
      const future = Date.now() + 60 * 60 * 1000;
      localStorage.setItem("access_token", "fake-token");
      localStorage.setItem("token_expires_at", String(future));
    });
    let searchUrl = "";
    await page.route(/api\.soundcloud\.com\/tracks/, (route) => {
      searchUrl = route.request().url();
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          {
            id: 555,
            urn: "soundcloud:tracks:555",
            title: "Marathon Techno Mix",
            permalink_url: "https://soundcloud.com/dj/marathon-mix",
            duration: 4581065,
            waveform_url: null,
            artwork_url: null,
            user: { username: "DJ Marathon", urn: "soundcloud:users:9" },
          },
        ]),
      });
    });

    await page.goto("/analyser");
    await page.getByTestId("analyser-url-input").fill("marathon techno");
    // A search query is not a URL — direct Analyse stays disabled.
    await expect(page.getByTestId("analyser-start-button")).toBeDisabled();

    const result = page.getByTestId("set-search-result");
    await expect(result).toContainText("Marathon Techno Mix");
    await expect(result).toContainText("DJ Marathon");
    await expect(result).toContainText("1:16:21");
    // The search request must carry the min-duration filter (20 min).
    expect(new URL(searchUrl).searchParams.get("duration[from]")).toBe(
      String(20 * 60 * 1000),
    );

    // Clicking a result starts the analysis with the result's permalink.
    await result.click();
    await expect(page).toHaveURL(/\/analyser\?job=test-job-1/);
    await expect(page.getByTestId("analyser-main")).toBeVisible();
  });

  test("find on SoundCloud opens an in-section preview popover (not the player bar)", async ({
    page,
  }) => {
    await mockAnalyserApi(page);
    // Seed a non-expired access token so `ensureValidToken` returns
    // synchronously without hitting the refresh endpoint.
    await page.addInitScript(() => {
      const future = Date.now() + 60 * 60 * 1000;
      localStorage.setItem("access_token", "fake-token");
      localStorage.setItem("token_expires_at", String(future));
    });
    let searchCalls = 0;
    await page.route(/api\.soundcloud\.com\/tracks/, (route) => {
      searchCalls += 1;
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          {
            id: 999111,
            urn: "soundcloud:tracks:999111",
            title: "Mock Track A — Official",
            permalink_url: "https://soundcloud.com/dj/mock-track-a",
            waveform_url: null,
            duration: 210000,
            artwork_url: null,
            user: { username: "Mock Artist A", urn: "soundcloud:users:1" },
          },
        ]),
      });
    });
    // The popover resolves an HLS stream URL on open; mock it so nothing
    // hits the network. The popover renders its waveform regardless.
    await page.route(/\/api\/soundcloud\/tracks\/\d+\/stream/, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          url: "https://example.invalid/stream.m3u8",
          expires_at: new Date(Date.now() + 600_000).toISOString(),
        }),
      }),
    );
    let likeCalls = 0;
    await page.route(/\/api\/soundcloud\/tracks\/999111\/like$/, (route) => {
      if (route.request().method() === "POST") likeCalls += 1;
      route.fulfill({ status: 204, body: "" });
    });

    await page.goto(`/analyser?job=${FAKE_JOB_ID}`);
    await expect(page.getByTestId("tracklist-panel")).toBeVisible();
    await page.getByTestId("find-soundcloud").click();
    // The click must trigger a /tracks search against the SoundCloud API.
    await expect.poll(() => searchCalls).toBeGreaterThan(0);
    // …and surface the in-section waveform popover, not the global bar.
    const popover = page.getByTestId("soundcloud-preview-popover");
    await expect(popover).toBeVisible();
    // The waveform <div> is 0px until WaveSurfer injects a canvas (it
    // won't finish decoding in headless); the fixed-size toggle button
    // is the stable proof the in-section preview surface rendered.
    await expect(page.getByTestId("preview-toggle")).toBeVisible();
    // Once the search resolves, the popover exposes an open-on-SoundCloud
    // link and a like button acting on the resolved track.
    await expect(popover.getByTestId("soundcloud-link")).toHaveAttribute(
      "href",
      "https://soundcloud.com/dj/mock-track-a",
    );
    const like = popover.getByTestId("soundcloud-like-button");
    await expect(like).toHaveAttribute("data-liked", "false");
    await like.click();
    await expect.poll(() => likeCalls).toBe(1);
    await expect(like).toHaveAttribute("data-liked", "true");
  });

  test("a SoundCloud miss grays out the button and closes the popover", async ({
    page,
  }) => {
    await mockAnalyserApi(page);
    await page.addInitScript(() => {
      const future = Date.now() + 60 * 60 * 1000;
      localStorage.setItem("access_token", "fake-token");
      localStorage.setItem("token_expires_at", String(future));
    });
    // Search returns no results → a miss.
    await page.route(/api\.soundcloud\.com\/tracks/, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([]),
      }),
    );

    await page.goto(`/analyser?job=${FAKE_JOB_ID}`);
    await expect(page.getByTestId("tracklist-panel")).toBeVisible();
    const sc = page.getByTestId("find-soundcloud");
    await expect(sc).toHaveAttribute("data-available", "true");
    await sc.click();
    // No hit → the popover closes itself and the button grays out. The
    // old inline "not found on SoundCloud" text is gone; the icon carries
    // the state.
    await expect(sc).toHaveAttribute("data-available", "false");
    await expect(sc).toBeDisabled();
    await expect(page.getByTestId("soundcloud-preview-popover")).toHaveCount(0);
    await expect(page.getByText("not found on SoundCloud")).toHaveCount(0);
  });

  test("tracklist row exposes alternative Shazam matches", async ({ page }) => {
    const ALT_JOB = "test-alt-job";
    await page.route(/\/api\/analyser\/sets$/, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ jobs: [] }),
      }),
    );
    await page.route(new RegExp(`/api/analyser/sets/${ALT_JOB}$`), (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          id: ALT_JOB,
          soundcloud_id: 1,
          source_url: null,
          title: "Alt Set",
          artist: "Tester",
          duration_s: 200.0,
          status: "complete",
          options: {
            pitch_strategy: "range",
            window_s: 30,
            hop_s: 25,
            min_section_gap_s: 30,
            sections_enabled: true,
            scan_cadence_s: 60,
            scan_window_s: 12,
          },
          error: null,
          created_at: 0,
          updated_at: 0,
          windows: [],
          sections: [],
          // Two pitch attempts at the same scan point: a primary high-conf
          // hit and a secondary lower-conf candidate. The frontend must
          // surface the secondary as an alternative.
          scans: [
            {
              scan_s: 0.0,
              title: "Primary Track",
              artist: "Primary Artist",
              shazam_id: "primary-id",
              confidence: 0.95,
              pitch_offset: 0.0,
            },
            {
              scan_s: 0.0,
              title: "Alternate Track",
              artist: "Alt Artist",
              shazam_id: "alt-id",
              confidence: 0.7,
              pitch_offset: -0.4,
            },
          ],
          timeline: [
            {
              id: 101,
              start_s: 0.0,
              end_s: 0.0,
              title: "Primary Track",
              artist: "Primary Artist",
              shazam_id: "primary-id",
              confidence: 0.95,
              source: "shazam",
            },
          ],
        }),
      }),
    );
    await page.route(
      new RegExp(`/api/analyser/sets/${ALT_JOB}/events$`),
      (route) =>
        route.fulfill({
          status: 200,
          contentType: "text/event-stream",
          headers: { "Cache-Control": "no-cache" },
          body: sseBody([
            {
              event: "job.complete",
              data: { type: "job.complete", job_id: ALT_JOB },
            },
          ]),
        }),
    );

    await page.goto(`/analyser?job=${ALT_JOB}`);
    await expect(page.getByTestId("tracklist-row")).toHaveCount(1);
    await expect(page.getByTestId("track-alternatives")).toBeVisible();
    // Alternatives are collapsed by default; expand to verify content.
    await page.getByTestId("track-alternatives").getByRole("button").click();
    await expect(page.getByTestId("track-alternative")).toContainText(
      "Alternate Track",
    );
  });

  test("Stop identifying button POSTs the cancel endpoint", async ({
    page,
  }) => {
    const STOP_JOB = "test-stop-job";
    let cancelCalls = 0;
    await page.route(/\/api\/analyser\/sets$/, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ jobs: [] }),
      }),
    );
    await page.route(new RegExp(`/api/analyser/sets/${STOP_JOB}$`), (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          id: STOP_JOB,
          soundcloud_id: 1,
          source_url: null,
          title: "Stop Set",
          artist: "Tester",
          duration_s: 200.0,
          status: "running",
          options: {
            pitch_strategy: "none",
            window_s: 30,
            hop_s: 25,
            min_section_gap_s: 30,
            sections_enabled: true,
            scan_cadence_s: 60,
            scan_window_s: 12,
          },
          error: null,
          created_at: 0,
          updated_at: 0,
          windows: [],
          sections: [],
          // One scan already landed → the page is in the Shazam phase
          // and the Stop button should be visible.
          scans: [
            {
              scan_s: 0.0,
              title: "Live Track",
              artist: "Live Artist",
              shazam_id: "k1",
              confidence: 0.9,
              pitch_offset: 0.0,
            },
          ],
          timeline: [],
        }),
      }),
    );
    await page.route(
      new RegExp(`/api/analyser/sets/${STOP_JOB}/events$`),
      (route) =>
        route.fulfill({
          status: 200,
          contentType: "text/event-stream",
          headers: { "Cache-Control": "no-cache" },
          body: sseBody([]),
        }),
    );
    await page.route(
      new RegExp(`/api/analyser/sets/${STOP_JOB}/shazam-scan/cancel$`),
      (route) => {
        cancelCalls += 1;
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ job_id: STOP_JOB, cancelled: true }),
        });
      },
    );

    await page.goto(`/analyser?job=${STOP_JOB}`);
    await expect(page.getByTestId("stop-shazam")).toBeVisible();
    await expect(page.getByTestId("run-shazam-sweep")).toHaveCount(0);
    await page.getByTestId("stop-shazam").click();
    await expect.poll(() => cancelCalls).toBeGreaterThan(0);
  });

  test("a fresh scan after a stop shows an actionable Stop button (not stuck 'Stopping…')", async ({
    page,
  }) => {
    const JOB = "test-restop-job";
    // The /events stream stays running until the test flips this flag,
    // then delivers job.complete on the next poll — lets us drive the
    // running → complete → running sequence deterministically.
    let deliverComplete = false;
    let scanPosts = 0;

    await page.route(/\/api\/analyser\/sets$/, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ jobs: [] }),
      }),
    );
    await page.route(/\/api\/analyser\/sets\/[^/?]+\/audio$/, (route) =>
      route.fulfill({ status: 200, contentType: "audio/mp4", body: "" }),
    );
    // Snapshot is always "running with one scan" — the complete phase is
    // driven by the SSE stream, not the snapshot.
    await page.route(new RegExp(`/api/analyser/sets/${JOB}$`), (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          id: JOB,
          soundcloud_id: 1,
          source_url: null,
          title: "Restop Set",
          artist: "Tester",
          duration_s: 200.0,
          status: "running",
          options: {
            pitch_strategy: "none",
            window_s: 30,
            hop_s: 25,
            min_section_gap_s: 30,
            sections_enabled: true,
            scan_cadence_s: 60,
            scan_window_s: 12,
          },
          error: null,
          created_at: 0,
          updated_at: 0,
          windows: [],
          sections: [],
          scans: [
            {
              scan_s: 0.0,
              title: "Live Track",
              artist: "Live Artist",
              shazam_id: "k1",
              confidence: 0.9,
              pitch_offset: 0.0,
            },
          ],
          timeline: [],
        }),
      }),
    );
    await page.route(
      new RegExp(`/api/analyser/sets/${JOB}/events$`),
      async (route) => {
        // Hold the connection open, polling for the test's signal. When
        // set, emit a terminal job.complete (EventSource then closes).
        for (let i = 0; i < 200; i++) {
          if (deliverComplete) {
            deliverComplete = false;
            await route.fulfill({
              status: 200,
              contentType: "text/event-stream",
              headers: { "Cache-Control": "no-cache" },
              body: sseBody([
                {
                  event: "job.complete",
                  data: { type: "job.complete", job_id: JOB },
                },
              ]),
            });
            return;
          }
          await new Promise((r) => setTimeout(r, 50));
        }
        await route.fulfill({
          status: 200,
          contentType: "text/event-stream",
          headers: { "Cache-Control": "no-cache" },
          body: sseBody([]),
        });
      },
    );
    await page.route(
      new RegExp(`/api/analyser/sets/${JOB}/shazam-scan/cancel$`),
      (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ job_id: JOB, cancelled: true }),
        }),
    );
    await page.route(
      new RegExp(`/api/analyser/sets/${JOB}/shazam-scan$`),
      (route) => {
        scanPosts += 1;
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            job_id: JOB,
            status: "scheduled",
            tier: "sweep",
            region: null,
            excluded_confirmed_tracks: 0,
          }),
        });
      },
    );

    await page.goto(`/analyser?job=${JOB}`);

    // Phase 1 — a scan is running: Stop is offered and actionable.
    const stop = page.getByTestId("stop-shazam");
    await expect(stop).toBeEnabled();
    await stop.click();
    await expect(stop).toContainText("Stopping");

    // Backend winds the run down → the controls return to the run state.
    deliverComplete = true;
    await expect(page.getByTestId("run-shazam-sweep")).toBeVisible();

    // Phase 2 — start a *fresh* scan. The Stop button must be usable
    // again; the prior stop intent must not bleed into this run.
    await page.getByTestId("run-shazam-sweep").click();
    await expect.poll(() => scanPosts).toBe(1);
    await expect(stop).toBeVisible();
    await expect(stop).toBeEnabled();
    await expect(stop).toHaveText("Stop identifying");
  });

  test("BPM lane shows a chip per stable BPM run", async ({ page }) => {
    const RUN_JOB = "test-bpm-run-job";
    // 12 consecutive windows at ~128 BPM, then 12 at ~140 BPM. With
    // rounding + a 5-window rolling average + 10-window minimum, both
    // plateaus should produce exactly one chip each.
    const windows: Array<{
      start_s: number;
      end_s: number;
      bpm: number;
      confidence: string;
    }> = [];
    for (let i = 0; i < 12; i++) {
      windows.push({
        start_s: i * 5,
        end_s: i * 5 + 30,
        bpm: 128.0,
        confidence: "high",
      });
    }
    for (let i = 0; i < 12; i++) {
      windows.push({
        start_s: 60 + i * 5,
        end_s: 60 + i * 5 + 30,
        bpm: 140.0,
        confidence: "high",
      });
    }
    await page.route(/\/api\/analyser\/sets$/, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ jobs: [] }),
      }),
    );
    await page.route(new RegExp(`/api/analyser/sets/${RUN_JOB}$`), (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          id: RUN_JOB,
          soundcloud_id: 1,
          source_url: null,
          title: "BPM Run Set",
          artist: "Tester",
          duration_s: 200.0,
          status: "complete",
          options: {
            pitch_strategy: "none",
            window_s: 30,
            hop_s: 5,
            min_section_gap_s: 30,
            sections_enabled: true,
            scan_cadence_s: 60,
            scan_window_s: 12,
          },
          error: null,
          created_at: 0,
          updated_at: 0,
          windows,
          sections: [],
          scans: [],
          timeline: [],
        }),
      }),
    );
    await page.route(
      new RegExp(`/api/analyser/sets/${RUN_JOB}/events$`),
      (route) =>
        route.fulfill({
          status: 200,
          contentType: "text/event-stream",
          headers: { "Cache-Control": "no-cache" },
          body: sseBody([
            {
              event: "job.complete",
              data: { type: "job.complete", job_id: RUN_JOB },
            },
          ]),
        }),
    );

    await page.goto(`/analyser?job=${RUN_JOB}`);
    await expect(page.getByTestId("bpm-run-label")).toHaveCount(2);
    const bpms = await page
      .getByTestId("bpm-run-label")
      .evaluateAll((nodes) =>
        nodes.map((n) => Number((n as HTMLElement).dataset.bpm)),
      );
    expect(bpms.sort()).toEqual([128, 140]);
  });

  test("set waveform is rendered as a lane inside the timeline", async ({
    page,
  }) => {
    await mockAnalyserApi(page);
    await page.goto(`/analyser?job=${FAKE_JOB_ID}`);
    await expect(page.getByTestId("set-waveform")).toBeVisible();
    // Toggle button starts disabled (loading) until WaveSurfer's ready —
    // we don't drive that in the test, so just assert the affordance.
    await expect(page.getByTestId("set-waveform-toggle")).toBeVisible();
    // Waveform sits inside the unified timeline card, below the BPM lane.
    const timeline = page.getByTestId("analyser-timeline");
    const wave = page.getByTestId("set-waveform");
    const bpm = page.getByTestId("bpm-lane");
    const tlBox = await timeline.boundingBox();
    const wfBox = await wave.boundingBox();
    const bpmBox = await bpm.boundingBox();
    if (!tlBox || !wfBox || !bpmBox) throw new Error("missing box");
    // Waveform is contained within the timeline card.
    expect(wfBox.y).toBeGreaterThanOrEqual(tlBox.y);
    expect(wfBox.y + wfBox.height).toBeLessThanOrEqual(
      tlBox.y + tlBox.height + 1,
    );
    // And sits below the BPM lane.
    expect(wfBox.y).toBeGreaterThanOrEqual(bpmBox.y + bpmBox.height - 1);
  });

  test("Tempo + optional Up-to drive pitch strategy on the POST", async ({
    page,
  }) => {
    const scanRequests: Array<Record<string, unknown>> = [];
    await mockAnalyserApi(page);
    await page.route(
      new RegExp(`/api/analyser/sets/${FAKE_JOB_ID}/shazam-scan$`),
      async (route) => {
        scanRequests.push(
          route.request().postDataJSON() as Record<string, unknown>,
        );
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            job_id: FAKE_JOB_ID,
            status: "scheduled",
            tier: "sweep",
            region: null,
            excluded_confirmed_tracks: 0,
          }),
        });
      },
    );

    await page.goto(`/analyser?job=${FAKE_JOB_ID}`);
    await expect(page.getByTestId("analyser-main")).toBeVisible();

    // Empty tempo → strategy=none, sweep is enabled out of the box.
    await expect(page.getByTestId("run-shazam-sweep")).toBeEnabled();

    // Set a tempo (single-tempo mode) and click Sweep.
    const tempo = page.getByLabel("Original tempo (BPM)");
    await tempo.fill("128");
    await tempo.blur();
    await page.getByTestId("run-shazam-sweep").click();
    await expect.poll(() => scanRequests.length).toBe(1);
    expect(scanRequests[0].overrides).toMatchObject({
      pitch_strategy: "single",
      target_bpm: 128,
      bpm_range: null,
    });

    // Reveal the range field, then add an Up-to value > tempo → strategy
    // flips to range.
    await page.getByTestId("toggle-tempo-range").click();
    const end = page.getByLabel("Up to (BPM)");
    await end.fill("136");
    await end.blur();
    await page.getByTestId("run-shazam-sweep").click();
    await expect.poll(() => scanRequests.length).toBe(2);
    expect(scanRequests[1].overrides).toMatchObject({
      pitch_strategy: "range",
      bpm_range: [128, 136],
    });

    // Narrow the band (≤ 4 BPM): the dedup hint surfaces, but the POST
    // still goes out as range — the backend collapses per-scan-point.
    await end.fill("130");
    await end.blur();
    await expect(page.getByTestId("tempo-narrow-hint")).toBeVisible();
  });

  test("Sweep button posts tier=sweep; Refine unlocks once sweep scans land", async ({
    page,
  }) => {
    const TIER_JOB = "test-tier-job";
    const requests: Array<Record<string, unknown>> = [];

    await mockAnalyserApi(page);
    // Snapshot for this job *already* has cached sweep scans, so the UI
    // should treat sweep as completed and unlock Refine.
    await page.route(new RegExp(`/api/analyser/sets/${TIER_JOB}$`), (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          id: TIER_JOB,
          soundcloud_id: 1,
          source_url: null,
          title: "Tier Test",
          artist: "Test",
          duration_s: 120.0,
          status: "complete",
          options: {
            pitch_strategy: "none",
            window_s: 30,
            hop_s: 25,
            min_section_gap_s: 30,
            sections_enabled: true,
            scan_cadence_s: 60,
            scan_window_s: 12,
          },
          error: null,
          created_at: 0,
          updated_at: 0,
          windows: [],
          sections: [],
          scans: [
            {
              scan_s: 0,
              title: null,
              artist: null,
              shazam_id: null,
              confidence: 0.0,
              pitch_offset: 0,
              tier: "sweep",
            },
          ],
          timeline: [],
        }),
      }),
    );
    await page.route(
      new RegExp(`/api/analyser/sets/${TIER_JOB}/events$`),
      (route) =>
        route.fulfill({
          status: 200,
          contentType: "text/event-stream",
          headers: { "Cache-Control": "no-cache" },
          body: "",
        }),
    );
    await page.route(
      new RegExp(`/api/analyser/sets/${TIER_JOB}/shazam-scan$`),
      async (route) => {
        const body = route.request().postDataJSON() as Record<string, unknown>;
        requests.push(body);
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            job_id: TIER_JOB,
            status: "scheduled",
            tier: body.tier,
            region: body.region ?? null,
            excluded_confirmed_tracks: 0,
          }),
        });
      },
    );

    await page.goto(`/analyser?job=${TIER_JOB}`);
    await expect(page.getByTestId("analyser-main")).toBeVisible();

    // Sweep is already cached in the snapshot, so the primary button
    // auto-advances to Refine. Click it directly — no menu open needed.
    await expect(page.getByTestId("run-shazam-refine")).toBeEnabled();
    await page.getByTestId("run-shazam-refine").click();
    await expect.poll(() => requests.length).toBe(1);
    expect(requests[0]).toMatchObject({ tier: "refine" });

    // Pinpoint is gated until Refine produces scans — it shows up in the
    // dropdown menu as locked.
    await page.getByTestId("run-shazam-menu").click();
    await expect(page.getByTestId("run-shazam-item-pinpoint")).toHaveAttribute(
      "data-disabled",
      "",
    );
    // The hint spells out the section-driven placement (probe spacing inside
    // each section), not a flat across-the-whole-set cadence.
    await expect(page.getByTestId("run-shazam-item-sweep")).toContainText(
      "16 s clip every 45 s in each section",
    );
  });

  test("trash button DELETEs the track and refreshes", async ({ page }) => {
    const HIDE_JOB = "test-hide-job";
    let deleteCalls = 0;
    let snapshotCalls = 0;

    const baseSnapshot = {
      id: HIDE_JOB,
      soundcloud_id: 1,
      source_url: null,
      title: "Hide Set",
      artist: "Tester",
      duration_s: 120.0,
      status: "complete",
      options: {
        pitch_strategy: "none",
        window_s: 30,
        hop_s: 25,
        min_section_gap_s: 30,
        sections_enabled: true,
        scan_cadence_s: 45,
        scan_window_s: 12,
      },
      error: null,
      created_at: 0,
      updated_at: 0,
      windows: [],
      sections: [],
      scans: [],
    };

    await page.route(/\/api\/analyser\/sets$/, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ jobs: [] }),
      }),
    );
    await page.route(new RegExp(`/api/analyser/sets/${HIDE_JOB}$`), (route) => {
      snapshotCalls += 1;
      const timeline =
        deleteCalls === 0
          ? [
              {
                id: 17,
                start_s: 0,
                end_s: 30,
                title: "Wrong Match",
                artist: "Bad",
                shazam_id: "shz-x",
                confidence: 0.7,
                source: "shazam",
              },
            ]
          : [];
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ...baseSnapshot, timeline }),
      });
    });
    await page.route(
      new RegExp(`/api/analyser/sets/${HIDE_JOB}/events$`),
      (route) =>
        route.fulfill({
          status: 200,
          contentType: "text/event-stream",
          headers: { "Cache-Control": "no-cache" },
          body: sseBody([
            {
              event: "job.complete",
              data: { type: "job.complete", job_id: HIDE_JOB },
            },
          ]),
        }),
    );
    await page.route(
      new RegExp(`/api/analyser/sets/${HIDE_JOB}/tracks/17$`),
      (route) => {
        if (route.request().method() === "DELETE") {
          deleteCalls += 1;
          route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              job_id: HIDE_JOB,
              track_id: 17,
              deleted: true,
            }),
          });
          return;
        }
        route.fallback();
      },
    );

    await page.goto(`/analyser?job=${HIDE_JOB}`);
    await expect(page.getByTestId("tracklist-row")).toHaveCount(1);
    // Trash + circle controls reveal on row hover so idle rows aren't
    // littered with affordances; hover first to bring the trash into view.
    await page.getByTestId("tracklist-row").hover();
    await page.getByTestId("remove-track").click();
    await expect.poll(() => deleteCalls).toBeGreaterThan(0);
    await expect.poll(() => snapshotCalls).toBeGreaterThan(1);
    await expect(page.getByTestId("tracklist-row")).toHaveCount(0);
  });

  test("single-window matches render tentative; min-matches slider hides them", async ({
    page,
  }) => {
    const TENT_JOB = "test-tentative-job";

    const snapshot = {
      id: TENT_JOB,
      soundcloud_id: 1,
      source_url: null,
      title: "Tentative Set",
      artist: "Tester",
      duration_s: 300.0,
      status: "complete",
      options: {
        pitch_strategy: "none",
        window_s: 30,
        hop_s: 25,
        min_section_gap_s: 90,
        sections_enabled: true,
        scan_cadence_s: 45,
        scan_window_s: 16,
      },
      error: null,
      created_at: 0,
      updated_at: 0,
      windows: [],
      sections: [],
      // "Solid Track" recognised at two windows → corroborated.
      // "Maybe Track" recognised at one window → tentative.
      scans: [
        {
          scan_s: 20,
          title: "Solid Track",
          artist: "A",
          shazam_id: "shz-solid",
          confidence: 0.9,
          pitch_offset: 0,
        },
        {
          scan_s: 80,
          title: "Solid Track",
          artist: "A",
          shazam_id: "shz-solid",
          confidence: 0.9,
          pitch_offset: 0,
        },
        {
          scan_s: 200,
          title: "Maybe Track",
          artist: "B",
          shazam_id: "shz-maybe",
          confidence: 0.9,
          pitch_offset: 0,
        },
      ],
      timeline: [
        {
          id: 1,
          start_s: 20,
          end_s: 80,
          title: "Solid Track",
          artist: "A",
          shazam_id: "shz-solid",
          confidence: 0.9,
          source: "shazam",
        },
        {
          id: 2,
          start_s: 200,
          end_s: 200,
          title: "Maybe Track",
          artist: "B",
          shazam_id: "shz-maybe",
          confidence: 0.9,
          source: "shazam",
        },
      ],
    };

    await page.route(/\/api\/analyser\/sets$/, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ jobs: [] }),
      }),
    );
    await page.route(new RegExp(`/api/analyser/sets/${TENT_JOB}$`), (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(snapshot),
      }),
    );
    await page.route(
      new RegExp(`/api/analyser/sets/${TENT_JOB}/events$`),
      (route) =>
        route.fulfill({
          status: 200,
          contentType: "text/event-stream",
          headers: { "Cache-Control": "no-cache" },
          body: sseBody([
            {
              event: "job.complete",
              data: { type: "job.complete", job_id: TENT_JOB },
            },
          ]),
        }),
    );

    await page.goto(`/analyser?job=${TENT_JOB}`);
    await expect(page.getByTestId("tracklist-row")).toHaveCount(2);

    const solid = page
      .getByTestId("tracklist-row")
      .filter({ hasText: "Solid Track" });
    const maybe = page
      .getByTestId("tracklist-row")
      .filter({ hasText: "Maybe Track" });

    // The single-window match is surfaced (visible row) but flagged tentative.
    await expect(maybe).toHaveAttribute("data-tentative", "true");
    await expect(maybe.getByTestId("tracklist-tentative")).toBeVisible();
    // The two-window match is shown without the caveat.
    await expect(solid).toHaveAttribute("data-tentative", "false");
    await expect(solid.getByTestId("tracklist-tentative")).toHaveCount(0);

    // Raise the min-matches filter to 2: the single-window "Maybe Track" is
    // hidden, the corroborated "Solid Track" stays.
    const thumb = page.getByTestId("min-matches-slider").getByRole("slider");
    await thumb.focus();
    await thumb.press("ArrowRight");
    await expect(page.getByTestId("min-matches-value")).toHaveText("2");
    await expect(page.getByTestId("tracklist-row")).toHaveCount(1);
    await expect(
      page.getByTestId("tracklist-row").filter({ hasText: "Maybe Track" }),
    ).toHaveCount(0);
    await expect(
      page.getByTestId("tracklist-row").filter({ hasText: "Solid Track" }),
    ).toHaveCount(1);
    // The hidden count surfaces in the header.
    await expect(page.getByTestId("tracklist-panel")).toContainText("1 hidden");
  });

  test("add manual track flow POSTs and renders new row", async ({ page }) => {
    const ADD_JOB = "test-add-job";
    let addCalls = 0;
    let snapshotCalls = 0;

    const baseSnapshot = {
      id: ADD_JOB,
      soundcloud_id: 1,
      source_url: null,
      title: "Add Set",
      artist: "Tester",
      duration_s: 120.0,
      status: "complete",
      options: {
        pitch_strategy: "none",
        window_s: 30,
        hop_s: 25,
        min_section_gap_s: 30,
        sections_enabled: true,
        scan_cadence_s: 45,
        scan_window_s: 12,
      },
      error: null,
      created_at: 0,
      updated_at: 0,
      windows: [],
      sections: [],
      scans: [],
    };

    await page.addInitScript(() => {
      const future = Date.now() + 60 * 60 * 1000;
      localStorage.setItem("access_token", "fake-token");
      localStorage.setItem("token_expires_at", String(future));
    });

    await page.route(/\/api\/analyser\/sets$/, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ jobs: [] }),
      }),
    );
    await page.route(new RegExp(`/api/analyser/sets/${ADD_JOB}$`), (route) => {
      snapshotCalls += 1;
      const timeline =
        addCalls === 0
          ? []
          : [
              {
                id: 7,
                start_s: 30,
                end_s: 30,
                title: "Hand Picked",
                artist: "ManualA",
                shazam_id: null,
                confidence: 1.0,
                source: "manual",
                soundcloud_id: 999111,
                soundcloud_permalink_url:
                  "https://soundcloud.com/dj/hand-picked",
                artwork_url: null,
              },
            ];
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ...baseSnapshot, timeline }),
      });
    });
    await page.route(
      new RegExp(`/api/analyser/sets/${ADD_JOB}/events$`),
      (route) =>
        route.fulfill({
          status: 200,
          contentType: "text/event-stream",
          headers: { "Cache-Control": "no-cache" },
          body: sseBody([
            {
              event: "job.complete",
              data: { type: "job.complete", job_id: ADD_JOB },
            },
          ]),
        }),
    );
    await page.route(/api\.soundcloud\.com\/tracks/, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          {
            id: 999111,
            urn: "soundcloud:tracks:999111",
            title: "Hand Picked",
            permalink_url: "https://soundcloud.com/dj/hand-picked",
            artwork_url: null,
            user: { username: "ManualA", urn: "soundcloud:users:1" },
          },
        ]),
      }),
    );
    await page.route(
      new RegExp(`/api/analyser/sets/${ADD_JOB}/tracks$`),
      (route) => {
        addCalls += 1;
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            id: 7,
            kind: "manual",
            start_s: 30,
            end_s: null,
            title: "Hand Picked",
            artist: "ManualA",
            shazam_id: null,
            soundcloud_id: 999111,
            soundcloud_permalink_url: "https://soundcloud.com/dj/hand-picked",
            artwork_url: null,
            created_at: 0,
          }),
        });
      },
    );

    await page.goto(`/analyser?job=${ADD_JOB}`);
    await expect(page.getByTestId("tracklist-panel")).toBeVisible();
    await page.getByTestId("add-track-trigger").click();
    await expect(page.getByTestId("add-track-dialog")).toBeVisible();

    await page.getByTestId("add-track-search").fill("hand picked");
    await expect(page.getByTestId("add-track-result").first()).toBeVisible();
    await page.getByTestId("add-track-result").first().click();
    await page.getByTestId("add-track-start").fill("00:30");
    await page.getByTestId("add-track-submit").click();

    await expect.poll(() => addCalls).toBeGreaterThan(0);
    await expect.poll(() => snapshotCalls).toBeGreaterThan(1);
    await expect(page.getByTestId("tracklist-row")).toContainText(
      "Hand Picked",
    );
  });

  test("add-track search shows cover art, resolves a URL, and previews", async ({
    page,
  }) => {
    const JOB = "test-add-rich-job";
    const pixelPng =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

    const baseSnapshot = {
      id: JOB,
      soundcloud_id: 1,
      source_url: null,
      title: "Add Set",
      artist: "Tester",
      duration_s: 120.0,
      status: "complete",
      options: {
        pitch_strategy: "none",
        window_s: 30,
        hop_s: 25,
        min_section_gap_s: 30,
        sections_enabled: true,
        scan_cadence_s: 45,
        scan_window_s: 12,
      },
      error: null,
      created_at: 0,
      updated_at: 0,
      windows: [],
      sections: [],
      scans: [],
    };

    const track = {
      id: 424242,
      urn: "soundcloud:tracks:424242",
      title: "Resolved Banger",
      permalink_url: "https://soundcloud.com/dj/resolved-banger",
      artwork_url: pixelPng,
      waveform_url: null,
      duration: 210000,
      user: { username: "DJ Resolve", urn: "soundcloud:users:1" },
    };

    await page.addInitScript(() => {
      const future = Date.now() + 60 * 60 * 1000;
      localStorage.setItem("access_token", "fake-token");
      localStorage.setItem("token_expires_at", String(future));
    });

    await page.route(/\/api\/analyser\/sets$/, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ jobs: [] }),
      }),
    );
    await page.route(new RegExp(`/api/analyser/sets/${JOB}$`), (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ...baseSnapshot, timeline: [] }),
      }),
    );
    await page.route(new RegExp(`/api/analyser/sets/${JOB}/events$`), (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        headers: { "Cache-Control": "no-cache" },
        body: sseBody([
          {
            event: "job.complete",
            data: { type: "job.complete", job_id: JOB },
          },
        ]),
      }),
    );
    // Text search hits the /tracks endpoint; a pasted URL hits /resolve.
    await page.route(/api\.soundcloud\.com\/tracks/, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([track]),
      }),
    );
    let resolveCalls = 0;
    await page.route(/api\.soundcloud\.com\/resolve/, (route) => {
      resolveCalls += 1;
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(track),
      });
    });
    // The preview popover resolves an HLS stream URL on open.
    await page.route(/\/api\/soundcloud\/tracks\/424242\/stream/, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          url: "https://example.invalid/stream.m3u8",
          expires_at: null,
        }),
      }),
    );

    await page.goto(`/analyser?job=${JOB}`);
    await expect(page.getByTestId("tracklist-panel")).toBeVisible();
    await page.getByTestId("add-track-trigger").click();
    await expect(page.getByTestId("add-track-dialog")).toBeVisible();

    // Text search: results render an artwork thumbnail.
    await page.getByTestId("add-track-search").fill("banger");
    const firstResult = page.getByTestId("add-track-result").first();
    await expect(firstResult).toBeVisible();
    await expect(firstResult.locator("img")).toHaveAttribute("src", pixelPng);

    // Preview: opening the popover resolves the stream and shows controls.
    await page.getByTestId("add-track-preview").first().click();
    await expect(page.getByTestId("add-track-preview-popover")).toBeVisible();
    await expect(page.getByTestId("preview-toggle")).toBeVisible();
    await expect(page.getByTestId("add-track-soundcloud-link")).toHaveAttribute(
      "href",
      "https://soundcloud.com/dj/resolved-banger",
    );
    // Scrolling the results list closes the preview so it doesn't float
    // over the form below.
    await page.getByTestId("add-track-results").dispatchEvent("scroll");
    await expect(page.getByTestId("add-track-preview-popover")).toBeHidden();

    // URL paste: resolves via /resolve to a single result.
    await page
      .getByTestId("add-track-search")
      .fill("https://soundcloud.com/dj/resolved-banger");
    await expect.poll(() => resolveCalls).toBeGreaterThan(0);
    await expect(page.getByTestId("add-track-result")).toHaveCount(1);
    await expect(page.getByTestId("add-track-result")).toContainText(
      "Resolved Banger",
    );
  });

  test("search stays typable while the set is playing", async ({ page }) => {
    const JOB = "test-play-typing-job";
    const baseSnapshot = {
      id: JOB,
      soundcloud_id: 1,
      source_url: null,
      title: "Play Set",
      artist: "Tester",
      duration_s: 120.0,
      status: "complete",
      options: {
        pitch_strategy: "none",
        window_s: 30,
        hop_s: 25,
        min_section_gap_s: 30,
        sections_enabled: true,
        scan_cadence_s: 45,
        scan_window_s: 12,
      },
      error: null,
      created_at: 0,
      updated_at: 0,
      windows: [],
      sections: [],
      scans: [],
    };

    await page.addInitScript(() => {
      const future = Date.now() + 60 * 60 * 1000;
      localStorage.setItem("access_token", "fake-token");
      localStorage.setItem("token_expires_at", String(future));
    });

    await page.route(/\/api\/analyser\/sets$/, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ jobs: [] }),
      }),
    );
    await page.route(new RegExp(`/api/analyser/sets/${JOB}$`), (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ...baseSnapshot, timeline: [] }),
      }),
    );
    await page.route(new RegExp(`/api/analyser/sets/${JOB}/events$`), (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        headers: { "Cache-Control": "no-cache" },
        body: sseBody([
          {
            event: "job.complete",
            data: { type: "job.complete", job_id: JOB },
          },
        ]),
      }),
    );
    // Real (silent) audio so the set waveform reaches "ready" and the
    // playhead actually advances on play.
    await page.route(new RegExp(`/api/analyser/sets/${JOB}/audio$`), (route) =>
      route.fulfill({
        status: 200,
        contentType: "audio/wav",
        headers: { "Accept-Ranges": "bytes" },
        body: silentWav(3),
      }),
    );

    await page.goto(`/analyser?job=${JOB}`);
    await expect(page.getByTestId("tracklist-panel")).toBeVisible();

    // Start set playback and confirm the playhead is advancing — this is
    // what used to wipe the search box every frame.
    const toggle = page.getByTestId("set-waveform-toggle");
    await expect(toggle).toBeEnabled();
    await toggle.click();
    await expect
      .poll(async () =>
        (
          await page.getByTestId("set-audio-current-time").textContent()
        )?.trim(),
      )
      .not.toBe("0:00");

    // Type into the add-track search while playing; it must persist.
    await page.getByTestId("add-track-trigger").click();
    await expect(page.getByTestId("add-track-dialog")).toBeVisible();
    await page.getByTestId("add-track-search").fill("still typing");
    await page.waitForTimeout(600); // let several timeupdate frames pass
    await expect(page.getByTestId("add-track-search")).toHaveValue(
      "still typing",
    );
  });

  test("picking an alternative persists the switch", async ({ page }) => {
    const JOB = "test-switch-job";
    let switched = false;
    const patches: Array<Record<string, unknown>> = [];

    const snapshot = () => ({
      id: JOB,
      soundcloud_id: 1,
      source_url: null,
      title: "Switch Set",
      artist: "Tester",
      duration_s: 120.0,
      status: "complete",
      options: {
        pitch_strategy: "none",
        window_s: 30,
        hop_s: 25,
        min_section_gap_s: 30,
        sections_enabled: true,
        scan_cadence_s: 45,
        scan_window_s: 12,
      },
      error: null,
      created_at: 0,
      updated_at: 0,
      windows: [],
      sections: [],
      scans: [
        {
          scan_s: 10,
          title: "Primary Track",
          artist: "DJ P",
          shazam_id: "shz-primary",
          confidence: 0.9,
          pitch_offset: 0,
        },
        {
          scan_s: 20,
          title: "Alt Track",
          artist: "Alt Artist",
          shazam_id: "shz-alt",
          confidence: 0.8,
          pitch_offset: 2,
        },
      ],
      timeline: [
        {
          id: 55,
          start_s: 0,
          end_s: 60,
          title: switched ? "Alt Track" : "Primary Track",
          artist: switched ? "Alt Artist" : "DJ P",
          shazam_id: switched ? "shz-alt" : "shz-primary",
          confidence: switched ? 0.8 : 0.9,
          source: "shazam",
          soundcloud_id: null,
          soundcloud_permalink_url: null,
          artwork_url: null,
          duration_s: null,
          confirmed: false,
          user_edited: switched,
          set_bpm: 128,
          pitch_offset: switched ? 2 : 0,
        },
      ],
    });

    await page.addInitScript(() => {
      const future = Date.now() + 60 * 60 * 1000;
      localStorage.setItem("access_token", "fake-token");
      localStorage.setItem("token_expires_at", String(future));
    });
    await page.route(/\/api\/analyser\/sets$/, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ jobs: [] }),
      }),
    );
    await page.route(new RegExp(`/api/analyser/sets/${JOB}$`), (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(snapshot()),
      }),
    );
    await page.route(new RegExp(`/api/analyser/sets/${JOB}/events$`), (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        headers: { "Cache-Control": "no-cache" },
        body: sseBody([
          {
            event: "job.complete",
            data: { type: "job.complete", job_id: JOB },
          },
        ]),
      }),
    );
    await page.route(new RegExp(`/api/analyser/sets/${JOB}/audio$`), (route) =>
      route.fulfill({ status: 200, contentType: "audio/mp4", body: "" }),
    );
    await page.route(
      new RegExp(`/api/analyser/sets/${JOB}/tracks/55$`),
      (route) => {
        if (route.request().method() === "PATCH") {
          patches.push(
            route.request().postDataJSON() as Record<string, unknown>,
          );
          switched = true;
          route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ job_id: JOB, track_id: 55, updated: true }),
          });
          return;
        }
        route.fallback();
      },
    );

    await page.goto(`/analyser?job=${JOB}`);
    await expect(page.getByTestId("tracklist-row")).toContainText(
      "Primary Track",
    );

    // Reveal the alternative and switch to it.
    await page.getByTestId("tracklist-row").hover();
    await page.getByRole("button", { name: /Show 1 alternative/ }).click();
    await page.getByTestId("pick-alternative").first().click();

    // The switch is PATCHed with the alternative's identity.
    await expect.poll(() => patches.length).toBeGreaterThan(0);
    expect(patches[0]).toMatchObject({
      title: "Alt Track",
      artist: "Alt Artist",
      shazam_id: "shz-alt",
      pitch_offset: 2,
    });
    // And the refreshed snapshot shows the switched track.
    await expect(page.getByTestId("tracklist-row")).toContainText("Alt Track");
  });

  test("recent analyses show counts and delete removes a row", async ({
    page,
  }) => {
    let listCalls = 0;
    let deleteCalls = 0;
    await page.route(/\/api\/analyser\/sets(\?|$)/, (route: Route) => {
      const url = route.request().url();
      if (route.request().method() === "POST") {
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ job_id: "ignored" }),
        });
        return;
      }
      if (!url.includes("?")) {
        // Per-job snapshot path falls through to other handlers.
        return route.fallback();
      }
      listCalls += 1;
      const jobs =
        deleteCalls === 0
          ? [
              {
                id: "j-keep",
                soundcloud_id: 1,
                title: "Keeper",
                artist: "DJ K",
                duration_s: 120,
                status: "complete",
                created_at: 0,
                track_count: 4,
              },
              {
                id: "j-doomed",
                soundcloud_id: 2,
                title: "Doomed",
                artist: "DJ D",
                duration_s: 60,
                status: "complete",
                created_at: 0,
                track_count: 1,
              },
            ]
          : [
              {
                id: "j-keep",
                soundcloud_id: 1,
                title: "Keeper",
                artist: "DJ K",
                duration_s: 120,
                status: "complete",
                created_at: 0,
                track_count: 4,
              },
            ];
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ jobs }),
      });
    });
    await page.route(/\/api\/analyser\/sets\/j-doomed$/, (route) => {
      if (route.request().method() === "DELETE") {
        deleteCalls += 1;
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ job_id: "j-doomed", deleted: true }),
        });
        return;
      }
      route.fallback();
    });

    // Seed two confirmed marks on the keeper so the row reads "2/4 ok".
    await page.addInitScript(() => {
      localStorage.setItem(
        "analyser:confirmed:j-keep",
        JSON.stringify(["k1", "k2"]),
      );
    });

    await page.goto("/analyser");
    await expect(page.getByTestId("recent-jobs")).toBeVisible();
    await expect(page.getByTestId("recent-job")).toHaveCount(2);
    const keeperStats = page
      .locator('[data-testid="recent-job"][data-job-id="j-keep"]')
      .getByTestId("recent-job-stats");
    await expect(keeperStats).toContainText("4 tracks");
    await expect(keeperStats).toContainText("2");
    await expect(keeperStats).toContainText("/4");

    await page
      .locator('[data-testid="recent-job"][data-job-id="j-doomed"]')
      .getByTestId("delete-job")
      .click();
    await expect(page.getByTestId("delete-job-dialog")).toBeVisible();
    await page.getByTestId("delete-job-confirm").click();
    await expect.poll(() => deleteCalls).toBe(1);
    await expect.poll(() => listCalls).toBeGreaterThan(1);
    await expect(page.getByTestId("recent-job")).toHaveCount(1);
  });

  test("reset wipes the snapshot after confirmation", async ({ page }) => {
    const RESET_JOB = "test-reset-job";
    let resetCalls = 0;
    let snapshotCalls = 0;

    const fullSnapshot = {
      id: RESET_JOB,
      soundcloud_id: 1,
      source_url: null,
      title: "Reset Set",
      artist: "Tester",
      duration_s: 120.0,
      status: "complete",
      options: {
        pitch_strategy: "none",
        window_s: 30,
        hop_s: 25,
        min_section_gap_s: 30,
        sections_enabled: true,
        scan_cadence_s: 45,
        scan_window_s: 12,
      },
      error: null,
      created_at: 0,
      updated_at: 0,
      windows: [],
      sections: [],
      scans: [],
      timeline: [
        {
          id: 1,
          start_s: 0,
          end_s: 30,
          title: "Will Be Reset",
          artist: "X",
          shazam_id: "shz-1",
          confidence: 0.9,
          source: "shazam",
        },
      ],
    };

    await page.route(/\/api\/analyser\/sets$/, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ jobs: [] }),
      }),
    );
    await page.route(
      new RegExp(`/api/analyser/sets/${RESET_JOB}$`),
      (route) => {
        snapshotCalls += 1;
        const snap =
          resetCalls === 0
            ? fullSnapshot
            : { ...fullSnapshot, status: "complete", timeline: [] };
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(snap),
        });
      },
    );
    await page.route(
      new RegExp(`/api/analyser/sets/${RESET_JOB}/events$`),
      (route) =>
        route.fulfill({
          status: 200,
          contentType: "text/event-stream",
          headers: { "Cache-Control": "no-cache" },
          body: sseBody([
            {
              event: "job.complete",
              data: { type: "job.complete", job_id: RESET_JOB },
            },
          ]),
        }),
    );
    await page.route(
      new RegExp(`/api/analyser/sets/${RESET_JOB}/reset$`),
      (route) => {
        resetCalls += 1;
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ job_id: RESET_JOB, reset: true }),
        });
      },
    );
    // Reset auto-triggers a fresh BPM pass so the user's mental model of
    // "start over" actually starts something — mock the call out so the
    // frontend doesn't hit a real backend.
    await page.route(
      new RegExp(`/api/analyser/sets/${RESET_JOB}/reanalyse$`),
      (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            job_id: RESET_JOB,
            scheduled_ranges: [{ start_s: 0, end_s: 120 }],
          }),
        }),
    );

    await page.goto(`/analyser?job=${RESET_JOB}`);
    await expect(page.getByTestId("tracklist-row")).toContainText(
      "Will Be Reset",
    );

    await page.getByTestId("reset-job").click();
    await expect(page.getByTestId("reset-job-dialog")).toBeVisible();
    await page.getByTestId("reset-job-confirm").click();

    await expect.poll(() => resetCalls).toBe(1);
    await expect.poll(() => snapshotCalls).toBeGreaterThan(1);
    await expect(page.getByTestId("tracklist-row")).toHaveCount(0);
  });

  test("re-analyse selection POSTs the right region", async ({ page }) => {
    const handle = await mockAnalyserApi(page);
    await page.goto(`/analyser?job=${FAKE_JOB_ID}`);
    await expect(page.getByTestId("analyser-main")).toBeVisible();

    // Drag a region across the first half of the timeline. Start past
    // the left rail (which holds y-axis labels + transport, not part of
    // the chart) so the drag actually lands in the chart area.
    const timeline = page.getByTestId("analyser-timeline");
    const box = await timeline.boundingBox();
    if (!box) throw new Error("timeline has no bounding box");
    await page.mouse.move(box.x + 100, box.y + 20);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.4, box.y + 20);
    await page.mouse.up();

    await expect(page.getByTestId("timeline-selection")).toBeVisible();
    await expect(page.getByTestId("detail-pane")).toBeVisible();
    await page.getByTestId("detail-reanalyse").click();

    await expect.poll(handle.reanalyseCallCount).toBeGreaterThan(0);
  });

  test("BPM fix snaps a misdetected span to the neighbour tempo", async ({
    page,
  }) => {
    const BPM_JOB = "test-bpm-job";
    const patches: Array<Record<string, unknown>> = [];

    // 143.8 BPM at the edges, a misdetected 95.9 dip in the middle.
    // Gaps around the dip keep the imprecise mouse-drag selection from
    // catching any 143.8 windows.
    const windows: Array<Record<string, unknown>> = [];
    for (let s = 0; s < 1000; s += 30) {
      if ((s > 200 && s < 310) || (s > 430 && s < 600)) continue;
      windows.push({
        start_s: s,
        end_s: s + 30,
        bpm: s >= 310 && s <= 430 ? 95.9 : 143.8,
        confidence: "medium",
      });
    }

    await page.route(/\/api\/analyser\/sets$/, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ jobs: [] }),
      }),
    );
    await page.route(new RegExp(`/api/analyser/sets/${BPM_JOB}$`), (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          id: BPM_JOB,
          soundcloud_id: 1,
          source_url: null,
          title: "BPM Fix Set",
          artist: "Tester",
          duration_s: 1000,
          status: "complete",
          options: {
            pitch_strategy: "none",
            window_s: 30,
            hop_s: 30,
            min_section_gap_s: 30,
            sections_enabled: true,
            scan_cadence_s: 60,
            scan_window_s: 12,
          },
          error: null,
          created_at: 0,
          updated_at: 0,
          windows,
          sections: [],
          scans: [],
          timeline: [],
        }),
      }),
    );
    await page.route(
      new RegExp(`/api/analyser/sets/${BPM_JOB}/events$`),
      (route) =>
        route.fulfill({
          status: 200,
          contentType: "text/event-stream",
          headers: { "Cache-Control": "no-cache" },
          body: "",
        }),
    );
    await page.route(
      new RegExp(`/api/analyser/sets/${BPM_JOB}/windows$`),
      (route) => {
        patches.push(route.request().postDataJSON() as Record<string, unknown>);
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ job_id: BPM_JOB, updated: 5 }),
        });
      },
    );

    await page.goto(`/analyser?job=${BPM_JOB}`);
    await expect(page.getByTestId("analyser-main")).toBeVisible();

    // Drag a selection over the dip (roughly 30%–50% of the timeline).
    const timeline = page.getByTestId("analyser-timeline");
    const box = await timeline.boundingBox();
    if (!box) throw new Error("timeline has no bounding box");
    await page.mouse.move(box.x + box.width * 0.3, box.y + 20);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.5, box.y + 20);
    await page.mouse.up();

    await expect(page.getByTestId("detail-pane")).toBeVisible();
    // The dip is metrically related to its neighbours (95.9 × 3/2 ≈
    // 143.8) so the snap suggestion appears with the neighbour tempo.
    const snap = page.getByTestId("detail-bpm-snap");
    await expect(snap).toContainText("143.8");
    await snap.click();

    await expect.poll(() => patches.length).toBe(1);
    expect(patches[0].bpm).toBe(143.8);
    expect(patches[0].start_s as number).toBeGreaterThan(200);
    expect(patches[0].end_s as number).toBeLessThan(600);

    // Manual path: type an explicit BPM and apply.
    await page.getByTestId("detail-bpm-input").fill("150");
    await page.getByTestId("detail-bpm-apply").click();
    await expect.poll(() => patches.length).toBe(2);
    expect(patches[1].bpm).toBe(150);
  });

  test("BPM fix offers a snap for a single-window spike", async ({ page }) => {
    const SPIKE_JOB = "test-bpm-spike-job";
    const patches: Array<Record<string, unknown>> = [];

    // Dead-flat 128 BPM across the whole mix, with one window spiking to
    // 200. The spike doesn't move the selection median (it's washed out
    // by the surrounding flat windows), so only the spike-detection path
    // can surface a snap suggestion here.
    const windows: Array<Record<string, unknown>> = [];
    for (let s = 0; s < 1000; s += 30) {
      windows.push({
        start_s: s,
        end_s: s + 30,
        bpm: s === 390 ? 200.0 : 128.0,
        confidence: "medium",
      });
    }

    await page.route(/\/api\/analyser\/sets$/, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ jobs: [] }),
      }),
    );
    await page.route(new RegExp(`/api/analyser/sets/${SPIKE_JOB}$`), (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          id: SPIKE_JOB,
          soundcloud_id: 1,
          source_url: null,
          title: "BPM Spike Set",
          artist: "Tester",
          duration_s: 1000,
          status: "complete",
          options: {
            pitch_strategy: "none",
            window_s: 30,
            hop_s: 30,
            min_section_gap_s: 30,
            sections_enabled: true,
            scan_cadence_s: 60,
            scan_window_s: 12,
          },
          error: null,
          created_at: 0,
          updated_at: 0,
          windows,
          sections: [],
          scans: [],
          timeline: [],
        }),
      }),
    );
    await page.route(
      new RegExp(`/api/analyser/sets/${SPIKE_JOB}/events$`),
      (route) =>
        route.fulfill({
          status: 200,
          contentType: "text/event-stream",
          headers: { "Cache-Control": "no-cache" },
          body: "",
        }),
    );
    await page.route(
      new RegExp(`/api/analyser/sets/${SPIKE_JOB}/windows$`),
      (route) => {
        patches.push(route.request().postDataJSON() as Record<string, unknown>);
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ job_id: SPIKE_JOB, updated: 7 }),
        });
      },
    );

    await page.goto(`/analyser?job=${SPIKE_JOB}`);
    await expect(page.getByTestId("analyser-main")).toBeVisible();

    // Drag a selection over the spike (~30%–50%), which also captures the
    // flat 128 windows on either side of it.
    const timeline = page.getByTestId("analyser-timeline");
    const box = await timeline.boundingBox();
    if (!box) throw new Error("timeline has no bounding box");
    await page.mouse.move(box.x + box.width * 0.3, box.y + 20);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.5, box.y + 20);
    await page.mouse.up();

    await expect(page.getByTestId("detail-pane")).toBeVisible();
    // Median sits on 128 (the spike is a lone outlier), so the snap
    // offers to flatten the span back to the neighbour tempo.
    const snap = page.getByTestId("detail-bpm-snap");
    await expect(snap).toContainText("128.0");
    await snap.click();
    await expect.poll(() => patches.length).toBe(1);
    expect(patches[0].bpm).toBe(128.0);
  });

  test("scan progress counts only the active run, not cached history", async ({
    page,
  }) => {
    const RUN_JOB = "test-progress-job";
    await page.route(/\/api\/analyser\/sets$/, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ jobs: [] }),
      }),
    );
    await page.route(new RegExp(`/api/analyser/sets/${RUN_JOB}$`), (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          id: RUN_JOB,
          soundcloud_id: 1,
          source_url: null,
          title: "Progress Set",
          artist: "Tester",
          duration_s: 600,
          status: "running",
          options: {
            pitch_strategy: "none",
            window_s: 30,
            hop_s: 25,
            min_section_gap_s: 30,
            sections_enabled: true,
            scan_cadence_s: 60,
            scan_window_s: 12,
          },
          error: null,
          created_at: 0,
          updated_at: 0,
          windows: [],
          sections: [],
          scans: [],
          timeline: [],
        }),
      }),
    );
    const mkScan = (scan_s: number) => ({
      event: "shazam.scan",
      data: {
        type: "shazam.scan",
        job_id: RUN_JOB,
        scan_s,
        title: "Cached Hit",
        artist: "A",
        shazam_id: "shz-1",
        confidence: 0.9,
        pitch_offset: 0,
        tier: "sweep",
      },
    });
    await page.route(
      new RegExp(`/api/analyser/sets/${RUN_JOB}/events$`),
      (route) =>
        route.fulfill({
          status: 200,
          contentType: "text/event-stream",
          headers: { "Cache-Control": "no-cache" },
          // Replay shape after the backend fix: cached scan rows FIRST,
          // then the run marker carrying completed_points, then live
          // scans. The two cached rows must not inflate the counter.
          body: sseBody([
            {
              event: "meta",
              data: {
                type: "meta",
                job_id: RUN_JOB,
                duration_s: 600,
                sample_rate: 22050,
                title: "Progress Set",
                artist: "Tester",
              },
            },
            mkScan(0),
            mkScan(60),
            {
              event: "shazam.scan_started",
              data: {
                type: "shazam.scan_started",
                job_id: RUN_JOB,
                tier: "sweep",
                region: null,
                total_points: 10,
                completed_points: 2,
              },
            },
            mkScan(120),
          ]),
        }),
    );

    await page.goto(`/analyser?job=${RUN_JOB}`);
    const progress = page.getByTestId("analyser-progress");
    await expect(progress).toBeVisible();
    await expect(progress).toContainText("3/10 points");
    await expect(page.getByTestId("analyser-progress-percent")).toHaveText(
      "30%",
    );
  });

  test("preview button survives scan-cache loss via track-level preview_url", async ({
    page,
  }) => {
    const PREVIEW_JOB = "test-preview-job";
    await page.route(/\/api\/analyser\/sets$/, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ jobs: [] }),
      }),
    );
    await page.route(
      new RegExp(`/api/analyser/sets/${PREVIEW_JOB}$`),
      (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            id: PREVIEW_JOB,
            soundcloud_id: 1,
            source_url: null,
            title: "Preview Set",
            artist: "Tester",
            duration_s: 600,
            status: "complete",
            options: {
              pitch_strategy: "none",
              window_s: 30,
              hop_s: 25,
              min_section_gap_s: 30,
              sections_enabled: true,
              scan_cadence_s: 60,
              scan_window_s: 12,
            },
            error: null,
            created_at: 0,
            updated_at: 0,
            windows: [],
            sections: [],
            // Scans are EMPTY — the cached rows that used to carry the
            // preview were overwritten by a re-probe. The track row's
            // persisted preview_url must keep the button alive.
            scans: [],
            timeline: [
              {
                id: 1,
                start_s: 0,
                end_s: 120,
                title: "Kept Preview",
                artist: "DJ",
                shazam_id: "shz-keep",
                confidence: 0.9,
                source: "shazam",
                soundcloud_id: null,
                soundcloud_permalink_url: null,
                artwork_url: null,
                preview_url: "https://cdn.example/preview.m4a",
                duration_s: null,
                confirmed: false,
                user_edited: false,
                set_bpm: null,
                pitch_offset: null,
              },
            ],
          }),
        }),
    );
    await page.route(
      new RegExp(`/api/analyser/sets/${PREVIEW_JOB}/events$`),
      (route) =>
        route.fulfill({
          status: 200,
          contentType: "text/event-stream",
          headers: { "Cache-Control": "no-cache" },
          body: "",
        }),
    );

    await page.goto(`/analyser?job=${PREVIEW_JOB}`);
    await expect(page.getByTestId("tracklist-row")).toHaveCount(1);

    // Clicking the preview button opens the in-section waveform popover
    // (not the global player bar). The Shazam clip URL is mocked empty —
    // we only assert the popover surface renders, not decoded playback.
    await page.route("https://cdn.example/preview.m4a", (route) =>
      route.fulfill({ status: 200, contentType: "audio/mp4", body: "" }),
    );
    await page.getByTestId("shazam-preview").click();
    await expect(page.getByTestId("shazam-preview-popover")).toBeVisible();
    await expect(page.getByTestId("preview-toggle")).toBeVisible();
    // The "open on Shazam" link lives inside the preview popover now.
    await expect(page.getByTestId("shazam-link")).toHaveAttribute(
      "href",
      /shazam\.com\/track\/shz-keep/,
    );
  });

  test("alignment dialog saves a nudged start_s", async ({ page }) => {
    const ALIGN_JOB = "test-align-job";
    const patches: Array<Record<string, unknown>> = [];

    await page.addInitScript(() => {
      const future = Date.now() + 60 * 60 * 1000;
      localStorage.setItem("access_token", "fake-token");
      localStorage.setItem("token_expires_at", String(future));
    });
    await page.route(/\/api\/analyser\/sets$/, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ jobs: [] }),
      }),
    );
    await page.route(new RegExp(`/api/analyser/sets/${ALIGN_JOB}$`), (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          id: ALIGN_JOB,
          soundcloud_id: 1,
          source_url: null,
          title: "Align Set",
          artist: "Tester",
          duration_s: 600,
          status: "complete",
          options: {
            pitch_strategy: "single",
            target_bpm: 124,
            window_s: 30,
            hop_s: 25,
            min_section_gap_s: 30,
            sections_enabled: true,
            scan_cadence_s: 60,
            scan_window_s: 12,
          },
          error: null,
          created_at: 0,
          updated_at: 0,
          windows: [],
          sections: [],
          scans: [],
          timeline: [
            {
              id: 42,
              start_s: 60,
              end_s: 240,
              title: "Pinned Track",
              artist: "DJ Y",
              shazam_id: "shz-pin",
              confidence: 0.95,
              source: "shazam",
              soundcloud_id: 9001,
              soundcloud_permalink_url: null,
              artwork_url: null,
              duration_s: 200,
              confirmed: false,
              user_edited: false,
              set_bpm: 128,
              pitch_offset: -0.5,
            },
          ],
        }),
      }),
    );
    await page.route(
      new RegExp(`/api/analyser/sets/${ALIGN_JOB}/events$`),
      (route) =>
        route.fulfill({
          status: 200,
          contentType: "text/event-stream",
          headers: { "Cache-Control": "no-cache" },
          body: "",
        }),
    );
    // The MIX strip decodes the set audio in URL mode — needs real bytes
    // to reach "ready". Long enough that the 60 s track start isn't clamped
    // to the set length.
    await page.route(
      new RegExp(`/api/analyser/sets/${ALIGN_JOB}/audio$`),
      (route) =>
        route.fulfill({
          status: 200,
          contentType: "audio/wav",
          headers: { "Accept-Ranges": "bytes" },
          body: silentWav(70),
        }),
    );
    await page.route(/\/api\/soundcloud\/tracks\/9001\/stream/, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          url: "https://example.invalid/stream.m3u8",
          expires_at: new Date(Date.now() + 600_000).toISOString(),
        }),
      }),
    );
    // The SC strip paints from the track's own waveform data (the HLS
    // element has no fetchable src for WaveSurfer to decode).
    await page.route(/api\.soundcloud\.com\/tracks\//, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          id: 9001,
          urn: "soundcloud:tracks:9001",
          title: "Pinned Track",
          duration: 200_000,
          waveform_url: "https://wave.invalid/9001.json",
        }),
      }),
    );
    await page.route(/wave\.invalid\/9001\.json/, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          samples: Array.from({ length: 400 }, (_, i) => (i % 20) + 1),
        }),
      }),
    );
    // High-res peaks decoded server-side (the SC strip's fidelity source).
    await page.route(/\/api\/soundcloud\/tracks\/\d+\/peaks/, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          peaks: Array.from({ length: 500 }, (_, i) => Math.abs(Math.sin(i))),
          duration_s: 200,
          bpm: 128,
        }),
      }),
    );
    await page.route(
      new RegExp(`/api/analyser/sets/${ALIGN_JOB}/tracks/42$`),
      async (route) => {
        if (route.request().method() === "PATCH") {
          patches.push(
            route.request().postDataJSON() as Record<string, unknown>,
          );
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              job_id: ALIGN_JOB,
              track_id: 42,
              updated: true,
            }),
          });
          return;
        }
        await route.fallback();
      },
    );

    await page.goto(`/analyser?job=${ALIGN_JOB}`);
    await expect(page.getByTestId("tracklist-row")).toHaveCount(1);

    // Hover to surface the row's hover-only buttons.
    await page.getByTestId("tracklist-row").hover();
    await page.getByTestId("align-track").click();
    await expect(page.getByTestId("alignment-dialog")).toBeVisible();
    await expect(page.getByTestId("alignment-new-start")).toContainText(
      "01:00",
    );
    // Both strips must finish loading, not spin forever: the MIX strip
    // (mount effect fired before the portal attached its container) and
    // the Original/SC strip (rendered blank without a known duration).
    await expect(
      page.getByTestId("alignment-set-strip").getByTestId("waveform-loading"),
    ).toHaveCount(0);
    await expect(
      page.getByTestId("alignment-sc-strip").getByTestId("waveform-loading"),
    ).toHaveCount(0);

    // The zoomed waveform must scroll inside its strip, not blow the
    // strip (and dialog) out past its max width. A 200 s original at
    // ~40 px/s would be ~8000 px wide if unbounded.
    const scBox = await page.getByTestId("alignment-sc-strip").boundingBox();
    expect(scBox).not.toBeNull();
    expect(scBox!.width).toBeLessThan(800);

    // Save is disabled at zero offset; drag the mix strip left to push the
    // start well past its detected 60 s (dragging left = later mix time).
    await expect(page.getByTestId("alignment-save")).toBeDisabled();
    const dragStrip = async (testId: string, dx: number) => {
      const box = await page.getByTestId(`${testId}-drag`).boundingBox();
      const cx = box!.x + box!.width / 2;
      const cy = box!.y + box!.height / 2;
      await page.mouse.move(cx, cy);
      await page.mouse.down();
      await page.mouse.move(cx + dx, cy, { steps: 6 });
      await page.mouse.up();
    };
    await dragStrip("alignment-set-strip", -200);
    await expect(page.getByTestId("alignment-save")).toBeEnabled();
    // "Save & mark aligned" persists the start AND promotes the row to the
    // highest curation tier (confirmed + aligned).
    await page.getByTestId("alignment-save-aligned").click();

    await expect.poll(() => patches.length).toBeGreaterThan(0);
    const sent = patches[0];
    expect(typeof sent.start_s).toBe("number");
    expect(sent.start_s as number).toBeGreaterThan(60);
    expect(sent.confirmed).toBe(true);
    expect(sent.aligned).toBe(true);
  });

  test("alignment dialog corrects a misdetected original BPM", async ({
    page,
  }) => {
    const ALIGN_JOB = "test-bpm-correct-job";
    const bpmPuts: number[] = [];
    let reanalysed = false;
    let reverted = false;

    await page.addInitScript(() => {
      const future = Date.now() + 60 * 60 * 1000;
      localStorage.setItem("access_token", "fake-token");
      localStorage.setItem("token_expires_at", String(future));
    });
    await page.route(/\/api\/analyser\/sets$/, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ jobs: [] }),
      }),
    );
    await page.route(new RegExp(`/api/analyser/sets/${ALIGN_JOB}$`), (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          id: ALIGN_JOB,
          soundcloud_id: 1,
          source_url: null,
          title: "Align Set",
          artist: "Tester",
          duration_s: 600,
          status: "complete",
          options: {
            pitch_strategy: "single",
            target_bpm: 124,
            window_s: 30,
            hop_s: 25,
            min_section_gap_s: 30,
            sections_enabled: true,
            scan_cadence_s: 60,
            scan_window_s: 12,
          },
          error: null,
          created_at: 0,
          updated_at: 0,
          windows: [],
          sections: [],
          scans: [],
          timeline: [
            {
              id: 42,
              start_s: 60,
              end_s: 240,
              title: "Pinned Track",
              artist: "DJ Y",
              shazam_id: "shz-pin",
              confidence: 0.95,
              source: "shazam",
              soundcloud_id: 9001,
              soundcloud_permalink_url: null,
              artwork_url: null,
              duration_s: 200,
              confirmed: false,
              user_edited: false,
              set_bpm: 128,
              pitch_offset: 0,
            },
          ],
        }),
      }),
    );
    await page.route(
      new RegExp(`/api/analyser/sets/${ALIGN_JOB}/events$`),
      (route) =>
        route.fulfill({
          status: 200,
          contentType: "text/event-stream",
          headers: { "Cache-Control": "no-cache" },
          body: "",
        }),
    );
    await page.route(
      new RegExp(`/api/analyser/sets/${ALIGN_JOB}/audio$`),
      (route) =>
        route.fulfill({
          status: 200,
          contentType: "audio/wav",
          headers: { "Accept-Ranges": "bytes" },
          body: silentWav(70),
        }),
    );
    await page.route(/\/api\/soundcloud\/tracks\/9001\/stream/, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          url: "https://example.invalid/stream.m3u8",
          expires_at: new Date(Date.now() + 600_000).toISOString(),
        }),
      }),
    );
    await page.route(/api\.soundcloud\.com\/tracks\//, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          id: 9001,
          urn: "soundcloud:tracks:9001",
          title: "Pinned Track",
          duration: 200_000,
          waveform_url: "https://wave.invalid/9001.json",
        }),
      }),
    );
    await page.route(/wave\.invalid\/9001\.json/, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          samples: Array.from({ length: 400 }, (_, i) => (i % 20) + 1),
        }),
      }),
    );
    // Detection reports a half-time 64 BPM for a 128 track (octave error).
    await page.route(/\/api\/soundcloud\/tracks\/\d+\/peaks/, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          peaks: Array.from({ length: 500 }, (_, i) => Math.abs(Math.sin(i))),
          duration_s: 200,
          bpm: 64,
          bpm_overridden: false,
        }),
      }),
    );
    // Reanalyse re-runs detection (returns the same value, no override).
    await page.route(
      /\/api\/soundcloud\/tracks\/\d+\/bpm\/reanalyse$/,
      (route) => {
        reanalysed = true;
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ bpm: 64, bpm_overridden: false }),
        });
      },
    );
    // Manual correction (PUT) and revert (DELETE) on the same path.
    await page.route(/\/api\/soundcloud\/tracks\/\d+\/bpm$/, (route) => {
      const method = route.request().method();
      if (method === "PUT") {
        const body = route.request().postDataJSON() as { bpm: number };
        bpmPuts.push(body.bpm);
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ bpm: body.bpm, bpm_overridden: true }),
        });
      }
      reverted = true;
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ bpm: 64, bpm_overridden: false }),
      });
    });

    await page.goto(`/analyser?job=${ALIGN_JOB}`);
    await expect(page.getByTestId("tracklist-row")).toHaveCount(1);
    await page.getByTestId("tracklist-row").hover();
    await page.getByTestId("align-track").click();
    await expect(page.getByTestId("alignment-dialog")).toBeVisible();

    // Starts on the misdetected 64 BPM, no correction badge.
    await expect(page.getByTestId("alignment-orig-bpm")).toContainText(
      "64.0 BPM",
    );
    await expect(page.getByTestId("alignment-bpm-corrected")).toHaveCount(0);

    // Correct it to 128: type the value and save.
    await page.getByTestId("alignment-bpm-edit").click();
    await page.getByTestId("alignment-bpm-input").fill("128");
    await page.getByTestId("alignment-bpm-save").click();

    await expect(page.getByTestId("alignment-orig-bpm")).toContainText(
      "128.0 BPM",
    );
    await expect(page.getByTestId("alignment-bpm-corrected")).toBeVisible();
    expect(bpmPuts).toEqual([128]);

    // Revert (DELETE) drops back to the detected value and clears the badge.
    await page.getByTestId("alignment-bpm-revert").click();
    await expect(page.getByTestId("alignment-orig-bpm")).toContainText(
      "64.0 BPM",
    );
    await expect(page.getByTestId("alignment-bpm-corrected")).toHaveCount(0);
    expect(reverted).toBe(true);

    // Reanalyse re-runs detection (deterministic here, still 64).
    await page.getByTestId("alignment-bpm-reanalyse").click();
    await expect.poll(() => reanalysed).toBe(true);
    await expect(page.getByTestId("alignment-orig-bpm")).toContainText(
      "64.0 BPM",
    );
  });

  test("alignment strips scroll to the track and follow playback", async ({
    page,
  }) => {
    const JOB = "test-align-scroll-job";

    await page.addInitScript(() => {
      const future = Date.now() + 60 * 60 * 1000;
      localStorage.setItem("access_token", "fake-token");
      localStorage.setItem("token_expires_at", String(future));
    });
    await page.route(/\/api\/analyser\/sets$/, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ jobs: [] }),
      }),
    );
    await page.route(new RegExp(`/api/analyser/sets/${JOB}/events$`), (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        headers: { "Cache-Control": "no-cache" },
        body: "",
      }),
    );
    // A 120 s mix so the strip is far wider than the viewport and has
    // room to keep scrolling during playback (40 s in, at ~16 px/s).
    await page.route(new RegExp(`/api/analyser/sets/${JOB}/audio$`), (route) =>
      route.fulfill({
        status: 200,
        contentType: "audio/wav",
        headers: { "Accept-Ranges": "bytes" },
        body: silentWav(120),
      }),
    );
    await page.route(new RegExp(`/api/analyser/sets/${JOB}$`), (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          id: JOB,
          soundcloud_id: 1,
          source_url: null,
          title: "Scroll Set",
          artist: "Tester",
          duration_s: 120,
          status: "complete",
          options: {
            pitch_strategy: "none",
            window_s: 30,
            hop_s: 25,
            min_section_gap_s: 30,
            sections_enabled: true,
            scan_cadence_s: 45,
            scan_window_s: 12,
          },
          error: null,
          created_at: 0,
          updated_at: 0,
          windows: [],
          sections: [],
          scans: [],
          timeline: [
            {
              id: 77,
              start_s: 40,
              end_s: 100,
              title: "Mid Track",
              artist: "DJ Z",
              shazam_id: "shz-mid",
              confidence: 0.9,
              source: "shazam",
              soundcloud_id: 7700,
              soundcloud_permalink_url: null,
              artwork_url: null,
              duration_s: 200,
              confirmed: false,
              user_edited: false,
              set_bpm: null,
              pitch_offset: 0,
            },
          ],
        }),
      }),
    );
    await page.route(/api\.soundcloud\.com\/tracks\//, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          id: 7700,
          urn: "soundcloud:tracks:7700",
          title: "Mid Track",
          duration: 200_000,
          waveform_url: "https://wave.invalid/7700.json",
        }),
      }),
    );
    await page.route(/wave\.invalid\/7700\.json/, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          samples: Array.from({ length: 400 }, (_, i) => (i % 20) + 1),
        }),
      }),
    );
    await page.route(/\/api\/soundcloud\/tracks\/7700\/stream/, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          url: "https://example.invalid/stream.m3u8",
          expires_at: null,
        }),
      }),
    );
    await page.route(/\/api\/soundcloud\/tracks\/\d+\/peaks/, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          peaks: Array.from({ length: 500 }, (_, i) => Math.abs(Math.sin(i))),
          duration_s: 200,
          bpm: 128,
        }),
      }),
    );

    await page.goto(`/analyser?job=${JOB}`);
    await expect(page.getByTestId("tracklist-row")).toHaveCount(1);
    await page.getByTestId("tracklist-row").hover();
    await page.getByTestId("align-track").click();
    await expect(page.getByTestId("alignment-dialog")).toBeVisible();
    await expect(page.getByTestId("alignment-new-start")).toContainText(
      "00:40",
    );
    await expect(
      page.getByTestId("alignment-set-strip").getByTestId("waveform-loading"),
    ).toHaveCount(0);

    // Read the scrollLeft of WaveSurfer's own (shadow-DOM) scroll
    // container — the element the fix actually moves. The old code set the
    // outer container's scrollLeft, which does nothing here, leaving this 0.
    const mixScrollLeft = () =>
      page.getByTestId("alignment-set-strip").evaluate((el) => {
        const host = [...el.querySelectorAll("div")].find((d) => d.shadowRoot);
        const scroll = host?.shadowRoot?.querySelector(".scroll");
        return scroll instanceof HTMLElement ? scroll.scrollLeft : -1;
      });

    // Centred on 40 s → scrolled well past 0 (old behaviour: stuck at 0,
    // showing the very start of the mix instead of the track region).
    await expect.poll(mixScrollLeft).toBeGreaterThan(50);

    // Zoom control: zooming in raises px/s, so the same centred time sits
    // further along the (wider) waveform — scrollLeft grows without the mix
    // re-decoding (ws.zoom re-renders from existing peaks).
    const zoom = page.getByTestId("alignment-zoom").getByRole("slider");
    const zoomValue = () => zoom.getAttribute("aria-valuenow");
    const beforeZoomValue = await zoomValue();
    const beforeZoomScroll = await mixScrollLeft();
    await zoom.focus();
    for (let i = 0; i < 20; i++) await zoom.press("ArrowRight");
    await expect.poll(zoomValue).not.toBe(beforeZoomValue);
    await expect.poll(mixScrollLeft).toBeGreaterThan(beforeZoomScroll);

    // Reset returns the zoom to its default (1.0×).
    await page.getByTestId("alignment-zoom-reset").click();
    await expect(page.getByTestId("alignment-zoom-value")).toHaveText("1.0×");

    // Jog both: scrubs both decks together, so the mix scrolls forward but
    // the computed start (the alignment) is unchanged.
    const startText = () => page.getByTestId("alignment-new-start").innerText();
    const beforeJogStart = await startText();
    const beforeJogScroll = await mixScrollLeft();
    await page.getByTestId("alignment-jog-30").click();
    await expect.poll(mixScrollLeft).toBeGreaterThan(beforeJogScroll);
    expect(await startText()).toBe(beforeJogStart);

    // Both strips are draggable; the saved start recomputes from both
    // positions with no fixed nudge cap.
    const dragStrip = async (testId: string, dx: number) => {
      const box = await page.getByTestId(`${testId}-drag`).boundingBox();
      const cx = box!.x + box!.width / 2;
      const cy = box!.y + box!.height / 2;
      await page.mouse.move(cx, cy);
      await page.mouse.down();
      await page.mouse.move(cx + dx, cy, { steps: 6 });
      await page.mouse.up();
    };
    const beforeMixDrag = await startText();
    await dragStrip("alignment-set-strip", -120);
    await expect.poll(startText).not.toBe(beforeMixDrag);
    const afterMixDrag = await startText();
    await dragStrip("alignment-sc-strip", -120);
    await expect.poll(startText).not.toBe(afterMixDrag);

    // DJ-style transport + headphone cue (mix / original / master).
    await expect(page.getByTestId("alignment-play-toggle")).toBeVisible();
    await expect(page.getByTestId("alignment-cue-mix")).toBeVisible();
    await expect(page.getByTestId("alignment-cue-original")).toBeVisible();
    await expect(page.getByTestId("alignment-cue-both")).toBeVisible();

    // Transport runs both decks; the mix strip must scroll to keep the
    // playhead centred (old behaviour: nothing moved with the audio).
    const beforePlay = await mixScrollLeft();
    await page.getByTestId("alignment-play-toggle").click();
    await expect
      .poll(mixScrollLeft, { timeout: 4000 })
      .toBeGreaterThan(beforePlay + 15);
  });

  test("alignment resolves a SoundCloud original for a Shazam-only track", async ({
    page,
  }) => {
    const JOB = "test-align-resolve-job";
    const cover =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

    await page.addInitScript(() => {
      const future = Date.now() + 60 * 60 * 1000;
      localStorage.setItem("access_token", "fake-token");
      localStorage.setItem("token_expires_at", String(future));
    });
    await page.route(/\/api\/analyser\/sets$/, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ jobs: [] }),
      }),
    );
    await page.route(new RegExp(`/api/analyser/sets/${JOB}/events$`), (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        headers: { "Cache-Control": "no-cache" },
        body: "",
      }),
    );
    await page.route(new RegExp(`/api/analyser/sets/${JOB}/audio$`), (route) =>
      route.fulfill({
        status: 200,
        contentType: "audio/wav",
        headers: { "Accept-Ranges": "bytes" },
        body: silentWav(3),
      }),
    );
    await page.route(new RegExp(`/api/analyser/sets/${JOB}$`), (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          id: JOB,
          soundcloud_id: 1,
          source_url: null,
          title: "Resolve Set",
          artist: "Tester",
          duration_s: 600,
          status: "complete",
          options: {
            pitch_strategy: "none",
            window_s: 30,
            hop_s: 25,
            min_section_gap_s: 30,
            sections_enabled: true,
            scan_cadence_s: 45,
            scan_window_s: 12,
          },
          error: null,
          created_at: 0,
          updated_at: 0,
          windows: [],
          sections: [],
          scans: [],
          timeline: [
            {
              id: 50,
              start_s: 1331,
              end_s: 1331,
              title: "Get It",
              artist: "mischluft",
              shazam_id: "shz-g",
              confidence: 0.9,
              source: "shazam",
              soundcloud_id: null, // Shazam row: no persisted SC id
              soundcloud_permalink_url: null,
              artwork_url: cover,
              duration_s: null,
              confirmed: false,
              user_edited: false,
              set_bpm: 144,
              pitch_offset: 0,
            },
          ],
        }),
      }),
    );
    // Title+artist search resolves the SoundCloud original (Shazam gives
    // no soundcloud_id).
    await page.route(/api\.soundcloud\.com\/tracks\?/, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          {
            id: 8002,
            urn: "soundcloud:tracks:8002",
            title: "Get It",
            artwork_url: cover,
            waveform_url: "https://wave.invalid/8002.json",
            duration: 180_000,
            user: { username: "mischluft", urn: "soundcloud:users:2" },
          },
        ]),
      }),
    );
    await page.route(/api\.soundcloud\.com\/tracks\/soundcloud/, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          id: 8002,
          urn: "soundcloud:tracks:8002",
          title: "Get It",
          waveform_url: "https://wave.invalid/8002.json",
          duration: 180_000,
        }),
      }),
    );
    await page.route(/wave\.invalid\/8002\.json/, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          samples: Array.from({ length: 400 }, (_, i) => (i % 20) + 1),
        }),
      }),
    );
    await page.route(/\/api\/soundcloud\/tracks\/8002\/stream/, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          url: "https://example.invalid/stream.m3u8",
          expires_at: null,
        }),
      }),
    );
    // The Original strip's fidelity source is the server-decoded peaks
    // endpoint (SoundCloud's waveform_url is too coarse for alignment).
    let peaksFetched = false;
    await page.route(/\/api\/soundcloud\/tracks\/\d+\/peaks/, (route) => {
      peaksFetched = true;
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          peaks: Array.from({ length: 500 }, (_, i) => Math.abs(Math.sin(i))),
          duration_s: 200,
          bpm: 128,
        }),
      });
    });

    await page.goto(`/analyser?job=${JOB}`);
    await expect(page.getByTestId("tracklist-row")).toHaveCount(1);
    await page.getByTestId("tracklist-row").hover();
    await page.getByTestId("align-track").click();
    await expect(page.getByTestId("alignment-dialog")).toBeVisible();

    // The Original strip resolves via search instead of "no match", and
    // both strips finish loading.
    await expect(page.getByTestId("alignment-sc-strip")).not.toContainText(
      "No SoundCloud match",
    );
    await expect(
      page.getByTestId("alignment-sc-strip").getByTestId("waveform-loading"),
    ).toHaveCount(0);
    await expect(
      page.getByTestId("alignment-set-strip").getByTestId("waveform-loading"),
    ).toHaveCount(0);
    // The original paints REAL peaks decoded server-side from the resolved
    // track's audio, not the coarse waveform_url or the placeholder arch.
    expect(peaksFetched).toBe(true);

    // Per-strip BPM readouts: the mix shows the detected in-set tempo (144),
    // the original its native tempo (128 from the peaks endpoint) plus the
    // in-mix change factor.
    await expect(page.getByTestId("alignment-mix-bpm")).toContainText(
      "144.0 BPM",
    );
    await expect(page.getByTestId("alignment-orig-bpm")).toContainText(
      "128.0 BPM",
    );
    await expect(page.getByTestId("alignment-orig-bpm")).toContainText(
      "in mix",
    );
  });

  test("track status cycles none → confirmed → aligned and marks the band", async ({
    page,
  }) => {
    const JOB = "test-status-cycle-job";
    // Stateful: the PATCH updates these, the snapshot GET reflects them so
    // the row re-renders after each refresh.
    let confirmed = false;
    let aligned = false;

    await page.route(/\/api\/analyser\/sets$/, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ jobs: [] }),
      }),
    );
    await page.route(new RegExp(`/api/analyser/sets/${JOB}/events$`), (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        headers: { "Cache-Control": "no-cache" },
        body: "",
      }),
    );
    await page.route(new RegExp(`/api/analyser/sets/${JOB}/audio$`), (route) =>
      route.fulfill({
        status: 200,
        contentType: "audio/wav",
        headers: { "Accept-Ranges": "bytes" },
        body: silentWav(3),
      }),
    );
    await page.route(new RegExp(`/api/analyser/sets/${JOB}$`), (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          id: JOB,
          soundcloud_id: 1,
          source_url: null,
          title: "Status Set",
          artist: "Tester",
          duration_s: 600,
          status: "complete",
          options: {
            pitch_strategy: "none",
            window_s: 30,
            hop_s: 25,
            min_section_gap_s: 30,
            sections_enabled: true,
            scan_cadence_s: 45,
            scan_window_s: 12,
          },
          error: null,
          created_at: 0,
          updated_at: 0,
          windows: [],
          sections: [],
          scans: [],
          timeline: [
            {
              id: 5,
              start_s: 100,
              end_s: 260,
              title: "Cue Track",
              artist: "DJ Q",
              shazam_id: "shz-cue",
              confidence: 0.9,
              source: "shazam",
              soundcloud_id: null,
              soundcloud_permalink_url: null,
              artwork_url: null,
              duration_s: 200,
              confirmed,
              aligned,
              user_edited: false,
              set_bpm: null,
              pitch_offset: 0,
            },
          ],
        }),
      }),
    );
    await page.route(
      new RegExp(`/api/analyser/sets/${JOB}/tracks/5$`),
      async (route) => {
        if (route.request().method() === "PATCH") {
          const body = route.request().postDataJSON() as {
            confirmed?: boolean;
            aligned?: boolean;
          };
          if (body.confirmed !== undefined) confirmed = body.confirmed;
          if (body.aligned !== undefined) aligned = body.aligned;
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ job_id: JOB, track_id: 5, updated: true }),
          });
          return;
        }
        await route.fallback();
      },
    );

    await page.goto(`/analyser?job=${JOB}`);
    await expect(page.getByTestId("tracklist-row")).toHaveCount(1);
    await page.getByTestId("tracklist-row").hover();

    const status = page.getByTestId("track-status");
    await expect(status).toHaveAttribute("data-status", "none");

    // none → confirmed (green check)
    await status.click();
    await expect(status).toHaveAttribute("data-status", "confirmed");
    await expect(
      page.locator('[data-testid="track-band"][data-confirmed="true"]'),
    ).toHaveCount(1);

    // confirmed → aligned (amber badge); the band flips to the aligned tier
    await status.click();
    await expect(status).toHaveAttribute("data-status", "aligned");
    await expect(
      page.locator('[data-testid="track-band"][data-aligned="true"]'),
    ).toHaveCount(1);

    // aligned → none
    await status.click();
    await expect(status).toHaveAttribute("data-status", "none");
    await expect(
      page.locator('[data-testid="track-band"][data-confirmed="true"]'),
    ).toHaveCount(0);
  });

  test("confirmed tracks mark their band and a column over the upper lanes", async ({
    page,
  }) => {
    const CONFIRM_JOB = "test-confirm-job";
    await page.route(/\/api\/analyser\/sets$/, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ jobs: [] }),
      }),
    );
    await page.route(
      new RegExp(`/api/analyser/sets/${CONFIRM_JOB}$`),
      (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            id: CONFIRM_JOB,
            soundcloud_id: 1,
            source_url: null,
            title: "Confirm Set",
            artist: "Tester",
            duration_s: 600,
            status: "complete",
            options: {
              pitch_strategy: "none",
              window_s: 30,
              hop_s: 25,
              min_section_gap_s: 30,
              sections_enabled: true,
              scan_cadence_s: 60,
              scan_window_s: 12,
            },
            error: null,
            created_at: 0,
            updated_at: 0,
            windows: [],
            sections: [],
            scans: [],
            timeline: [
              {
                id: 1,
                start_s: 60,
                end_s: 180,
                title: "Confirmed Cut",
                artist: "DJ",
                shazam_id: "shz-yes",
                confidence: 0.9,
                source: "shazam",
                soundcloud_id: null,
                soundcloud_permalink_url: null,
                artwork_url: null,
                preview_url: null,
                duration_s: null,
                confirmed: true,
                user_edited: false,
                set_bpm: null,
                pitch_offset: null,
              },
              {
                id: 2,
                start_s: 420,
                end_s: 540,
                title: "Unconfirmed Cut",
                artist: "DJ",
                shazam_id: "shz-no",
                confidence: 0.9,
                source: "shazam",
                soundcloud_id: null,
                soundcloud_permalink_url: null,
                artwork_url: null,
                preview_url: null,
                duration_s: null,
                confirmed: false,
                user_edited: false,
                set_bpm: null,
                pitch_offset: null,
              },
            ],
          }),
        }),
    );
    await page.route(
      new RegExp(`/api/analyser/sets/${CONFIRM_JOB}/events$`),
      (route) =>
        route.fulfill({
          status: 200,
          contentType: "text/event-stream",
          headers: { "Cache-Control": "no-cache" },
          body: "",
        }),
    );

    await page.goto(`/analyser?job=${CONFIRM_JOB}`);
    await expect(page.getByTestId("track-band")).toHaveCount(2);

    // The confirmed band carries data-confirmed="true"; the other doesn't.
    await expect(
      page.locator('[data-testid="track-band"][data-confirmed="true"]'),
    ).toHaveCount(1);
    await expect(
      page.locator('[data-testid="track-band"][data-confirmed="false"]'),
    ).toHaveCount(1);

    // One column is drawn over the upper lanes — one per confirmed track.
    const overlay = page.getByTestId("timeline-confirmed-overlay");
    await expect(overlay).toBeVisible();
    await expect(overlay.locator(":scope > div")).toHaveCount(1);
  });
});
