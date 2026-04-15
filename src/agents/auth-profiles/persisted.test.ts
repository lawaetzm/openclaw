import { describe, expect, it } from "vitest";
import { coercePersistedAuthProfileStore } from "./persisted.js";

function makeJwt(payload: Record<string, unknown>): string {
  const encode = (value: Record<string, unknown>) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode(payload)}.`;
}

describe("coercePersistedAuthProfileStore", () => {
  it("infers missing Codex accountId from the OAuth access token", () => {
    const store = coercePersistedAuthProfileStore({
      version: 1,
      profiles: {
        "openai-codex:test": {
          type: "oauth",
          provider: "openai-codex",
          access: makeJwt({
            "https://api.openai.com/auth": {
              chatgpt_account_id: "acct_test_123",
            },
          }),
          refresh: "refresh-token",
          expires: 1,
        },
      },
    });

    expect(store?.profiles["openai-codex:test"]).toMatchObject({
      accountId: "acct_test_123",
    });
  });

  it("keeps an explicit accountId unchanged", () => {
    const store = coercePersistedAuthProfileStore({
      version: 1,
      profiles: {
        "openai-codex:test": {
          type: "oauth",
          provider: "openai-codex",
          access: makeJwt({
            "https://api.openai.com/auth": {
              chatgpt_account_id: "acct_from_token",
            },
          }),
          refresh: "refresh-token",
          expires: 1,
          accountId: "acct_explicit",
        },
      },
    });

    expect(store?.profiles["openai-codex:test"]).toMatchObject({
      accountId: "acct_explicit",
    });
  });
});
