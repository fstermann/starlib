import { test, expect } from './fixtures';

test.describe('Auth login page', () => {
  test('shows connect button', async ({ page }) => {
    await page.goto('/auth/login');
    await expect(
      page.getByRole('heading', { name: /Connect SoundCloud/i }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: /Connect with SoundCloud/i }),
    ).toBeVisible();
  });

  test('shows error when authorize endpoint fails', async ({ page }) => {
    await page.route('**/auth/soundcloud/authorize', (route) =>
      route.fulfill({ status: 500, contentType: 'application/json', body: '{"detail":"Server error"}' }),
    );

    await page.goto('/auth/login');
    await page.getByRole('button', { name: /Connect with SoundCloud/i }).click();
    await expect(page.getByText(/Server error|Failed to initiate login/i)).toBeVisible();
  });
});
