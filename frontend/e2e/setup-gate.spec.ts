import { test, expect } from './fixtures';

test.describe('Setup gate', () => {
  test('redirects to /setup when backend reports not configured', async ({ page }) => {
    // Override the default mock to return not-configured
    await page.route('**/api/setup/status', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ configured: false }),
      }),
    );

    await page.goto('/');
    await expect(page).toHaveURL(/\/setup/, { timeout: 5000 });
  });

  test('does not redirect when backend is configured', async ({ page }) => {
    // Default mock already returns configured: true
    await page.goto('/');
    await expect(page).toHaveURL('/');
    await expect(page.getByRole('heading', { name: 'Starlib' })).toBeVisible();
  });
});
