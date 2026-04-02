import { test, expect } from './fixtures';

test.describe('Home page', () => {
  test('shows application title and tool cards', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Starlib' })).toBeVisible();
    await expect(page.getByText('Music management for DJs and producers.')).toBeVisible();
  });

  test('displays Meta Editor card as available', async ({ page }) => {
    await page.goto('/');
    const main = page.locator('main');
    const card = main.getByRole('link', { name: /Meta Editor/i });
    await expect(card).toBeVisible();
    await expect(card).toHaveAttribute('href', '/meta-editor');
  });

  test('displays Like Explorer card as available', async ({ page }) => {
    await page.goto('/');
    const main = page.locator('main');
    const card = main.getByRole('link', { name: /Like Explorer/i });
    await expect(card).toBeVisible();
    await expect(card).toHaveAttribute('href', '/like-explorer');
  });

  test('displays Weekly Favorites card as available', async ({ page }) => {
    await page.goto('/');
    const main = page.locator('main');
    const card = main.getByRole('link', { name: /Weekly Favorites/i });
    await expect(card).toBeVisible();
    await expect(card).toHaveAttribute('href', '/weekly');
  });

  test('navigates to meta editor when clicking the card', async ({ page }) => {
    await page.goto('/');
    const main = page.locator('main');
    await main.getByRole('link', { name: /Meta Editor/i }).click();
    await expect(page).toHaveURL(/\/meta-editor/);
  });
});
