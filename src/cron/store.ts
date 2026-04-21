import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { expandHomePrefix } from "../infra/home-dir.js";
import { resolveConfigDir } from "../utils.js";
import { parseJsonWithJson5Fallback } from "../utils/parse-json-compat.js";
import type { CronStoreFile } from "./types.js";

const serializedStoreCache = new Map<string, string>();

function resolveDefaultCronDir(): string {
  return path.join(resolveConfigDir(), "cron");
}

function resolveDefaultCronStorePath(): string {
  return path.join(resolveDefaultCronDir(), "jobs.json");
}

function stripRuntimeOnlyCronFields(store: CronStoreFile): unknown {
  return {
    version: store.version,
    jobs: store.jobs.map((job) => {
      const { state: _state, updatedAtMs: _updatedAtMs, ...rest } = job;
      return rest;
    }),
  };
}

function parseCronStoreForBackupComparison(raw: string): CronStoreFile | null {
  try {
    const parsed = parseJsonWithJson5Fallback(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    const version = (parsed as { version?: unknown }).version;
    const jobs = (parsed as { jobs?: unknown }).jobs;
    if (version !== 1 || !Array.isArray(jobs)) {
      return null;
    }
    return {
      version: 1,
      jobs: jobs.filter(Boolean) as CronStoreFile["jobs"],
    };
  } catch {
    return null;
  }
}

function shouldSkipCronBackupForRuntimeOnlyChanges(
  previousRaw: string | null,
  nextStore: CronStoreFile,
): boolean {
  if (previousRaw === null) {
    return false;
  }
  const previous = parseCronStoreForBackupComparison(previousRaw);
  if (!previous) {
    return false;
  }
  return (
    JSON.stringify(stripRuntimeOnlyCronFields(previous)) ===
    JSON.stringify(stripRuntimeOnlyCronFields(nextStore))
  );
}

export function resolveCronStorePath(storePath?: string) {
  if (storePath?.trim()) {
    const raw = storePath.trim();
    if (raw.startsWith("~")) {
      return path.resolve(expandHomePrefix(raw));
    }
    return path.resolve(raw);
  }
  return resolveDefaultCronStorePath();
}

export async function loadCronStore(storePath: string): Promise<CronStoreFile> {
  try {
    const raw = await fs.promises.readFile(storePath, "utf-8");
    let parsed: unknown;
    try {
      parsed = parseJsonWithJson5Fallback(raw);
    } catch (err) {
      throw new Error(`Failed to parse cron store at ${storePath}: ${String(err)}`, {
        cause: err,
      });
    }
    const parsedRecord =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    const jobs = Array.isArray(parsedRecord.jobs) ? (parsedRecord.jobs as never[]) : [];
    const store = {
      version: 1 as const,
      jobs: jobs.filter(Boolean) as never as CronStoreFile["jobs"],
    };
    serializedStoreCache.set(storePath, JSON.stringify(store, null, 2));
    return store;
  } catch (err) {
    if ((err as { code?: unknown })?.code === "ENOENT") {
      serializedStoreCache.delete(storePath);
      return { version: 1, jobs: [] };
    }
    throw err;
  }
}

type SaveCronStoreOptions = {
  skipBackup?: boolean;
};

const cronStoreWriteLocks = new Map<string, Promise<void>>();

async function withCronStoreWriteLock<T>(storePath: string, fn: () => Promise<T>): Promise<T> {
  const previous = cronStoreWriteLocks.get(storePath) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  cronStoreWriteLocks.set(
    storePath,
    previous.then(() => current),
  );
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (cronStoreWriteLocks.get(storePath) === current) {
      cronStoreWriteLocks.delete(storePath);
    }
  }
}

function stableJobKey(
  job: { id?: unknown; sessionKey?: unknown; name?: unknown },
  index: number,
): string {
  if (typeof job.id === "string" && job.id.trim()) {
    return `id:${job.id}`;
  }
  if (typeof job.sessionKey === "string" && job.sessionKey.trim()) {
    return `session:${job.sessionKey}`;
  }
  if (typeof job.name === "string" && job.name.trim()) {
    return `name:${job.name}:${index}`;
  }
  return `index:${index}`;
}

