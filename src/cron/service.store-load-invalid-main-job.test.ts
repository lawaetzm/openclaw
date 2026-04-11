import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CronService } from "./service.js";
import {
  createNoopLogger,
  installCronTestHooks,
  writeCronStoreSnapshot,
} from "./service.test-harness.js";
import type { CronJob } from "./types.js";

const noopLogger = createNoopLogger();
installCronTestHooks({ logger: noopLogger });

async function makeStorePath() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cron-store-load-"));
  return {
    dir,
    storePath: path.join(dir, "cron", "jobs.json"),
  };
}

async function writeRawStore(storePath: string, jobs: unknown[]) {
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  await fs.writeFile(storePath, JSON.stringify({ version: 1, jobs }, null, 2), "utf-8");
}

describe("CronService store load", () => {
  let tempDir: string | null = null;

  afterEach(async () => {
    if (!tempDir) {
      return;
    }
    await fs.rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  });

  it("skips invalid main jobs with agentTurn payloads loaded from disk", async () => {
    const { dir, storePath } = await makeStorePath();
    tempDir = dir;
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeatNow = vi.fn();

    const job = {
      id: "job-1",
      enabled: true,
      createdAtMs: Date.parse("2025-12-13T00:00:00.000Z"),
      updatedAtMs: Date.parse("2025-12-13T00:00:00.000Z"),
      schedule: { kind: "at", at: "2025-12-13T00:00:01.000Z" },
      sessionTarget: "main",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "bad" },
      state: {},
      name: "bad",
    } satisfies CronJob;

    await writeCronStoreSnapshot({ storePath, jobs: [job] });

    const cron = new CronService({
      storePath,
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent,
      requestHeartbeatNow,
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });

    await cron.start();
    vi.setSystemTime(new Date("2025-12-13T00:00:01.000Z"));
    await cron.run("job-1", "due");

    expect(enqueueSystemEvent).not.toHaveBeenCalled();
    expect(requestHeartbeatNow).not.toHaveBeenCalled();

    const jobs = await cron.list({ includeDisabled: true });
    expect(jobs[0]?.state.lastStatus).toBe("skipped");
    expect(jobs[0]?.state.lastError).toMatch(/main cron jobs require payload\.kind/i);

    cron.stop();
  });

  it("runs legacy message-only isolated jobs during startup catch-up", async () => {
    const { dir, storePath } = await makeStorePath();
    tempDir = dir;
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeatNow = vi.fn();
    const runIsolatedAgentJob = vi.fn(
      async (_params: { job: CronJob; message: string; abortSignal?: AbortSignal }) => ({
        status: "ok" as const,
        summary: "done",
      }),
    );

    await writeRawStore(storePath, [
      {
        id: "legacy-job",
        name: " Legacy startup job ",
        createdAtMs: Date.parse("2025-12-12T23:58:00.000Z"),
        updatedAtMs: Date.parse("2025-12-12T23:58:00.000Z"),
        schedule: { kind: "at", at: "2025-12-12T23:59:00.000Z" },
        message: "  legacy ping  ",
        model: " minimax/MiniMax-M2.7 ",
        thinking: " high ",
        session: { label: " agent:main:cron:legacy-job " },
        state: { nextRunAtMs: Date.parse("2025-12-12T23:59:00.000Z") },
      },
    ]);

    const cron = new CronService({
      storePath,
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent,
      requestHeartbeatNow,
      runIsolatedAgentJob,
    });

    await cron.start();

    expect(runIsolatedAgentJob).toHaveBeenCalledTimes(1);
    const firstCall = vi.mocked(runIsolatedAgentJob).mock.calls[0]?.[0];
    expect(firstCall?.message).toBe("legacy ping");
    expect(firstCall?.job.sessionKey).toBe("agent:main:cron:legacy-job");
    expect(firstCall?.job.sessionTarget).toBe("isolated");
    expect(firstCall?.job.wakeMode).toBe("now");
    expect(firstCall?.job.payload.kind).toBe("agentTurn");
    if (firstCall?.job.payload.kind === "agentTurn") {
      expect(firstCall.job.payload.message).toBe("legacy ping");
      expect(firstCall.job.payload.model).toBe("minimax/MiniMax-M2.7");
      expect(firstCall.job.payload.thinking).toBe("high");
    }

    const jobs = await cron.list({ includeDisabled: true });
    expect(jobs).toHaveLength(0);

    cron.stop();
  });

  it("skips malformed jobs with missing payloads instead of crashing startup", async () => {
    const { dir, storePath } = await makeStorePath();
    tempDir = dir;
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeatNow = vi.fn();
    const runIsolatedAgentJob = vi.fn(
      async (_params: { job: CronJob; message: string; abortSignal?: AbortSignal }) => ({
        status: "ok" as const,
      }),
    );

    await writeRawStore(storePath, [
      {
        id: "broken-job",
        name: "broken",
        enabled: true,
        createdAtMs: Date.parse("2025-12-12T23:58:00.000Z"),
        updatedAtMs: Date.parse("2025-12-12T23:58:00.000Z"),
        schedule: { kind: "at", at: "2025-12-12T23:59:00.000Z" },
        sessionTarget: "main",
        wakeMode: "now",
        state: { nextRunAtMs: Date.parse("2025-12-12T23:59:00.000Z") },
      },
    ]);

    const cron = new CronService({
      storePath,
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent,
      requestHeartbeatNow,
      runIsolatedAgentJob,
    });

    await cron.start();

    expect(enqueueSystemEvent).not.toHaveBeenCalled();
    expect(requestHeartbeatNow).not.toHaveBeenCalled();
    expect(runIsolatedAgentJob).not.toHaveBeenCalled();

    const jobs = await cron.list({ includeDisabled: true });
    expect(jobs[0]?.state.lastStatus).toBe("skipped");
    expect(jobs[0]?.state.lastError).toMatch(/payload is missing or invalid/i);

    cron.stop();
  });
});
