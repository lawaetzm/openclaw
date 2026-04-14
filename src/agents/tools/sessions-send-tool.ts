import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { callGateway } from "../../gateway/call.js";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  isSubagentSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
  resolveAgentIdFromSessionKey,
} from "../../routing/session-key.js";
import { SESSION_LABEL_MAX_LENGTH } from "../../sessions/session-label.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import {
  type GatewayMessageChannel,
  INTERNAL_MESSAGE_CHANNEL,
} from "../../utils/message-channel.js";
import { AGENT_LANE_NESTED } from "../lanes.js";
import {
  readLatestAssistantReplySnapshot,
  waitForAgentRunAndReadUpdatedAssistantReply,
} from "../run-wait.js";
import {
  describeSessionsSendTool,
  SESSIONS_SEND_TOOL_DISPLAY_SUMMARY,
} from "../tool-description-presets.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";
import {
  createSessionVisibilityGuard,
  createAgentToAgentPolicy,
  resolveEffectiveSessionToolsVisibility,
  resolveSessionReference,
  resolveSessionToolContext,
  resolveVisibleSessionReference,
} from "./sessions-helpers.js";
import { buildAgentToAgentMessageContext, resolvePingPongTurns } from "./sessions-send-helpers.js";
import { runSessionsSendA2AFlow } from "./sessions-send-tool.a2a.js";

const SessionsSendToolSchema = Type.Object({
  sessionKey: Type.Optional(Type.String()),
  label: Type.Optional(Type.String({ minLength: 1, maxLength: SESSION_LABEL_MAX_LENGTH })),
  agentId: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
  message: Type.String(),
  timeoutSeconds: Type.Optional(Type.Number({ minimum: 0 })),
});

type GatewayCaller = typeof callGateway;
const SESSIONS_SEND_REPLY_HISTORY_LIMIT = 50;
const AGENT_BUS_DELEGATE_SCRIPT = "/home/claw/.openclaw/shared/sessions_send_with_job.py";

type AgentBusDelegationParams = {
  fromAgent: string;
  toAgent: string;
  requesterSessionKey: string;
  task: string;
  timeoutSeconds: number;
};

type AgentBusDelegate = (
  params: AgentBusDelegationParams,
) => Promise<
  { ok: true; result: Record<string, unknown> } | { ok: false; error: string; timeout?: boolean }
>;

async function startAgentRun(params: {
  callGateway: GatewayCaller;
  runId: string;
  sendParams: Record<string, unknown>;
  sessionKey: string;
}): Promise<{ ok: true; runId: string } | { ok: false; result: ReturnType<typeof jsonResult> }> {
  try {
    const response = await params.callGateway<{ runId: string }>({
      method: "agent",
      params: params.sendParams,
      timeoutMs: 10_000,
    });
    return {
      ok: true,
      runId: typeof response?.runId === "string" && response.runId ? response.runId : params.runId,
    };
  } catch (err) {
    const messageText =
      err instanceof Error ? err.message : typeof err === "string" ? err : "error";
    return {
      ok: false,
      result: jsonResult({
        runId: params.runId,
        status: "error",
        error: messageText,
        sessionKey: params.sessionKey,
      }),
    };
  }
}

function shouldUseAgentBusDelegation(params: {
  requesterSessionKey?: string;
  targetSessionKey: string;
}): { enabled: boolean; fromAgent?: string; toAgent?: string } {
  const requesterKey = params.requesterSessionKey?.trim() ?? "";
  const requesterParsed = parseAgentSessionKey(requesterKey);
  const targetParsed = parseAgentSessionKey(params.targetSessionKey);
  if (!requesterParsed || !targetParsed) {
    return { enabled: false };
  }
  if (isSubagentSessionKey(requesterKey) || isSubagentSessionKey(params.targetSessionKey)) {
    return { enabled: false };
  }
  const fromAgent = normalizeAgentId(requesterParsed.agentId);
  const toAgent = normalizeAgentId(targetParsed.agentId);
  if (!fromAgent || !toAgent || fromAgent === toAgent) {
    return { enabled: false };
  }
  return { enabled: true, fromAgent, toAgent };
}

