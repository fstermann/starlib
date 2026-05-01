import { expect, test } from "./fixtures";

// #374: a ruleset created in Settings → Rulesets must appear in the
// folder-tree right-click "Ruleset" submenu without reloading the page.
// Before the fix, that menu used a snapshot of `getRulesets()` from mount.
test("new ruleset shows up in folder-tree context menu without reload", async ({
  page,
}) => {
  const store: { id: string; name: string; rules: unknown[] }[] = [];
  await page.route("**/api/rulesets", (route) => {
    if (route.request().method() === "POST") {
      const body = JSON.parse(route.request().postData() || "{}");
      const created = {
        id: "rs-" + (store.length + 1),
        name: body.name,
        is_builtin: false,
        rules: body.rules ?? [],
        required_attributes: [],
      };
      store.push(created);
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(created),
      });
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        rulesets: store,
        active_ruleset_id: store[0]?.id ?? null,
      }),
    });
  });

  await page.goto("/library");
  await page.waitForLoadState("networkidle");

  // Open Settings → Rulesets and create a new ruleset.
  await page.locator('button[aria-label="Settings"]').click();
  await page
    .locator('[data-slot="dialog-content"]')
    .waitFor({ state: "visible" });
  await page.getByText("Rulesets", { exact: true }).click();
  await page.getByText("New ruleset").click();
  // dispatchRulesetsChanged fires synchronously inside handleCreate after the
  // POST resolves — give listeners a tick to run before closing the dialog.
  await page.waitForTimeout(200);

  // Close the dialog so the context menu has nothing on top of it.
  await page.keyboard.press("Escape");
  await page
    .locator('[data-slot="dialog-content"]')
    .waitFor({ state: "hidden" });

  // Right-click the root folder ("music") and hover the Ruleset submenu.
  // The default name from handleCreate is "New Ruleset"; before the fix the
  // tree's allRulesets snapshot was stale and this menuitem wouldn't appear.
  const treeRoot = page.getByRole("button", { name: /music/i }).first();
  await treeRoot.waitFor({ state: "visible" });
  await treeRoot.click({ button: "right" });
  await page.getByRole("menuitem", { name: /^Ruleset$/ }).hover();
  await expect(
    page.getByRole("menuitem", { name: "New Ruleset" }),
  ).toBeVisible();
});
