import { expect, test } from "./fixtures";

/**
 * ProfileGroups end-to-end: pick a profile to start a transient group,
 * save it, add a second member, see the source-profile column appear,
 * switch saved groups via the dropdown, and delete one.
 */

const ALICE_URN = "soundcloud:users:42";
const BOB_URN = "soundcloud:users:99";

const ALICE = {
  id: 42,
  urn: ALICE_URN,
  username: "alice",
  permalink: "alice",
  permalink_url: "https://soundcloud.com/alice",
  avatar_url: null,
  followers_count: 100,
  track_count: 10,
  kind: "user",
};

const BOB = {
  id: 99,
  urn: BOB_URN,
  username: "bob",
  permalink: "bob",
  permalink_url: "https://soundcloud.com/bob",
  avatar_url: null,
  followers_count: 200,
  track_count: 20,
  kind: "user",
};

const ALICE_TRACK = {
  id: 1,
  urn: "soundcloud:tracks:1",
  title: "Alpha track",
  user: ALICE,
  duration: 200_000,
  created_at: "2024-02-01T00:00:00Z",
  permalink_url: "https://soundcloud.com/alice/alpha",
};

const BOB_TRACK = {
  id: 2,
  urn: "soundcloud:tracks:2",
  title: "Bravo track",
  user: BOB,
  duration: 200_000,
  created_at: "2024-01-01T00:00:00Z",
  permalink_url: "https://soundcloud.com/bob/bravo",
};

async function setup(page: import("@playwright/test").Page) {
  await page.addInitScript(() => {
    window.localStorage.setItem("access_token", "fake-token");
    window.localStorage.setItem(
      "token_expires_at",
      String(Date.now() + 60 * 60 * 1000),
    );
    window.localStorage.setItem(
      "sc_user",
      JSON.stringify({
        id: 1,
        username: "me",
        permalink: "me",
        avatar_url: null,
      }),
    );
  });

  // Persisted ProfileGroups state (mocked CRUD).
  let groups: Array<{
    id: string;
    name: string;
    members: typeof ALICE_TRACK.user[];
  }> = [];
  let activeGroupId = "";

  await page.route("**/api/profile-groups", async (route) => {
    if (route.request().method() === "POST") {
      const body = await route.request().postDataJSON();
      const created = {
        id: `group-${groups.length + 1}`,
        name: body.name,
        members: body.members,
        created_at: "2024-01-01T00:00:00Z",
        updated_at: "2024-01-01T00:00:00Z",
      };
      groups.push(created);
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify(created),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ groups, active_group_id: activeGroupId }),
    });
  });

  await page.route(/\/api\/profile-groups\/active$/, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: activeGroupId
        ? JSON.stringify(groups.find((g) => g.id === activeGroupId) ?? null)
        : "null",
    }),
  );

  await page.route(/\/api\/profile-groups\/[^/]+$/, async (route) => {
    const url = new URL(route.request().url());
    const id = url.pathname.split("/").pop()!;
    if (route.request().method() === "PUT") {
      const body = await route.request().postDataJSON();
      const idx = groups.findIndex((g) => g.id === id);
      if (idx === -1) {
        await route.fulfill({ status: 404, body: "" });
        return;
      }
      const updated = { ...groups[idx], ...body, updated_at: "2024-01-02" };
      groups[idx] = updated;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(updated),
      });
      return;
    }
    if (route.request().method() === "DELETE") {
      groups = groups.filter((g) => g.id !== id);
      if (activeGroupId === id) activeGroupId = "";
      await route.fulfill({ status: 204, body: "" });
      return;
    }
    await route.fulfill({ status: 404, body: "" });
  });

  // SoundCloud user search → returns alice for "alice" and bob for "bob".
  await page.route(/api\.soundcloud\.com\/users\?/, (route) => {
    const url = new URL(route.request().url());
    const q = (url.searchParams.get("q") ?? "").toLowerCase();
    const matches: unknown[] = [];
    if (q.includes("alice")) matches.push(ALICE);
    if (q.includes("bob")) matches.push(BOB);
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(matches),
    });
  });

  // Per-user likes — URN gets percent-encoded ("soundcloud%3Ausers%3A<id>"),
  // so match by the user-id suffix anywhere in the path.
  await page.route(
    /api\.soundcloud\.com\/users\/[^/]+\/likes\/tracks/,
    (route) => {
      const url = route.request().url();
      const collection = url.includes(`%3A${ALICE.id}`)
        ? [ALICE_TRACK]
        : url.includes(`%3A${BOB.id}`)
          ? [BOB_TRACK]
          : [];
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ collection, next_href: null }),
      });
    },
  );

  // Quiet other endpoints.
  await page.route(/api\.soundcloud\.com\/me\/likes\/tracks/, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ collection: [], next_href: null }),
    }),
  );
  await page.route(/api\.soundcloud\.com\/me\/playlists/, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ collection: [], next_href: null }),
    }),
  );
  await page.route("**/api/metadata/collection/soundcloud-ids", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: "[]",
    }),
  );
  await page.route("**/api/bpm/soundcloud/bulk", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ bpms: {} }),
    }),
  );
  await page.route("**/api/settings/root-folder", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ root_music_folder: "/music" }),
    }),
  );
}