function delegateToAgentBus(params: AgentBusDelegationParams): ReturnType<AgentBusDelegate> {
  return new Promise((resolve) => {
    const action = params.timeoutSeconds > 0 ? "delegate_and_wait" : "delegate";
    const child = spawn("python3", [AGENT_BUS_DELEGATE_SCRIPT, "delegate-json"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      resolve({ ok: false, error: error.message || "agent-bus delegation failed" });
    });
    child.on("close", (code) => {
      const out = stdout.trim();
      let payload: Record<string, unknown> | undefined;
      if (out) {
        try {
          payload = JSON.parse(out) as Record<string, unknown>;
        } catch {
          payload = undefined;
        }
      }
      if (
        code === 0 &&
        payload?.ok === true &&
        payload.result &&
        typeof payload.result === "object"
      ) {
        resolve({ ok: true, result: payload.result as Record<string, unknown> });
        return;
      }
      const errorText =
        (typeof payload?.error === "string" && payload.error) ||
        stderr.trim() ||
        out ||
        "agent-bus delegation failed";
      resolve({
        ok: false,
        error: errorText,
        timeout: /timed out waiting for result/i.test(errorText),
      });
    });
    child.stdin.end(
      JSON.stringify({
        action,
        from_agent: params.fromAgent,
        to_agent: params.toAgent,
        task: params.task,
        requester_session_key: params.requesterSessionKey,
        timeout: params.timeoutSeconds,
      }),
    );
  });
}

function summarizeAgentBusResult(result: Record<string, unknown>): string | undefined {
  const direct = result.result;
  if (typeof direct === "string" && direct.trim()) {
    return direct.trim();
  }
  if (direct && typeof direct === "object") {
    const candidate =
      typeof (direct as { summary?: unknown }).summary === "string"
        ? (direct as { summary: string }).summary
        : typeof (direct as { message?: unknown }).message === "string"
          ? (direct as { message: string }).message
          : typeof (direct as { note?: unknown }).note === "string"
            ? (direct as { note: string }).note
            : undefined;
    if (candidate?.trim()) {
      return candidate.trim();
    }
    return JSON.stringify(direct);
  }
  if (typeof result.error === "string" && result.error.trim()) {
    return result.error.trim();
  }
  return undefined;
}

