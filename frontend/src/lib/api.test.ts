import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// api.getAppSettings / api.updateAppSettings
// ---------------------------------------------------------------------------
import { api, ApiError, fetchApi } from "@/lib/api";

// ---------------------------------------------------------------------------
// fetchApi
// ---------------------------------------------------------------------------

function mockFetch(
  status: number,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  const responseHeaders = new Headers(headers);
  const response = new Response(
    body !== undefined ? JSON.stringify(body) : null,
    {
      status,
      headers: responseHeaders,
    },
  );
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("fetchApi", () => {
  it("returns parsed JSON on success", async () => {
    mockFetch(200, { id: "classic", name: "Classic" });
    const result = await fetchApi<{ id: string; name: string }>(
      "/api/rulesets/active",
    );
    expect(result).toEqual({ id: "classic", name: "Classic" });
  });

  it("returns undefined on 204 No Content", async () => {
    mockFetch(204);
    const result = await fetchApi("/api/rulesets/some-id");
    expect(result).toBeUndefined();
  });

  it("returns undefined when content-length is 0", async () => {
    mockFetch(200, null, { "content-length": "0" });
    const result = await fetchApi("/api/something");
    expect(result).toBeUndefined();
  });

  it("throws ApiError on non-2xx response", async () => {
    mockFetch(404, { detail: "Ruleset not found" });
    await expect(fetchApi("/api/rulesets/ghost")).rejects.toThrow(ApiError);
  });

  it("ApiError carries the status code", async () => {
    mockFetch(403, { detail: "Cannot modify built-in rulesets" });
    try {
      await fetchApi("/api/rulesets/classic");
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).status).toBe(403);
    }
  });

  it("ApiError falls back to generic message when detail is missing", async () => {
    mockFetch(500, {});
    await expect(fetchApi("/api/rulesets")).rejects.toThrow("HTTP 500");
  });
});

describe("api.getAppSettings", () => {
  it("calls GET /api/settings", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ preferred_output_format: "aiff" }), {
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const result = await api.getAppSettings();
    expect(result.preferred_output_format).toBe("aiff");
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining("/api/settings"),
      expect.any(Object),
    );
  });
});

describe("api.updateAppSettings", () => {
  it("calls PUT /api/settings with body", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ preferred_output_format: "mp3" }), {
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const result = await api.updateAppSettings({
      preferred_output_format: "mp3",
    });
    expect(result.preferred_output_format).toBe("mp3");

    const [, options] = fetchSpy.mock.calls[0];
    expect(options.method).toBe("PUT");
    expect(JSON.parse(options.body)).toEqual({
      preferred_output_format: "mp3",
    });
  });
});

// ---------------------------------------------------------------------------
// api — ruleset methods
// ---------------------------------------------------------------------------

describe("api.getRulesets", () => {
  it("returns rulesets response", async () => {
    const payload = {
      rulesets: [
        { id: "classic", name: "Classic", is_builtin: true, rules: [] },
      ],
      active_ruleset_id: "classic",
    };
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify(payload), { status: 200 }),
        ),
    );

    const result = await api.getRulesets();
    expect(result.rulesets).toHaveLength(1);
    expect(result.active_ruleset_id).toBe("classic");
  });
});

describe("api.createRuleset", () => {
  it("sends POST with name and rules", async () => {
    const created = {
      id: "new-id",
      name: "My Workflow",
      is_builtin: false,
      rules: [],
    };
    const fetchSpy = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify(created), { status: 201 }),
      );
    vi.stubGlobal("fetch", fetchSpy);

    const result = await api.createRuleset({ name: "My Workflow", rules: [] });
    expect(result.id).toBe("new-id");
    const [, options] = fetchSpy.mock.calls[0];
    expect(options.method).toBe("POST");
  });
});

describe("api.deleteRuleset", () => {
  it("sends DELETE and resolves on 204", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status: 204 })),
    );
    await expect(api.deleteRuleset("some-id")).resolves.toBeUndefined();
  });
});