function mergeCronStores(previous: CronStoreFile, next: CronStoreFile): CronStoreFile {
  const previousJobs = new Map<string, CronStoreFile["jobs"][number]>();
  previous.jobs.forEach((job, index) => {
    previousJobs.set(stableJobKey(job, index), job);
  });
  const nextJobs = new Map<string, CronStoreFile["jobs"][number]>();
  next.jobs.forEach((job, index) => {
    nextJobs.set(stableJobKey(job, index), job);
  });

  const removedKeys = new Set<string>();
  for (const key of previousJobs.keys()) {
    if (!nextJobs.has(key)) {
      removedKeys.add(key);
    }
  }

  const mergedJobs = new Map<string, CronStoreFile["jobs"][number]>();
  for (const [key, job] of previousJobs.entries()) {
    if (!removedKeys.has(key)) {
      mergedJobs.set(key, job);
    }
  }
  for (const [key, job] of nextJobs.entries()) {
    mergedJobs.set(key, job);
  }

  return {
    version: 1,
    jobs: Array.from(mergedJobs.values()),
  };
}

async function setSecureFileMode(filePath: string): Promise<void> {
  await fs.promises.chmod(filePath, 0o600).catch(() => undefined);
}

export async function saveCronStore(
  storePath: string,
  store: CronStoreFile,
  opts?: SaveCronStoreOptions,
) {
  return await withCronStoreWriteLock(storePath, async () => {
    const storeDir = path.dirname(storePath);
    await fs.promises.mkdir(storeDir, { recursive: true, mode: 0o700 });
    await fs.promises.chmod(storeDir, 0o700).catch(() => undefined);

    let effectiveStore = store;
    let previous: string | null = null;
    try {
      previous = await fs.promises.readFile(storePath, "utf-8");
    } catch (err) {
      if ((err as { code?: unknown }).code !== "ENOENT") {
        throw err;
      }
    }

    const parsedPrevious = previous ? parseCronStoreForBackupComparison(previous) : null;
    if (parsedPrevious) {
      effectiveStore = mergeCronStores(parsedPrevious, store);
    }

    const json = JSON.stringify(effectiveStore, null, 2);
    const cached = serializedStoreCache.get(storePath);
    if (cached === json) {
      return;
    }
    if (previous === json) {
      serializedStoreCache.set(storePath, json);
      return;
    }
    const skipBackup =
      opts?.skipBackup === true ||
      shouldSkipCronBackupForRuntimeOnlyChanges(previous, effectiveStore);
    const tmp = `${storePath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
    await fs.promises.writeFile(tmp, json, { encoding: "utf-8", mode: 0o600 });
    await setSecureFileMode(tmp);
    if (previous !== null && !skipBackup) {
      try {
        const backupPath = `${storePath}.bak`;
        await fs.promises.copyFile(storePath, backupPath);
        await setSecureFileMode(backupPath);
      } catch {
        // best-effort
      }
    }
    await renameWithRetry(tmp, storePath);
    await setSecureFileMode(storePath);
    serializedStoreCache.set(storePath, json);
  });
}

const RENAME_MAX_RETRIES = 3;
const RENAME_BASE_DELAY_MS = 50;

async function renameWithRetry(src: string, dest: string): Promise<void> {
  for (let attempt = 0; attempt <= RENAME_MAX_RETRIES; attempt++) {
    try {
      await fs.promises.rename(src, dest);
      return;
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === "EBUSY" && attempt < RENAME_MAX_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, RENAME_BASE_DELAY_MS * 2 ** attempt));
        continue;
      }
      // Windows doesn't reliably support atomic replace via rename when dest exists.
      if (code === "EPERM" || code === "EEXIST") {
        await fs.promises.copyFile(src, dest);
        await fs.promises.unlink(src).catch(() => {});
        return;
      }
      throw err;
    }
  }
}
