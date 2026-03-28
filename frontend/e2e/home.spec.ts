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

  test('displays coming soon tools as disabled', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByText('Like Explorer')).toBeVisible();
    await expect(page.getByText('Artist Manager')).toBeVisible();
    // Coming-soon cards should not be links
    await expect(page.getByRole('link', { name: /Like Explorer/i })).toHaveCount(0);
    await expect(page.getByRole('link', { name: /Artist Manager/i })).toHaveCount(0);
  });

  test('navigates to meta editor when clicking the card', async ({ page }) => {
    await page.goto('/');
    const main = page.locator('main');
    await main.getByRole('link', { name: /Meta Editor/i }).click();
    await expect(page).toHaveURL(/\/meta-editor/);
  });
});
