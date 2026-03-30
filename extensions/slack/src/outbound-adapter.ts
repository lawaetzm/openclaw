import {
  attachChannelToResult,
  type ChannelOutboundAdapter,
  createAttachedChannelResultAdapter,
} from "openclaw/plugin-sdk/channel-send-result";
import {
  resolveInteractiveTextFallback,
  type InteractiveReply,
  type MessagePresentation,
} from "openclaw/plugin-sdk/interactive-runtime";
import type { OutboundIdentity } from "openclaw/plugin-sdk/outbound-runtime";
import { resolveOutboundSendDep } from "openclaw/plugin-sdk/outbound-send-deps";
import {
  resolvePayloadMediaUrls,
  sendPayloadMediaSequenceAndFinalize,
  sendTextMediaPayload,
} from "openclaw/plugin-sdk/reply-payload";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import { parseSlackBlocksInput } from "./blocks-input.js";
import {
  buildSlackInteractiveBlocks,
  buildSlackPresentationBlocks,
  type SlackBlock,
} from "./blocks-render.js";
import { compileSlackInteractiveReplies } from "./interactive-replies.js";
import { SLACK_TEXT_LIMIT } from "./limits.js";
import type { SlackSendIdentity } from "./send.js";
import { resolveSlackThreadTsValue } from "./thread-ts.js";

const SLACK_MAX_BLOCKS = 50;
type SlackSendFn = typeof import("./send.runtime.js").sendMessageSlack;

let slackSendRuntimePromise: Promise<typeof import("./send.runtime.js")> | undefined;

async function loadSlackSendRuntime() {
  slackSendRuntimePromise ??= import("./send.runtime.js");
  return await slackSendRuntimePromise;
}

function hasExecApprovalMetadata(channelData?: Record<string, unknown>): boolean {
  const execApproval = channelData?.execApproval;
  return Boolean(execApproval && typeof execApproval === "object" && !Array.isArray(execApproval));
}

function resolveSlackPayloadText(payload: {
  text?: string;
  interactive?: InteractiveReply;
  channelData?: Record<string, unknown>;
}): string {
  if (payload.interactive && hasExecApprovalMetadata(payload.channelData)) {
    return "Approval required. Use the buttons below.";
  }
  return (
    resolveInteractiveTextFallback({
      text: payload.text,
      interactive: payload.interactive,
    }) ?? ""
  );
}

function resolveRenderedInteractiveBlocks(
  interactive?: InteractiveReply,
): SlackBlock[] | undefined {
  if (!interactive) {
    return undefined;
  }
  const blocks = buildSlackInteractiveBlocks(interactive);
  return blocks.length > 0 ? blocks : undefined;
}

function resolveSlackSendIdentity(identity?: OutboundIdentity): SlackSendIdentity | undefined {
  if (!identity) {
    return undefined;
  }
  const username = normalizeOptionalString(identity.name);
  const iconUrl = normalizeOptionalString(identity.avatarUrl);
  const rawEmoji = normalizeOptionalString(identity.emoji);
  const iconEmoji = !iconUrl && rawEmoji && /^:[^:\s]+:$/.test(rawEmoji) ? rawEmoji : undefined;
  if (!username && !iconUrl && !iconEmoji) {
    return undefined;
  }
  return { username, iconUrl, iconEmoji };
}

async function sendSlackOutboundMessage(params: {
  cfg: NonNullable<NonNullable<Parameters<SlackSendFn>[2]>["cfg"]>;
  to: string;
  text: string;
  mediaUrl?: string;
  mediaAccess?: {
    localRoots?: readonly string[];
    readFile?: (filePath: string) => Promise<Buffer>;
  };
  mediaLocalRoots?: readonly string[];
  mediaReadFile?: (filePath: string) => Promise<Buffer>;
  blocks?: NonNullable<Parameters<SlackSendFn>[2]>["blocks"];
  accountId?: string | null;
  deps?: { [channelId: string]: unknown } | null;
  replyToId?: string | null;
  threadId?: string | number | null;
  identity?: OutboundIdentity;
}) {
  const send =
    resolveOutboundSendDep<SlackSendFn>(params.deps, "slack") ??
    (await loadSlackSendRuntime()).sendMessageSlack;
  const slackIdentity = resolveSlackSendIdentity(params.identity);
  const threadTs = resolveSlackThreadTsValue({
    replyToId: params.replyToId,
    threadId: params.threadId,
  });
  const result = await send(params.to, params.text, {
    cfg: params.cfg,
    threadTs,
    accountId: params.accountId ?? undefined,
    ...(params.mediaUrl
      ? {
          mediaUrl: params.mediaUrl,
          mediaAccess: params.mediaAccess,
          mediaLocalRoots: params.mediaLocalRoots,
          mediaReadFile: params.mediaReadFile,
        }
      : {}),
    ...(params.blocks ? { blocks: params.blocks } : {}),
    ...(slackIdentity ? { identity: slackIdentity } : {}),
  });
  return result;
}

