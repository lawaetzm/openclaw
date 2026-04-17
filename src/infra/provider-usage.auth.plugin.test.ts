import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const resolveProviderUsageAuthWithPluginMock = vi.fn(
  async (..._args: unknown[]): Promise<unknown> => null,
);
const ensureAuthProfileStoreMock = vi.fn(() => ({
  profiles: {},
}));
const listProfilesForProviderMock = vi.fn(() => [] as string[]);
const resolveApiKeyForProfileMock = vi.fn(async () => null as unknown);
const resolveAuthProfileOrderMock = vi.fn(() => [] as string[]);

vi.mock("../agents/auth-profiles.js", () => ({
  dedupeProfileIds: (profileIds: string[]) => [...new Set(profileIds)],
  ensureAuthProfileStore: () => ensureAuthProfileStoreMock(),
  listProfilesForProvider: listProfilesForProviderMock,
  resolveApiKeyForProfile: resolveApiKeyForProfileMock,
  resolveAuthProfileOrder: resolveAuthProfileOrderMock,
}));

vi.mock("../plugins/provider-runtime.js", async () => {
  const actual = await vi.importActual<typeof import("../plugins/provider-runtime.js")>(
    "../plugins/provider-runtime.js",
  );
  return {
    ...actual,
    resolveProviderUsageAuthWithPlugin: resolveProviderUsageAuthWithPluginMock,
  };
});

let resolveProviderAuths: typeof import("./provider-usage.auth.js").resolveProviderAuths;

describe("resolveProviderAuths plugin boundary", () => {
  beforeAll(async () => {
    ({ resolveProviderAuths } = await import("./provider-usage.auth.js"));
  });

  beforeEach(() => {
    ensureAuthProfileStoreMock.mockClear();
    resolveProviderUsageAuthWithPluginMock.mockReset();
    resolveProviderUsageAuthWithPluginMock.mockResolvedValue(null);
    listProfilesForProviderMock.mockReset();
    listProfilesForProviderMock.mockReturnValue([]);
    resolveApiKeyForProfileMock.mockReset();
    resolveApiKeyForProfileMock.mockResolvedValue(null);
    resolveAuthProfileOrderMock.mockReset();
    resolveAuthProfileOrderMock.mockReturnValue([]);
  });

  it("prefers plugin-owned usage auth when available", async () => {
    resolveProviderUsageAuthWithPluginMock.mockResolvedValueOnce({
      token: "plugin-zai-token",
    });

    await expect(
      resolveProviderAuths({
        providers: ["zai"],
      }),
    ).resolves.toEqual([
      {
        provider: "zai",
        token: "plugin-zai-token",
      },
    ]);
    expect(ensureAuthProfileStoreMock).not.toHaveBeenCalled();
  });

  it("falls back to store auth when plugin loading fails", async () => {
    ensureAuthProfileStoreMock.mockReturnValueOnce({
      profiles: {
        "openai-codex:default": {
          type: "oauth",
          provider: "openai-codex",
          accountId: "acct-1",
        },
      },
    });
    resolveProviderUsageAuthWithPluginMock.mockRejectedValueOnce(
      Object.assign(new Error("plugin load failed: slack"), {
        name: "PluginLoadFailureError",
      }),
    );
    resolveAuthProfileOrderMock.mockReturnValueOnce(["openai-codex:default"]);
    listProfilesForProviderMock.mockReturnValueOnce(["openai-codex:default"]);
    resolveApiKeyForProfileMock.mockResolvedValueOnce({ apiKey: "oauth-token" });

    await expect(
      resolveProviderAuths({
        providers: ["openai-codex"],
      }),
    ).resolves.toEqual([
      {
        provider: "openai-codex",
        token: "oauth-token",
        accountId: "acct-1",
      },
    ]);
  });
});
