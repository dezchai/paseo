import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type pino from "pino";
import { z } from "zod";
import { writeJsonFileAtomic } from "./atomic-file.js";

export const WORKSPACE_SIDEBAR_STATUS_CACHE_VERSION = 1;
export const WORKSPACE_SIDEBAR_STATUS_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
export const WORKSPACE_SIDEBAR_STATUS_CACHE_WRITE_DELAY_MS = 250;

const CachedPullRequestSchema = z
  .object({
    number: z.number().int().positive().optional(),
    repoOwner: z.string().min(1).optional(),
    repoName: z.string().min(1).optional(),
    projectPath: z.string().min(1).optional(),
    url: z.string().min(1),
    title: z.string(),
    state: z.string(),
    baseRefName: z.string(),
    headRefName: z.string(),
    isMerged: z.boolean(),
    isDraft: z.boolean().optional(),
    checksStatus: z.enum(["none", "pending", "success", "failure"]).optional(),
    reviewDecision: z.enum(["approved", "changes_requested", "pending"]).nullable().optional(),
  })
  .strict();

const WorkspaceSidebarStatusCacheEntrySchema = z
  .object({
    cwd: z.string().min(1),
    currentBranch: z.string().min(1),
    remoteUrl: z.string().min(1),
    forge: z.string().min(1),
    pullRequest: CachedPullRequestSchema,
    updatedAtMs: z.number().finite().nonnegative(),
  })
  .strict();

const WorkspaceSidebarStatusCacheFileSchema = z
  .object({
    version: z.literal(WORKSPACE_SIDEBAR_STATUS_CACHE_VERSION),
    entries: z.array(WorkspaceSidebarStatusCacheEntrySchema),
  })
  .strict();

export type WorkspaceSidebarStatusCacheEntry = z.infer<
  typeof WorkspaceSidebarStatusCacheEntrySchema
>;

export type WorkspaceSidebarCachedPullRequest = WorkspaceSidebarStatusCacheEntry["pullRequest"];

export interface WorkspaceSidebarStatusCacheStore {
  peek(cwd: string): WorkspaceSidebarStatusCacheEntry | null;
  remember(input: {
    cwd: string;
    currentBranch: string;
    remoteUrl: string;
    forge: string;
    pullRequest: WorkspaceSidebarCachedPullRequest;
  }): void;
  forget(cwd: string): void;
  dispose(): Promise<void>;
}

interface WorkspaceSidebarStatusCacheOptions {
  paseoHome: string;
  logger: pino.Logger;
  now?: () => number;
  readFile?: (filePath: string) => string;
  writeFile?: (filePath: string, value: unknown) => Promise<void>;
}

export class WorkspaceSidebarStatusCache implements WorkspaceSidebarStatusCacheStore {
  private readonly filePath: string;
  private readonly logger: pino.Logger;
  private readonly now: () => number;
  private readonly writeFile: (filePath: string, value: unknown) => Promise<void>;
  private readonly entries = new Map<string, WorkspaceSidebarStatusCacheEntry>();
  private writeTimer: NodeJS.Timeout | null = null;
  private writeChain: Promise<void> = Promise.resolve();
  private dirty = false;
  private disposed = false;

  constructor(options: WorkspaceSidebarStatusCacheOptions) {
    this.filePath = join(options.paseoHome, "runtime", "workspace-sidebar-status.json");
    this.logger = options.logger.child({ module: "workspace-sidebar-status-cache" });
    this.now = options.now ?? Date.now;
    this.writeFile = options.writeFile ?? writeJsonFileAtomic;
    this.load(options.readFile ?? ((filePath) => readFileSync(filePath, "utf8")));
  }

  peek(cwd: string): WorkspaceSidebarStatusCacheEntry | null {
    const key = resolve(cwd);
    const entry = this.entries.get(key);
    if (!entry) {
      return null;
    }
    if (this.now() - entry.updatedAtMs > WORKSPACE_SIDEBAR_STATUS_CACHE_MAX_AGE_MS) {
      this.entries.delete(key);
      this.scheduleWrite();
      return null;
    }
    return entry;
  }

  remember(input: {
    cwd: string;
    currentBranch: string;
    remoteUrl: string;
    forge: string;
    pullRequest: WorkspaceSidebarCachedPullRequest;
  }): void {
    const cwd = resolve(input.cwd);
    this.entries.set(cwd, {
      cwd,
      currentBranch: input.currentBranch,
      remoteUrl: input.remoteUrl,
      forge: input.forge,
      pullRequest: input.pullRequest,
      updatedAtMs: this.now(),
    });
    this.scheduleWrite();
  }

  forget(cwd: string): void {
    if (!this.entries.delete(resolve(cwd))) {
      return;
    }
    this.scheduleWrite();
  }

  async flush(): Promise<void> {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    if (!this.dirty) {
      await this.writeChain;
      return;
    }
    this.dirty = false;
    const value = {
      version: WORKSPACE_SIDEBAR_STATUS_CACHE_VERSION,
      entries: [...this.entries.values()],
    };
    this.writeChain = this.writeChain
      .catch(() => undefined)
      .then(() => this.writeFile(this.filePath, value));
    try {
      await this.writeChain;
    } catch (error) {
      this.dirty = true;
      throw error;
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      await this.writeChain;
      return;
    }
    this.disposed = true;
    await this.flush();
  }

  private load(readFile: (filePath: string) => string): void {
    try {
      const parsed = WorkspaceSidebarStatusCacheFileSchema.safeParse(
        JSON.parse(readFile(this.filePath)),
      );
      if (!parsed.success) {
        this.logger.warn({ issues: parsed.error.issues }, "Ignoring invalid sidebar status cache");
        return;
      }
      const now = this.now();
      for (const entry of parsed.data.entries) {
        if (now - entry.updatedAtMs <= WORKSPACE_SIDEBAR_STATUS_CACHE_MAX_AGE_MS) {
          this.entries.set(resolve(entry.cwd), { ...entry, cwd: resolve(entry.cwd) });
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.logger.warn({ err: error }, "Ignoring unreadable sidebar status cache");
      }
    }
  }

  private scheduleWrite(): void {
    if (this.disposed) {
      return;
    }
    this.dirty = true;
    if (this.writeTimer) {
      return;
    }
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      void this.flush().catch((error) => {
        this.logger.warn({ err: error }, "Failed to persist sidebar status cache");
      });
    }, WORKSPACE_SIDEBAR_STATUS_CACHE_WRITE_DELAY_MS);
  }
}
