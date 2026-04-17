import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createProviderUsageFetch, makeResponse } from "../test-utils/provider-usage-fetch.js";

const resolveProviderUsageSnapshotWithPluginMock = vi.fn();

vi.mock("../config/config.js", () => ({
  loadConfig: () => ({}),
}));

vi.mock("../plugins/provider-runtime.js", async () => {
  const actual = await vi.importActual<typeof import("../plugins/provider-runtime.js")>(
    "../plugins/provider-runtime.js",
  );
  return {
    ...actual,
    resolveProviderUsageSnapshotWithPlugin: (...args: unknown[]) =>
      resolveProviderUsageSnapshotWithPluginMock(...args),
  };
});

let loadProviderUsageSummary: typeof import("./provider-usage.load.js").loadProviderUsageSummary;

const usageNow = Date.UTC(2026, 0, 7, 0, 0, 0);

describe("provider-usage.load plugin boundary", () => {
  beforeAll(async () => {
    ({ loadProviderUsageSummary } = await import("./provider-usage.load.js"));
  });

  beforeEach(() => {
    resolveProviderUsageSnapshotWithPluginMock.mockReset();
    resolveProviderUsageSnapshotWithPluginMock.mockResolvedValue(null);
  });

  it("prefers plugin-owned usage snapshots", async () => {
    resolveProviderUsageSnapshotWithPluginMock.mockResolvedValueOnce({
      provider: "github-copilot",
      displayName: "Copilot",
      windows: [{ label: "Plugin", usedPercent: 11 }],
    });
    const mockFetch = createProviderUsageFetch(async () => {
      throw new Error("legacy fetch should not run");
    });

    await expect(
      loadProviderUsageSummary({
        now: usageNow,
        auth: [{ provider: "github-copilot", token: "copilot-token" }],
        fetch: mockFetch as unknown as typeof fetch,
      }),
    ).resolves.toEqual({
      updatedAt: usageNow,
      providers: [
        {
          provider: "github-copilot",
          displayName: "Copilot",
          windows: [{ label: "Plugin", usedPercent: 11 }],
        },
      ],
    });

    expect(mockFetch).not.toHaveBeenCalled();
    expect(resolveProviderUsageSnapshotWithPluginMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "github-copilot",
        context: expect.objectContaining({
          provider: "github-copilot",
          token: "copilot-token",
          timeoutMs: 5_000,
        }),
      }),
    );
  });

  it("falls back to built-in codex usage fetch when plugin loading fails", async () => {
    resolveProviderUsageSnapshotWithPluginMock.mockRejectedValueOnce(
      Object.assign(new Error("plugin load failed: slack"), {
        name: "PluginLoadFailureError",
      }),
    );
    const mockFetch = createProviderUsageFetch(async (_url, init) => {
      const headers = (init?.headers as Record<string, string> | undefined) ?? {};
      expect(headers["ChatGPT-Account-Id"]).toBe("acct-1");
      return makeResponse(200, {
        rate_limit: {
          primary_window: {
            limit_window_seconds: 10_800,
            used_percent: 21,
            reset_at: 1_700_000_000,
          },
        },
        plan_type: "Team",
      });
    });

    await expect(
      loadProviderUsageSummary({
        now: usageNow,
        auth: [{ provider: "openai-codex", token: "codex-token", accountId: "acct-1" }],
        fetch: mockFetch as unknown as typeof fetch,
      }),
    ).resolves.toEqual({
      updatedAt: usageNow,
      providers: [
        {
          provider: "openai-codex",
          displayName: "Codex",
          windows: [{ label: "3h", usedPercent: 21, resetAt: 1_700_000_000_000 }],
          plan: "Team",
        },
      ],
    });
  });
});
