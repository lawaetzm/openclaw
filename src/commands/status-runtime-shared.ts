import { resolveAgentDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import type { OpenClawConfig } from "../config/types.js";
import type { HeartbeatEventPayload } from "../infra/heartbeat-events.js";
import type { HealthSummary } from "./health.js";
import { getDaemonStatusSummary, getNodeDaemonStatusSummary } from "./status.daemon.js";

let providerUsagePromise: Promise<typeof import("../infra/provider-usage.js")> | undefined;
let securityAuditModulePromise: Promise<typeof import("../security/audit.runtime.js")> | undefined;
let gatewayCallModulePromise: Promise<typeof import("../gateway/call.js")> | undefined;

function loadProviderUsage() {
  providerUsagePromise ??= import("../infra/provider-usage.js");
  return providerUsagePromise;
}

function loadSecurityAuditModule() {
  securityAuditModulePromise ??= import("../security/audit.runtime.js");
  return securityAuditModulePromise;
}

function loadGatewayCallModule() {
  gatewayCallModulePromise ??= import("../gateway/call.js");
  return gatewayCallModulePromise;
}

export async function resolveStatusSecurityAudit(params: {
  config: OpenClawConfig;
  sourceConfig: OpenClawConfig;
}) {
  const { runSecurityAudit } = await loadSecurityAuditModule();
  return await runSecurityAudit({
    config: params.config,
    sourceConfig: params.sourceConfig,
    deep: false,
    includeFilesystem: true,
    includeChannelSecurity: true,
  });
}

export async function resolveStatusUsageSummary(opts?: {
  timeoutMs?: number;
  agentDir?: string;
  config?: OpenClawConfig;
}) {
  const { loadProviderUsageSummary } = await loadProviderUsage();
  const { loadConfig } = await import("../config/config.js");
  const config = opts?.config ?? loadConfig();
  const agentDir = opts?.agentDir ?? resolveAgentDir(config, resolveDefaultAgentId(config));
  return await loadProviderUsageSummary({
    timeoutMs: opts?.timeoutMs,
    agentDir,
    config,
  });
}

export async function loadStatusProviderUsageModule() {
  return await loadProviderUsage();
}

export async function resolveStatusGatewayHealth(params: {
  config: OpenClawConfig;
  timeoutMs?: number;
}) {
  const { callGateway } = await loadGatewayCallModule();
  return await callGateway<HealthSummary>({
    method: "health",
    params: { probe: true },
    timeoutMs: params.timeoutMs,
    config: params.config,
  });
}

export async function resolveStatusGatewayHealthSafe(params: {
  config: OpenClawConfig;
  timeoutMs?: number;
  gatewayReachable: boolean;
  gatewayProbeError?: string | null;
  callOverrides?: {
    url: string;
    token?: string;
    password?: string;
  };
}) {
  if (!params.gatewayReachable) {
    return { error: params.gatewayProbeError ?? "gateway unreachable" };
  }
  const { callGateway } = await loadGatewayCallModule();
  return await callGateway<HealthSummary>({
    method: "health",
    params: { probe: true },
    timeoutMs: params.timeoutMs,
    config: params.config,
    ...params.callOverrides,
  }).catch((err) => ({ error: String(err) }));
}

export async function resolveStatusLastHeartbeat(params: {
  config: OpenClawConfig;
  timeoutMs?: number;
  gatewayReachable: boolean;
}) {
  if (!params.gatewayReachable) {
    return null;
  }
  const { callGateway } = await loadGatewayCallModule();
  return await callGateway<HeartbeatEventPayload | null>({
    method: "last-heartbeat",
    params: {},
    timeoutMs: params.timeoutMs,
    config: params.config,
  }).catch(() => null);
}

export async function resolveStatusServiceSummaries() {
  return await Promise.all([getDaemonStatusSummary(), getNodeDaemonStatusSummary()]);
}

type StatusUsageSummary = Awaited<ReturnType<typeof resolveStatusUsageSummary>>;
type StatusGatewayHealth = Awaited<ReturnType<typeof resolveStatusGatewayHealth>>;
type StatusLastHeartbeat = Awaited<ReturnType<typeof resolveStatusLastHeartbeat>>;
type StatusGatewayServiceSummary = Awaited<ReturnType<typeof getDaemonStatusSummary>>;
type StatusNodeServiceSummary = Awaited<ReturnType<typeof getNodeDaemonStatusSummary>>;
type StatusSecurityAudit = Awaited<ReturnType<typeof resolveStatusSecurityAudit>>;

export async function resolveStatusRuntimeDetails(params: {
  config: OpenClawConfig;
  timeoutMs?: number;
  usage?: boolean;
  deep?: boolean;
  gatewayReachable: boolean;
  suppressHealthErrors?: boolean;
  /** When set, usage auth resolves against this agent (same as `models status` default agent). */
  usageAgentDir?: string;
  resolveUsage?: (input: {
    timeoutMs?: number;
    config: OpenClawConfig;
    agentDir?: string;
  }) => Promise<StatusUsageSummary>;
  resolveHealth?: (input: {
    config: OpenClawConfig;
    timeoutMs?: number;
  }) => Promise<StatusGatewayHealth>;
}) {
  const resolveUsageSummary =
    params.resolveUsage ??
    ((input: { timeoutMs?: number; config: OpenClawConfig; agentDir?: string }) =>
      resolveStatusUsageSummary({
        timeoutMs: input.timeoutMs,
        config: input.config,
        agentDir: input.agentDir,
      }));
  const resolveGatewayHealthSummary = params.resolveHealth ?? resolveStatusGatewayHealth;
  const usage = params.usage
    ? await resolveUsageSummary({
        timeoutMs: params.timeoutMs,
        config: params.config,
        agentDir: params.usageAgentDir,
      })
    : undefined;
  const health = params.deep
    ? params.suppressHealthErrors
      ? await resolveGatewayHealthSummary({
          config: params.config,
          timeoutMs: params.timeoutMs,
        }).catch(() => undefined)
      : await resolveGatewayHealthSummary({
          config: params.config,
          timeoutMs: params.timeoutMs,
        })
    : undefined;
  const lastHeartbeat = params.deep
    ? await resolveStatusLastHeartbeat({
        config: params.config,
        timeoutMs: params.timeoutMs,
        gatewayReachable: params.gatewayReachable,
      })
    : null;
  const [gatewayService, nodeService] = await resolveStatusServiceSummaries();
  const result = {
    usage,
    health,
    lastHeartbeat,
    gatewayService,
    nodeService,
  };
  return result satisfies {
    usage?: StatusUsageSummary;
    health?: StatusGatewayHealth;
    lastHeartbeat: StatusLastHeartbeat;
    gatewayService: StatusGatewayServiceSummary;
    nodeService: StatusNodeServiceSummary;
  };
}

export async function resolveStatusRuntimeSnapshot(params: {
  config: OpenClawConfig;
  sourceConfig: OpenClawConfig;
  timeoutMs?: number;
  usage?: boolean;
  deep?: boolean;
  gatewayReachable: boolean;
  includeSecurityAudit?: boolean;
  suppressHealthErrors?: boolean;
  usageAgentDir?: string;
  resolveSecurityAudit?: (input: {
    config: OpenClawConfig;
    sourceConfig: OpenClawConfig;
  }) => Promise<StatusSecurityAudit>;
  resolveUsage?: (input: {
    timeoutMs?: number;
    config: OpenClawConfig;
    agentDir?: string;
  }) => Promise<StatusUsageSummary>;
  resolveHealth?: (input: {
    config: OpenClawConfig;
    timeoutMs?: number;
  }) => Promise<StatusGatewayHealth>;
}) {
  const securityAudit = params.includeSecurityAudit
    ? await (params.resolveSecurityAudit ?? resolveStatusSecurityAudit)({
        config: params.config,
        sourceConfig: params.sourceConfig,
      })
    : undefined;
  const runtimeDetails = await resolveStatusRuntimeDetails({
    config: params.config,
    timeoutMs: params.timeoutMs,
    usage: params.usage,
    deep: params.deep,
    gatewayReachable: params.gatewayReachable,
    suppressHealthErrors: params.suppressHealthErrors,
    usageAgentDir: params.usageAgentDir,
    resolveUsage: params.resolveUsage,
    resolveHealth: params.resolveHealth,
  });
  return {
    securityAudit,
    ...runtimeDetails,
  } satisfies {
    securityAudit?: StatusSecurityAudit;
    usage?: StatusUsageSummary;
    health?: StatusGatewayHealth;
    lastHeartbeat: StatusLastHeartbeat;
    gatewayService: StatusGatewayServiceSummary;
    nodeService: StatusNodeServiceSummary;
  };
}
