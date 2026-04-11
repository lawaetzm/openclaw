import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const FINAL_REPLY_TEXT = "final answer";
const THREAD_TS = "thread-1";
const SAME_TEXT = "same reply";

const createSlackDraftStreamMock = vi.fn();
const deliverRepliesMock = vi.fn(async () => {});
const finalizeSlackPreviewEditMock = vi.fn(async () => {});
const draftUpdateMock = vi.fn();
let mockedDispatchSequence: Array<{
  kind: "tool" | "block" | "final";
  payload: { text: string };
}> = [];
let mockedPartialReplies: Array<{ text: string }> = [];

const noop = () => {};
const noopAsync = async () => {};

function createDraftStreamStub() {
  return {
    update: draftUpdateMock,
    flush: noopAsync,
    clear: noopAsync,
    stop: noop,
    forceNewMessage: noop,
    messageId: () => "171234.567",
    channelId: () => "C123",
  };
}

function createPreparedSlackMessage() {
  return {
    ctx: {
      cfg: {},
      runtime: {},
      botToken: "xoxb-test",
      app: { client: {} },
      teamId: "T1",
      textLimit: 4000,
      typingReaction: "",
      removeAckAfterReply: false,
      historyLimit: 0,
      channelHistories: new Map(),
      allowFrom: [],
      setSlackThreadStatus: async () => undefined,
    },
    account: {
      accountId: "default",
      config: {},
    },
    message: {
      channel: "C123",
      ts: "171234.111",
      thread_ts: THREAD_TS,
      user: "U123",
    },
    route: {
      agentId: "agent-1",
      accountId: "default",
      mainSessionKey: "main",
    },
    channelConfig: null,
    replyTarget: "channel:C123",
    ctxPayload: {
      MessageThreadId: THREAD_TS,
    },
    replyToMode: "all",
    isDirectMessage: false,
    isRoomish: false,
    historyKey: "history-key",
    preview: "",
    ackReactionValue: "eyes",
    ackReactionPromise: null,
  } as never;
}

vi.mock("openclaw/plugin-sdk/agent-runtime", () => ({
  resolveHumanDelayConfig: () => undefined,
}));

vi.mock("openclaw/plugin-sdk/channel-feedback", () => ({
  DEFAULT_TIMING: {
    doneHoldMs: 0,
    errorHoldMs: 0,
  },
  createStatusReactionController: () => ({
    setQueued: async () => {},
    setThinking: async () => {},
    setTool: async () => {},
    setError: async () => {},
    setDone: async () => {},
    clear: async () => {},
    restoreInitial: async () => {},
  }),
  logAckFailure: () => {},
  logTypingFailure: () => {},
  removeAckReactionAfterReply: () => {},
}));

vi.mock("openclaw/plugin-sdk/channel-reply-pipeline", () => ({
  createChannelReplyPipeline: () => ({
    typingCallbacks: {
      onIdle: vi.fn(),
    },
    onModelSelected: undefined,
  }),
}));

vi.mock("openclaw/plugin-sdk/channel-streaming", () => ({
  resolveChannelStreamingBlockEnabled: () => false,
  resolveChannelStreamingNativeTransport: () => false,
}));

vi.mock("openclaw/plugin-sdk/outbound-runtime", () => ({
  resolveAgentOutboundIdentity: () => undefined,
}));

vi.mock("openclaw/plugin-sdk/reply-history", () => ({
  clearHistoryEntriesIfEnabled: () => {},
}));

vi.mock("openclaw/plugin-sdk/reply-payload", () => ({
  resolveSendableOutboundReplyParts: (
    payload: { text?: string; mediaUrl?: string; mediaUrls?: string[] },
    opts?: { text?: string },
  ) => {
    const text = (opts?.text ?? payload.text ?? "").trim();
    const mediaUrls = payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []);
    return {
      text,
      trimmedText: text,
      hasText: text.length > 0,
      hasMedia: mediaUrls.length > 0,
      mediaUrls,
      hasContent: text.length > 0 || mediaUrls.length > 0,
    };
  },
}));

vi.mock("openclaw/plugin-sdk/runtime-env", () => ({
  danger: (message: string) => message,
  logVerbose: () => {},
  shouldLogVerbose: () => false,
}));

vi.mock("openclaw/plugin-sdk/security-runtime", () => ({
  resolvePinnedMainDmOwnerFromAllowlist: () => undefined,
}));

vi.mock("openclaw/plugin-sdk/text-runtime", () => ({
  normalizeOptionalLowercaseString: (value?: string) => value?.toLowerCase(),
}));

vi.mock("../../actions.js", () => ({
  reactSlackMessage: async () => {},
  removeSlackReaction: async () => {},
}));

vi.mock("../../draft-stream.js", () => ({
  createSlackDraftStream: createSlackDraftStreamMock,
}));

vi.mock("../../format.js", () => ({
  normalizeSlackOutboundText: (value: string) => value.trim(),
}));

vi.mock("../../limits.js", () => ({
  SLACK_TEXT_LIMIT: 4000,
}));

vi.mock("../../sent-thread-cache.js", () => ({
  recordSlackThreadParticipation: () => {},
}));

