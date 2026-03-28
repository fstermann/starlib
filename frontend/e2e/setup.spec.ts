import { test, expect } from './fixtures';

test.describe('Setup page', () => {
  test('shows setup form with required fields', async ({ page }) => {
    await page.goto('/setup');
    await expect(page.getByRole('heading', { name: /Welcome to SoundCloud Tools/i })).toBeVisible();
    await expect(page.getByLabel(/Client ID/i)).toBeVisible();
    await expect(page.getByLabel(/Client Secret/i)).toBeVisible();
    await expect(page.getByLabel(/Music folder/i)).toBeVisible();
    await expect(page.getByRole('button', { name: /Save and get started/i })).toBeVisible();
  });

  test('music folder has default value', async ({ page }) => {
    await page.goto('/setup');
    await expect(page.getByLabel(/Music folder/i)).toHaveValue('~/Music/tracks');
  });

  test('submit button triggers API call with form data', async ({ page }) => {
    // Override the setup save route to capture the request
    const savePromise = page.waitForRequest('**/api/setup');

    await page.route('**/api/setup', (route) => {
      if (route.request().method() === 'POST') {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ success: true }),
        });
      }
      return route.continue();
    });

    await page.goto('/setup');
    await page.getByLabel(/Client ID/i).fill('test-client-id');
    await page.getByLabel(/Client Secret/i).fill('test-client-secret');
    await page.getByRole('button', { name: /Save and get started/i }).click();

    const request = await savePromise;
    const body = request.postDataJSON();
    expect(body.client_id).toBe('test-client-id');
    expect(body.client_secret).toBe('test-client-secret');
    expect(body.root_music_folder).toBe('~/Music/tracks');
  });
});