function resolveSlackBlocks(payload: {
  channelData?: Record<string, unknown>;
  interactive?: InteractiveReply;
  presentation?: MessagePresentation;
}) {
  const slackData = payload.channelData?.slack as
    | { blocks?: unknown; presentationBlocks?: SlackBlock[] }
    | undefined;
  const nativeBlocks = parseSlackBlocksInput(slackData?.blocks) as SlackBlock[] | undefined;
  const renderedPresentation =
    slackData?.presentationBlocks ?? buildSlackPresentationBlocks(payload.presentation);
  const renderedInteractive = resolveRenderedInteractiveBlocks(payload.interactive);
  const mergedBlocks = [
    ...(nativeBlocks ?? []),
    ...renderedPresentation,
    ...(renderedInteractive ?? []),
  ];
  if (mergedBlocks.length === 0) {
    return undefined;
  }
  if (mergedBlocks.length > SLACK_MAX_BLOCKS) {
    throw new Error(
      `Slack blocks cannot exceed ${SLACK_MAX_BLOCKS} items after interactive render`,
    );
  }
  return mergedBlocks;
}

export const slackOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  chunker: null,
  textChunkLimit: SLACK_TEXT_LIMIT,
  normalizePayload: ({ payload }) => compileSlackInteractiveReplies(payload),
  presentationCapabilities: {
    supported: true,
    buttons: true,
    selects: true,
    context: true,
    divider: true,
  },
  renderPresentation: ({ payload, presentation }) => ({
    ...payload,
    channelData: {
      ...payload.channelData,
      slack: {
        ...(payload.channelData?.slack as Record<string, unknown> | undefined),
        presentationBlocks: buildSlackPresentationBlocks(presentation),
      },
    },
  }),
  sendPayload: async (ctx) => {
    const payload = {
      ...ctx.payload,
      text: resolveSlackPayloadText(ctx.payload),
    };
    const blocks = resolveSlackBlocks(payload);
    if (!blocks) {
      return await sendTextMediaPayload({
        channel: "slack",
        ctx: {
          ...ctx,
          payload,
        },
        adapter: slackOutbound,
      });
    }
    const mediaUrls = resolvePayloadMediaUrls(payload);
    return attachChannelToResult(
      "slack",
      await sendPayloadMediaSequenceAndFinalize({
        text: "",
        mediaUrls,
        send: async ({ text, mediaUrl }) =>
          await sendSlackOutboundMessage({
            cfg: ctx.cfg,
            to: ctx.to,
            text,
            mediaUrl,
            mediaAccess: ctx.mediaAccess,
            mediaLocalRoots: ctx.mediaLocalRoots,
            mediaReadFile: ctx.mediaReadFile,
            accountId: ctx.accountId,
            deps: ctx.deps,
            replyToId: ctx.replyToId,
            threadId: ctx.threadId,
            identity: ctx.identity,
          }),
        finalize: async () =>
          await sendSlackOutboundMessage({
            cfg: ctx.cfg,
            to: ctx.to,
            text: payload.text ?? "",
            mediaAccess: ctx.mediaAccess,
            mediaLocalRoots: ctx.mediaLocalRoots,
            mediaReadFile: ctx.mediaReadFile,
            blocks,
            accountId: ctx.accountId,
            deps: ctx.deps,
            replyToId: ctx.replyToId,
            threadId: ctx.threadId,
            identity: ctx.identity,
          }),
      }),
    );
  },
  ...createAttachedChannelResultAdapter({
    channel: "slack",
    sendText: async ({ cfg, to, text, accountId, deps, replyToId, threadId, identity }) =>
      await sendSlackOutboundMessage({
        cfg,
        to,
        text,
        accountId,
        deps,
        replyToId,
        threadId,
        identity,
      }),
    sendMedia: async ({
      cfg,
      to,
      text,
      mediaUrl,
      mediaAccess,
      mediaLocalRoots,
      mediaReadFile,
      accountId,
      deps,
      replyToId,
      threadId,
      identity,
    }) =>
      await sendSlackOutboundMessage({
        cfg,
        to,
        text,
        mediaUrl,
        mediaAccess,
        mediaLocalRoots,
        mediaReadFile,
        accountId,
        deps,
        replyToId,
        threadId,
        identity,
      }),
  }),
};