vi.mock("../../stream-mode.js", () => ({
  applyAppendOnlyStreamUpdate: ({ incoming }: { incoming: string }) => ({
    changed: true,
    rendered: incoming,
    source: incoming,
  }),
  buildStatusFinalPreviewText: () => "status",
  resolveSlackStreamingConfig: () => ({
    mode: "partial",
    nativeStreaming: false,
    draftMode: "append",
  }),
}));

vi.mock("../../streaming.js", () => ({
  appendSlackStream: async () => {},
  startSlackStream: async () => ({
    threadTs: THREAD_TS,
    stopped: false,
  }),
  stopSlackStream: async () => {},
}));

vi.mock("../../threading.js", () => ({
  resolveSlackThreadTargets: () => ({
    statusThreadTs: THREAD_TS,
    isThreadReply: true,
  }),
}));

vi.mock("../allow-list.js", () => ({
  normalizeSlackAllowOwnerEntry: (value: string) => value,
}));

vi.mock("../config.runtime.js", () => ({
  resolveStorePath: () => "/tmp/openclaw-store.json",
  updateLastRoute: async () => {},
}));

vi.mock("../replies.js", () => ({
  createSlackReplyDeliveryPlan: () => ({
    nextThreadTs: () => THREAD_TS,
    markSent: () => {},
  }),
  deliverReplies: deliverRepliesMock,
  readSlackReplyBlocks: () => undefined,
  resolveSlackThreadTs: () => THREAD_TS,
}));

vi.mock("../reply.runtime.js", () => ({
  createReplyDispatcherWithTyping: (params: {
    deliver: (payload: unknown, info: { kind: "tool" | "block" | "final" }) => Promise<void>;
    onPartialReply?: (payload: { text?: string }) => Promise<void>;
  }) => ({
    dispatcher: {
      deliver: params.deliver,
    },
    replyOptions: {},
    markDispatchIdle: () => {},
  }),
  dispatchInboundMessage: async (params: {
    dispatcher: {
      deliver: (
        payload: { text: string },
        info: { kind: "tool" | "block" | "final" },
      ) => Promise<void>;
    };
    replyOptions?: {
      onPartialReply?: (payload: { text?: string }) => Promise<void>;
    };
  }) => {
    for (const entry of mockedPartialReplies) {
      await params.replyOptions?.onPartialReply?.(entry);
    }
    for (const entry of mockedDispatchSequence) {
      await params.dispatcher.deliver(entry.payload, { kind: entry.kind });
    }
    return {
      queuedFinal: false,
      counts: {
        final: mockedDispatchSequence.filter((entry) => entry.kind === "final").length,
      },
    };
  },
}));

vi.mock("./preview-finalize.js", () => ({
  finalizeSlackPreviewEdit: finalizeSlackPreviewEditMock,
}));

let dispatchPreparedSlackMessage: typeof import("./dispatch.js").dispatchPreparedSlackMessage;

describe("dispatchPreparedSlackMessage preview fallback", () => {
  beforeAll(async () => {
    ({ dispatchPreparedSlackMessage } = await import("./dispatch.js"));
  });

  beforeEach(() => {
    createSlackDraftStreamMock.mockReset();
    deliverRepliesMock.mockReset();
    finalizeSlackPreviewEditMock.mockReset();
    draftUpdateMock.mockReset();
    mockedDispatchSequence = [{ kind: "final", payload: { text: FINAL_REPLY_TEXT } }];
    mockedPartialReplies = [];

    createSlackDraftStreamMock.mockReturnValue(createDraftStreamStub());
    finalizeSlackPreviewEditMock.mockRejectedValue(new Error("socket closed"));
  });

  it("falls back to normal delivery when preview finalize fails", async () => {
    await dispatchPreparedSlackMessage(createPreparedSlackMessage());

    expect(finalizeSlackPreviewEditMock).toHaveBeenCalledTimes(1);
    expect(deliverRepliesMock).toHaveBeenCalledTimes(1);
    expect(deliverRepliesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        replyThreadTs: THREAD_TS,
        replies: [expect.objectContaining({ text: FINAL_REPLY_TEXT })],
      }),
    );
  });

  it("keeps same-content tool and final payloads distinct after preview fallback", async () => {
    mockedDispatchSequence = [
      { kind: "tool", payload: { text: SAME_TEXT } },
      { kind: "final", payload: { text: SAME_TEXT } },
    ];

    await dispatchPreparedSlackMessage(createPreparedSlackMessage());

    expect(finalizeSlackPreviewEditMock).toHaveBeenCalledTimes(2);
    expect(deliverRepliesMock).toHaveBeenCalledTimes(2);
    expect(deliverRepliesMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        replyThreadTs: THREAD_TS,
        replies: [expect.objectContaining({ text: SAME_TEXT })],
      }),
    );
    expect(deliverRepliesMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        replyThreadTs: THREAD_TS,
        replies: [expect.objectContaining({ text: SAME_TEXT })],
      }),
    );
  });

  it("does not stream internal orchestration markers into the Slack preview draft", async () => {
    mockedPartialReplies = [
      {
        text: [
          "OpenClaw runtime context (internal):",
          "[Internal task completion event]",
          "session_key: agent:main:subagent:test",
        ].join("\n"),
      },
      { text: "Visible progress update" },
    ];

    await dispatchPreparedSlackMessage(createPreparedSlackMessage());

    expect(draftUpdateMock).toHaveBeenCalledTimes(1);
    expect(draftUpdateMock).toHaveBeenCalledWith("Visible progress update");
  });
});
