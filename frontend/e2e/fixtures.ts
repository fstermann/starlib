import { test as base, type Page } from '@playwright/test';

/**
 * Intercept backend API calls so tests run without a real backend.
 */
async function mockBackendApi(page: Page) {
  // Setup status — report as configured so SetupGate doesn't redirect.
  await page.route('**/api/setup/status', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ configured: true }),
    }),
  );

  // Health check
  await page.route('**/health', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ status: 'ok' }),
    }),
  );

  // Folder initialization
  await page.route('**/api/metadata/folders/initialize', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, message: 'Folders initialized' }),
    }),
  );

  // File listing for any folder mode
  await page.route('**/api/metadata/folders/*/files*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ items: [], total: 0, page: 1, size: 50, pages: 0 }),
    }),
  );

  // Browse endpoint
  await page.route('**/api/metadata/folders/*/browse*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ items: [], total: 0, page: 1, size: 50, pages: 0 }),
    }),
  );

  // Filter values
  await page.route('**/api/metadata/folders/*/filters*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ genres: [], keys: [], bpm_min: null, bpm_max: null }),
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

export { expect } from '@playwright/test';