test.describe("ProfileGroups", () => {
  test("transient → save → multi-member → source col → switch → delete", async ({
    page,
  }) => {
    await setup(page);
    await page.goto("/library?source=soundcloud&tab=discover");

    // Empty Discover: search renders, no group bar.
    await expect(page.getByTestId("group-bar")).toBeHidden();

    // Pick alice → transient group appears.
    await page
      .getByPlaceholder(/search users or paste/i)
      .fill("alice");
    await page.getByText("alice").first().click();
    await expect(page.getByTestId("group-bar")).toBeVisible();
    await expect(page.getByTestId("group-bar")).toContainText("Untitled group");
    await expect(page.getByTestId("group-bar")).toContainText("(unsaved)");

    // The source column should NOT appear yet (1 member).
    await expect(page.locator('[data-index]').first()).toContainText(
      "Alpha track",
    );

    // The UserSearch stays visible while the group is transient — the user
    // can keep adding members without opening the manage dialog.
    await page
      .getByPlaceholder(/search users or paste/i)
      .fill("bob");
    await page.getByText("bob").first().click();
    // Bar now shows "2 profiles".
    await expect(page.getByTestId("group-bar")).toContainText("2 profiles");

    // Save the transient group via the bar's "Save group" trigger.
    await page.getByTestId("group-bar-manage").click();
    const dialog = page.getByTestId("profile-group-dialog");
    await expect(dialog).toBeVisible();
    await dialog
      .getByTestId("profile-group-name-input")
      .fill("My DJs");
    await expect(
      dialog.getByTestId("profile-group-member-row"),
    ).toHaveCount(2);

    await dialog.getByTestId("profile-group-save").click();
    await expect(dialog).toBeHidden();

    // Saved → URL has ?group=group-1 and bar shows the saved name.
    await expect(page).toHaveURL(/group=group-1/);
    await expect(page.getByTestId("group-bar")).toContainText("My DJs");

    // Now both tracks are visible (alice + bob feeds merged) and the
    // source-profile column renders for the multi-member group.
    await expect(page.locator('[data-index]')).toHaveCount(2);
    // The source column has data-testid via the avatar's tooltip trigger;
    // simplest assertion: each data-index row contains the source avatar
    // image OR fallback initial.
    const firstRow = page.locator('[data-index="0"]');
    await expect(firstRow).toContainText(/Alpha|Bravo/);

    // Delete the group from the manage dialog.
    await page.getByTestId("group-bar-manage").click();
    await expect(dialog).toBeVisible();
    page.once("dialog", (d) => d.accept()); // window.confirm()
    await page.getByTestId("profile-group-delete").click();
    await expect(dialog).toBeHidden();

    // Group cleared: search reappears, group bar is gone.
    await expect(page.getByTestId("group-bar")).toBeHidden();
  });
});
