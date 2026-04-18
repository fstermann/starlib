import { test as base, type Page } from "@playwright/test";

/**
 * Intercept backend API calls so tests run without a real backend.
 */
async function mockBackendApi(page: Page) {
  // Setup status — report as configured so SetupGate doesn't redirect.
  await page.route("**/api/setup/status", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ configured: true }),
    }),
  );

  // Health check
  await page.route("**/health", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ status: "ok" }),
    }),
  );

  // Folder initialization
  await page.route("**/api/metadata/folders/initialize", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ success: true, message: "Folders initialized" }),
    }),
  );

  // File listing for any folder mode
  await page.route("**/api/metadata/folders/*/files*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        items: [],
        total: 0,
        page: 1,
        size: 50,
        pages: 0,
      }),
    }),
  );

  // Browse endpoint (mode-based)
  await page.route("**/api/metadata/folders/*/browse*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        items: [],
        total: 0,
        page: 1,
        size: 50,
        pages: 0,
      }),
    }),
  );

  // Browse endpoint (path-based — match query string start to avoid matching filter-values)
  await page.route(/\/api\/metadata\/folders\/browse-path\?/, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        items: [],
        total: 0,
        page: 1,
        size: 50,
        pages: 0,
      }),
    }),
  );

  // Filter values (matches both mode-based and browse-path/filter-values)
  await page.route(/filter-values/, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        genres: [],
        genre_counts: {},
        artists: [],
        keys: [],
        key_counts: {},
        bpm_min: null,
        bpm_max: null,
      }),
    }),
  );

  // AI settings (needed to avoid errors when settings dialog loads)
  await page.route("**/api/ai/settings", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        provider: "ollama",
        ollama: { url: "http://localhost:11434", model: "" },
        anthropic: { model: "" },
        claude_code: { model: "" },
        anthropic_has_api_key: false,
      }),
    }),
  );

  await page.route("**/api/ai/status", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        available: false,
        installed: false,
        started_by_us: false,
      }),
    }),
  );

  // Folder tree
  await page.route("**/api/metadata/folders/tree", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        id: "/music",
        name: "music",
        children: [
          { id: "/music/prepare", name: "prepare", children: [] },
          { id: "/music/collection", name: "collection", children: [] },
          { id: "/music/cleaned", name: "cleaned", children: [] },
        ],
      }),
    }),
  );

  // Single folder ruleset (must be registered before rulesets-by-path so
  // the more specific route takes priority — Playwright matches last-registered first)
  await page.route("**/api/folders/ruleset?*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ path: "", ruleset_id: null }),
    }),
  );

  // All folder rulesets
  await page.route("**/api/folders/rulesets-by-path", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ folder_rulesets: {} }),
    }),
  );

  // Folders config
  await page.route("**/api/folders/config", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        folders: [
          { name: "prepare", label: "Prepare", visible: true, order: 0 },
          { name: "collection", label: "Collection", visible: true, order: 1 },
          { name: "cleaned", label: "Cleaned", visible: true, order: 2 },
        ],
      }),
    }),
  );

  // Rulesets
  await page.route("**/api/rulesets", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ rulesets: [], active_ruleset_id: null }),
    }),
  );
}

export const test = base.extend<{ mockApi: void }>({
  mockApi: [
    async ({ page }, use) => {
      await mockBackendApi(page);
      await use();
    },
    { auto: true },
  ],
});

export { expect } from "@playwright/test";
