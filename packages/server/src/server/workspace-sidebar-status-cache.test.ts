import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import {
  WORKSPACE_SIDEBAR_STATUS_CACHE_MAX_AGE_MS,
  WorkspaceSidebarStatusCache,
} from "./workspace-sidebar-status-cache.js";

const temporaryHomes: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    temporaryHomes.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

function createLogger() {
  const logger = {
    child: () => logger,
    warn: vi.fn(),
  };
  return logger;
}

async function createHome(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "paseo-sidebar-cache-"));
  temporaryHomes.push(directory);
  return directory;
}

function createEntry(cwd: string, updatedAtMs: number) {
  return {
    cwd,
    currentBranch: "feature/cache",
    remoteUrl: "https://github.com/acme/repo.git",
    forge: "github",
    pullRequest: {
      number: 42,
      url: "https://github.com/acme/repo/pull/42",
      title: "Cache the sidebar status",
      state: "open",
      baseRefName: "main",
      headRefName: "feature/cache",
      isMerged: false,
      checksStatus: "success" as const,
    },
    updatedAtMs,
  };
}

test("restores a fresh versioned sidebar status from disk", async () => {
  const paseoHome = await createHome();
  const now = 1_800_000_000_000;
  const cwd = resolve(paseoHome, "repo");
  const filePath = join(paseoHome, "runtime", "workspace-sidebar-status.json");
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(
    filePath,
    JSON.stringify({ version: 1, entries: [createEntry(cwd, now - 1_000)] }),
  );

  const cache = new WorkspaceSidebarStatusCache({
    paseoHome,
    logger: createLogger() as never,
    now: () => now,
  });

  expect(cache.peek(cwd)).toEqual(createEntry(cwd, now - 1_000));
  await cache.dispose();
});

test("ignores expired and incompatible cache files", async () => {
  const paseoHome = await createHome();
  const now = 1_800_000_000_000;
  const cwd = resolve(paseoHome, "repo");
  const filePath = join(paseoHome, "runtime", "workspace-sidebar-status.json");
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(
    filePath,
    JSON.stringify({
      version: 1,
      entries: [createEntry(cwd, now - WORKSPACE_SIDEBAR_STATUS_CACHE_MAX_AGE_MS - 1)],
    }),
  );
  const expired = new WorkspaceSidebarStatusCache({
    paseoHome,
    logger: createLogger() as never,
    now: () => now,
  });
  expect(expired.peek(cwd)).toBeNull();
  await expired.dispose();

  await writeFile(filePath, JSON.stringify({ version: 2, entries: [createEntry(cwd, now)] }));
  const incompatible = new WorkspaceSidebarStatusCache({
    paseoHome,
    logger: createLogger() as never,
    now: () => now,
  });
  expect(incompatible.peek(cwd)).toBeNull();
  await incompatible.dispose();
});

test("coalesces updates and persists the latest values atomically through its store", async () => {
  vi.useFakeTimers();
  const paseoHome = await createHome();
  const cwdA = resolve(paseoHome, "repo-a");
  const cwdB = resolve(paseoHome, "repo-b");
  const writes: unknown[] = [];
  const cache = new WorkspaceSidebarStatusCache({
    paseoHome,
    logger: createLogger() as never,
    now: () => 1_800_000_000_000,
    writeFile: async (_filePath, value) => {
      writes.push(value);
    },
  });

  cache.remember(createEntry(cwdA, 0));
  cache.remember(createEntry(cwdB, 0));
  cache.forget(cwdA);
  await vi.runAllTimersAsync();

  expect(writes).toEqual([
    {
      version: 1,
      entries: [createEntry(cwdB, 1_800_000_000_000)],
    },
  ]);
  await cache.dispose();
});

test("writes a real cache file that a new instance can restore", async () => {
  const paseoHome = await createHome();
  const now = 1_800_000_000_000;
  const cwd = resolve(paseoHome, "repo");
  const cache = new WorkspaceSidebarStatusCache({
    paseoHome,
    logger: createLogger() as never,
    now: () => now,
  });
  cache.remember(createEntry(cwd, 0));
  await cache.dispose();

  const persisted = JSON.parse(
    await readFile(join(paseoHome, "runtime", "workspace-sidebar-status.json"), "utf8"),
  );
  expect(persisted).toEqual({
    version: 1,
    entries: [createEntry(cwd, now)],
  });

  const restored = new WorkspaceSidebarStatusCache({
    paseoHome,
    logger: createLogger() as never,
    now: () => now,
  });
  expect(restored.peek(cwd)).toEqual(createEntry(cwd, now));
  await restored.dispose();
});