export function createSessionsSendTool(opts?: {
  agentSessionKey?: string;
  agentChannel?: GatewayMessageChannel;
  sandboxed?: boolean;
  config?: OpenClawConfig;
  callGateway?: GatewayCaller;
  delegateToAgentBus?: AgentBusDelegate;
}): AnyAgentTool {
  return {
    label: "Session Send",
    name: "sessions_send",
    displaySummary: SESSIONS_SEND_TOOL_DISPLAY_SUMMARY,
    description: describeSessionsSendTool(),
    parameters: SessionsSendToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const gatewayCall = opts?.callGateway ?? callGateway;
      const message = readStringParam(params, "message", { required: true });
      const { cfg, mainKey, alias, effectiveRequesterKey, restrictToSpawned } =
        resolveSessionToolContext(opts);

      const a2aPolicy = createAgentToAgentPolicy(cfg);
      const sessionVisibility = resolveEffectiveSessionToolsVisibility({
        cfg,
        sandboxed: opts?.sandboxed === true,
      });

      const sessionKeyParam = readStringParam(params, "sessionKey");
      const labelParam = normalizeOptionalString(readStringParam(params, "label"));
      const labelAgentIdParam = normalizeOptionalString(readStringParam(params, "agentId"));
      if (sessionKeyParam && labelParam) {
        return jsonResult({
          runId: crypto.randomUUID(),
          status: "error",
          error: "Provide either sessionKey or label (not both).",
        });
      }

      let sessionKey = sessionKeyParam;
      if (!sessionKey && labelParam) {
        const requesterAgentId = resolveAgentIdFromSessionKey(effectiveRequesterKey);
        const requestedAgentId = labelAgentIdParam
          ? normalizeAgentId(labelAgentIdParam)
          : undefined;

        if (restrictToSpawned && requestedAgentId && requestedAgentId !== requesterAgentId) {
          return jsonResult({
            runId: crypto.randomUUID(),
            status: "forbidden",
            error: "Sandboxed sessions_send label lookup is limited to this agent",
          });
        }

        if (requesterAgentId && requestedAgentId && requestedAgentId !== requesterAgentId) {
          if (!a2aPolicy.enabled) {
            return jsonResult({
              runId: crypto.randomUUID(),
              status: "forbidden",
              error:
                "Agent-to-agent messaging is disabled. Set tools.agentToAgent.enabled=true to allow cross-agent sends.",
            });
          }
          if (!a2aPolicy.isAllowed(requesterAgentId, requestedAgentId)) {
            return jsonResult({
              runId: crypto.randomUUID(),
              status: "forbidden",
              error: "Agent-to-agent messaging denied by tools.agentToAgent.allow.",
            });
          }
        }

        const resolveParams: Record<string, unknown> = {
          label: labelParam,
          ...(requestedAgentId ? { agentId: requestedAgentId } : {}),
          ...(restrictToSpawned ? { spawnedBy: effectiveRequesterKey } : {}),
        };
        let resolvedKey = "";
        try {
          const resolved = await gatewayCall<{ key: string }>({
            method: "sessions.resolve",
            params: resolveParams,
            timeoutMs: 10_000,
          });
          resolvedKey = normalizeOptionalString(resolved?.key) ?? "";
        } catch (err) {
          const msg = formatErrorMessage(err);
          if (restrictToSpawned) {
            return jsonResult({
              runId: crypto.randomUUID(),
              status: "forbidden",
              error: "Session not visible from this sandboxed agent session.",
            });
          }
          return jsonResult({
            runId: crypto.randomUUID(),
            status: "error",
            error: msg || `No session found with label: ${labelParam}`,
          });
        }

        if (!resolvedKey) {
          if (restrictToSpawned) {
            return jsonResult({
              runId: crypto.randomUUID(),
              status: "forbidden",
              error: "Session not visible from this sandboxed agent session.",
            });
          }
          return jsonResult({
            runId: crypto.randomUUID(),
            status: "error",
            error: `No session found with label: ${labelParam}`,
          });
        }
        sessionKey = resolvedKey;
      }

      if (!sessionKey) {
        return jsonResult({
          runId: crypto.randomUUID(),
          status: "error",
          error: "Either sessionKey or label is required",
        });
      }
      const resolvedSession = await resolveSessionReference({
        sessionKey,
        alias,
        mainKey,
        requesterInternalKey: effectiveRequesterKey,
        restrictToSpawned,
      });
      if (!resolvedSession.ok) {
        return jsonResult({
          runId: crypto.randomUUID(),
          status: resolvedSession.status,
          error: resolvedSession.error,
        });
      }
      const visibleSession = await resolveVisibleSessionReference({
        resolvedSession,
        requesterSessionKey: effectiveRequesterKey,
        restrictToSpawned,
        visibilitySessionKey: sessionKey,
      });
      if (!visibleSession.ok) {
        return jsonResult({
          runId: crypto.randomUUID(),
          status: visibleSession.status,
          error: visibleSession.error,
          sessionKey: visibleSession.displayKey,
        });
      }
      // Normalize sessionKey/sessionId input into a canonical session key.
      const resolvedKey = visibleSession.key;
      const displayKey = visibleSession.displayKey;
      const timeoutSeconds =
        typeof params.timeoutSeconds === "number" && Number.isFinite(params.timeoutSeconds)
          ? Math.max(0, Math.floor(params.timeoutSeconds))
          : 30;
      const timeoutMs = timeoutSeconds * 1000;
      const announceTimeoutMs = timeoutSeconds === 0 ? 30_000 : timeoutMs;
      const idempotencyKey = crypto.randomUUID();
      let runId: string = idempotencyKey;
      const busDelegation = shouldUseAgentBusDelegation({
        requesterSessionKey: effectiveRequesterKey,
        targetSessionKey: resolvedKey,
      });
      const visibilityGuard = await createSessionVisibilityGuard({
        action: "send",
        requesterSessionKey: effectiveRequesterKey,
        visibility: sessionVisibility,
        a2aPolicy,
      });
      const access = visibilityGuard.check(resolvedKey);
      if (!access.allowed) {
        return jsonResult({
          runId: crypto.randomUUID(),
          status: access.status,
          error: access.error,
          sessionKey: displayKey,
        });
      }
      if (busDelegation.enabled && busDelegation.fromAgent && busDelegation.toAgent) {
        const busResult = await (opts?.delegateToAgentBus ?? delegateToAgentBus)({
          fromAgent: busDelegation.fromAgent,
          toAgent: busDelegation.toAgent,
          requesterSessionKey: effectiveRequesterKey,
          task: message,
          timeoutSeconds,
        });
        if (!busResult.ok) {
          return jsonResult({
            runId: crypto.randomUUID(),
            status: busResult.timeout ? "timeout" : "error",
            error: busResult.error,
            sessionKey: displayKey,
          });
        }
        const delegatedJobId =
          typeof busResult.result.job_id === "string"
            ? busResult.result.job_id
            : crypto.randomUUID();
        if (timeoutSeconds === 0) {
          return jsonResult({
            runId: delegatedJobId,
            status: "accepted",
            sessionKey: displayKey,
            jobId: delegatedJobId,
            busResult: busResult.result,
            delivery: { status: "accepted", mode: "agent_bus" as const },
          });
        }
        const busReply = summarizeAgentBusResult(busResult.result);
        const busStatus =
          typeof busResult.result.status === "string"
            ? busResult.result.status.toLowerCase()
            : "ok";
        return jsonResult({
          runId: delegatedJobId,
          status: busStatus === "failed" ? "error" : "ok",
          error:
            busStatus === "failed"
              ? typeof busResult.result.error === "string"
                ? busResult.result.error
                : "agent bus delegation failed"
              : undefined,
          reply: busReply,
          sessionKey: displayKey,
          jobId: delegatedJobId,
          busResult: busResult.result,
          delivery: { status: "completed", mode: "agent_bus" as const },
        });
      }

      // Capture the pre-run assistant snapshot before starting the nested run.
      // Fast in-process test doubles and short-circuit agent paths can finish
      // before we reach the post-run read, which would otherwise make the new
      // reply look like the baseline and hide it from the caller.
      const baselineReply =
        timeoutSeconds === 0
          ? undefined
          : await readLatestAssistantReplySnapshot({
              sessionKey: resolvedKey,
              limit: SESSIONS_SEND_REPLY_HISTORY_LIMIT,
              callGateway: gatewayCall,
            });

      const agentMessageContext = buildAgentToAgentMessageContext({
        requesterSessionKey: opts?.agentSessionKey,
        requesterChannel: opts?.agentChannel,
        targetSessionKey: displayKey,
      });
      const sendParams = {
        message,
        sessionKey: resolvedKey,
        idempotencyKey,
        deliver: false,
        channel: INTERNAL_MESSAGE_CHANNEL,
        lane: AGENT_LANE_NESTED,
        extraSystemPrompt: agentMessageContext,
        inputProvenance: {
          kind: "inter_session",
          sourceSessionKey: opts?.agentSessionKey,
          sourceChannel: opts?.agentChannel,
          sourceTool: "sessions_send",
        },
      };
      const requesterSessionKey = opts?.agentSessionKey;
      const requesterChannel = opts?.agentChannel;
      const maxPingPongTurns = resolvePingPongTurns(cfg);
      const delivery = { status: "pending", mode: "announce" as const };
      const startA2AFlow = (roundOneReply?: string, waitRunId?: string) => {
        void runSessionsSendA2AFlow({
          targetSessionKey: resolvedKey,
          displayKey,
          message,
          announceTimeoutMs,
          maxPingPongTurns,
          requesterSessionKey,
          requesterChannel,
          roundOneReply,
          waitRunId,
        });
      };

      if (timeoutSeconds === 0) {
        const start = await startAgentRun({
          callGateway: gatewayCall,
          runId,
          sendParams,
          sessionKey: displayKey,
        });
        if (!start.ok) {
          return start.result;
        }
        runId = start.runId;
        startA2AFlow(undefined, runId);
        return jsonResult({
          runId,
          status: "accepted",
          sessionKey: displayKey,
          delivery,
        });
      }

      const start = await startAgentRun({
        callGateway: gatewayCall,
        runId,
        sendParams,
        sessionKey: displayKey,
      });
      if (!start.ok) {
        return start.result;
      }
      runId = start.runId;
      const result = await waitForAgentRunAndReadUpdatedAssistantReply({
        runId,
        sessionKey: resolvedKey,
        timeoutMs,
        limit: SESSIONS_SEND_REPLY_HISTORY_LIMIT,
        baseline: baselineReply,
        callGateway: gatewayCall,
      });

      if (result.status === "timeout") {
        return jsonResult({
          runId,
          status: "timeout",
          error: result.error,
          sessionKey: displayKey,
        });
      }
      if (result.status === "error") {
        return jsonResult({
          runId,
          status: "error",
          error: result.error ?? "agent error",
          sessionKey: displayKey,
        });
      }
      const reply = result.replyText;
      startA2AFlow(reply ?? undefined);

      return jsonResult({
        runId,
        status: "ok",
        reply,
        sessionKey: displayKey,
        delivery,
      });
    },
  };
}

export const __testing = {
  shouldUseAgentBusDelegation,
  summarizeAgentBusResult,
};
