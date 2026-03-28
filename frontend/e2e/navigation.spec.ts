import { test, expect } from './fixtures';

test.describe('Navigation', () => {
  test('sidebar has link to meta editor', async ({ page }) => {
    await page.goto('/');
    const sidebar = page.locator('aside');
    const metaEditorLink = sidebar.getByRole('link', { name: /Meta Editor/i });
    await expect(metaEditorLink).toBeVisible();
  });

  test('can navigate to meta editor from sidebar', async ({ page }) => {
    await page.goto('/');
    const sidebar = page.locator('aside');
    await sidebar.getByRole('link', { name: /Meta Editor/i }).click();
    await expect(page).toHaveURL(/\/meta-editor/);
  });

  test('sidebar logo links to home', async ({ page }) => {
    await page.goto('/meta-editor');
    const sidebar = page.locator('aside');
    const homeLink = sidebar.getByRole('link', { name: /Starlib/i });
    await homeLink.click();
    await expect(page).toHaveURL('/');
  });
});
