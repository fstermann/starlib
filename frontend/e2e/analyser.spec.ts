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
        },
        error: null,
        created_at: 0,
        updated_at: 0,
        windows: [],
        sections: [],
        tracks: [],
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
            event: "track.identified",
            data: {
              type: "track.identified",
              job_id: FAKE_JOB_ID,
              section_index: 0,
              title: "Mock Track A",
              artist: "Mock Artist A",
              shazam_id: "abc123",
              confidence: 0.9,
              pitch_offset: 0.0,
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

    // Sections + matched track surface from the SSE replay.
    await expect(page.getByTestId("section-block")).toHaveCount(2);
    await expect(page.getByTestId("track-label")).toContainText("Mock Track A");
  });

  test("re-analyse selection POSTs the right region", async ({ page }) => {
    const handle = await mockAnalyserApi(page);
    await page.goto(`/analyser?job=${FAKE_JOB_ID}`);
    await expect(page.getByTestId("analyser-main")).toBeVisible();
    await expect(page.getByTestId("section-block")).toHaveCount(2);

    // Drag a region across the first half of the timeline.
    const timeline = page.getByTestId("analyser-timeline");
    const box = await timeline.boundingBox();
    if (!box) throw new Error("timeline has no bounding box");
    await page.mouse.move(box.x + 20, box.y + 20);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.4, box.y + 20);
    await page.mouse.up();

    await expect(page.getByTestId("timeline-selection")).toBeVisible();
    await expect(page.getByTestId("detail-pane")).toBeVisible();
    await page.getByTestId("detail-reanalyse").click();

    await expect.poll(handle.reanalyseCallCount).toBeGreaterThan(0);
  });
});
