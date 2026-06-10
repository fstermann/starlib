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

    // External Shazam link is present and targets the right host.
    const shazam = page.getByTestId("shazam-link");
    await expect(shazam).toHaveAttribute("href", /shazam\.com\/track\/abc123/);
    // The "find on SoundCloud" affordance is a button (resolves + plays
    // inline); the static search link is gone now.
    await expect(page.getByTestId("find-soundcloud")).toBeVisible();

    // Avoid the unused-handle lint warning when the helper has no
    // assertions in this particular test.
    void handle;
  });

  test("find on SoundCloud resolves a hit and starts the global player", async ({
    page,
  }) => {
    await mockAnalyserApi(page);
    await page.route(
      new RegExp(`/api/analyser/sets/${FAKE_JOB_ID}/audio$`),
      (route) =>
        route.fulfill({
          status: 200,
          contentType: "audio/mp4",
          body: "",
        }),
    );
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
            waveform_url: "https://example.com/wave.png",
            artwork_url: null,
            user: { username: "Mock Artist A", urn: "soundcloud:users:1" },
          },
        ]),
      });
    });

    await page.goto(`/analyser?job=${FAKE_JOB_ID}`);
    await expect(page.getByTestId("tracklist-panel")).toBeVisible();
    await page.getByTestId("find-soundcloud").click();
    // The click must trigger a /tracks search against the SoundCloud API.
    await expect.poll(() => searchCalls).toBeGreaterThan(0);
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
    const tempo = page.getByLabel("Tempo (BPM)");
    await tempo.fill("128");
    await tempo.blur();
    await page.getByTestId("run-shazam-sweep").click();
    await expect.poll(() => scanRequests.length).toBe(1);
    expect(scanRequests[0].overrides).toMatchObject({
      pitch_strategy: "single",
      target_bpm: 128,
      bpm_range: null,
    });

    // Add an Up-to value > tempo → strategy flips to range.
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
    await expect(
      page.getByTestId("run-shazam-item-pinpoint"),
    ).toHaveAttribute("data-disabled", "");
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
            soundcloud_permalink_url:
              "https://soundcloud.com/dj/hand-picked",
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

  test("alignment dialog saves a nudged start_s", async ({ page }) => {
    const ALIGN_JOB = "test-align-job";
    const patches: Array<Record<string, unknown>> = [];

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
    await page.route(
      /\/api\/soundcloud\/tracks\/9001\/stream/,
      (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            url: "https://example.invalid/stream.m3u8",
            expires_at: new Date(Date.now() + 600_000).toISOString(),
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
    await expect(page.getByTestId("alignment-new-start")).toContainText("01:00");

    // Save is disabled at zero offset; nudge via keyboard arrows on the
    // slider so we don't depend on pixel-precise drag coordinates.
    await expect(page.getByTestId("alignment-save")).toBeDisabled();
    await page.getByTestId("alignment-offset-slider").focus();
    for (let i = 0; i < 5; i++) {
      await page.keyboard.press("ArrowRight");
    }
    await expect(page.getByTestId("alignment-save")).toBeEnabled();
    await page.getByTestId("alignment-save").click();

    await expect.poll(() => patches.length).toBeGreaterThan(0);
    const sent = patches[0];
    expect(typeof sent.start_s).toBe("number");
    expect(sent.start_s as number).toBeGreaterThan(60);
  });
});
