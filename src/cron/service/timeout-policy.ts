import type { CronJob } from "../types.js";

/**
 * Maximum wall-clock time for a single job execution. Acts as a safety net
 * on top of per-provider/per-agent timeouts to prevent one stuck job from
 * wedging the entire cron lane.
 */
export const DEFAULT_JOB_TIMEOUT_MS = 10 * 60_000; // 10 minutes

/**
 * Agent turns can legitimately run much longer than generic cron jobs.
 * Use a larger safety ceiling when no explicit timeout is set.
 */
export const AGENT_TURN_SAFETY_TIMEOUT_MS = 60 * 60_000; // 60 minutes

export function resolveCronJobTimeoutMs(job: CronJob): number | undefined {
  const payloadKind = typeof job.payload?.kind === "string" ? job.payload.kind : undefined;
  const payload = payloadKind === "agentTurn" && "message" in job.payload ? job.payload : undefined;
  const configuredTimeoutMs =
    payload && typeof payload.timeoutSeconds === "number"
      ? Math.floor(payload.timeoutSeconds * 1_000)
      : undefined;
  if (configuredTimeoutMs === undefined) {
    return payload ? AGENT_TURN_SAFETY_TIMEOUT_MS : DEFAULT_JOB_TIMEOUT_MS;
  }
  return configuredTimeoutMs <= 0 ? undefined : configuredTimeoutMs;
}
