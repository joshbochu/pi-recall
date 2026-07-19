import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const TAG_STORE_VERSION = 1;
const MAX_TAG_LENGTH = 40;

export interface SessionTags {
  manualTags: string[];
  autoTags: string[];
  suppressedTags: string[];
  updatedAt: number;
}

interface PersistedTagStore {
  version: number;
  sessions: Record<string, SessionTags>;
}

function emptyTags(): SessionTags {
  return { manualTags: [], autoTags: [], suppressedTags: [], updatedAt: 0 };
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isSessionTags(value: unknown): value is SessionTags {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<SessionTags>;
  return (
    isStringArray(candidate.manualTags) &&
    isStringArray(candidate.autoTags) &&
    isStringArray(candidate.suppressedTags) &&
    typeof candidate.updatedAt === "number"
  );
}

function parseStore(value: unknown): Map<string, SessionTags> {
  if (!value || typeof value !== "object") throw new Error("Invalid Recall tag store");
  const candidate = value as Partial<PersistedTagStore>;
  if (candidate.version !== TAG_STORE_VERSION || !candidate.sessions || typeof candidate.sessions !== "object") {
    throw new Error("Unsupported Recall tag store format");
  }

  const sessions = new Map<string, SessionTags>();
  for (const [sessionId, tags] of Object.entries(candidate.sessions)) {
    if (!isSessionTags(tags)) throw new Error(`Invalid tags for session ${sessionId}`);
    sessions.set(sessionId, {
      manualTags: unique(tags.manualTags.map(normalizeTag).filter(Boolean)),
      autoTags: unique(tags.autoTags.map(normalizeTag).filter(Boolean)),
      suppressedTags: unique(tags.suppressedTags.map(normalizeTag).filter(Boolean)),
      updatedAt: tags.updatedAt,
    });
  }
  return sessions;
}

export function normalizeTag(value: string): string {
  return value
    .trim()
    .replace(/^#+/, "")
    .toLocaleLowerCase()
    .replace(/[\s/]+/gu, "-")
    .replace(/[^\p{L}\p{N}_-]+/gu, "")
    .replace(/-{2,}/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, MAX_TAG_LENGTH);
}

export function parseTags(value: string): string[] {
  return unique(value.split(/[\s,]+/u).map(normalizeTag).filter(Boolean));
}

export function displayTags(tags: string[]): string {
  return tags.map((tag) => `#${tag}`).join(" ");
}

export class TagStore {
  private readonly sessions: Map<string, SessionTags>;
  readonly path: string;

  private constructor(
    path: string,
    sessions: Map<string, SessionTags>,
  ) {
    this.path = path;
    this.sessions = sessions;
  }

  static async open(path: string): Promise<TagStore> {
    try {
      const serialized = await readFile(path, "utf8");
      return new TagStore(path, parseStore(JSON.parse(serialized) as unknown));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return new TagStore(path, new Map());
      throw new Error(`Unable to read Recall tags at ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  get(sessionId: string): SessionTags {
    const tags = this.sessions.get(sessionId);
    return tags
      ? {
          manualTags: [...tags.manualTags],
          autoTags: [...tags.autoTags],
          suppressedTags: [...tags.suppressedTags],
          updatedAt: tags.updatedAt,
        }
      : emptyTags();
  }

  all(sessionId: string): string[] {
    const tags = this.sessions.get(sessionId);
    return tags ? unique([...tags.manualTags, ...tags.autoTags]) : [];
  }

  hasAll(sessionId: string, requiredTags: string[]): boolean {
    if (requiredTags.length === 0) return true;
    const tags = new Set(this.all(sessionId));
    return requiredTags.every((tag) => tags.has(normalizeTag(tag)));
  }

  isUntagged(sessionId: string): boolean {
    return this.all(sessionId).length === 0;
  }

  taggedSessionCount(sessionIds?: Iterable<string>): number {
    if (!sessionIds) return [...this.sessions.keys()].filter((id) => this.all(id).length > 0).length;
    let count = 0;
    for (const sessionId of sessionIds) {
      if (!this.isUntagged(sessionId)) count++;
    }
    return count;
  }

  revision(): string {
    const entries = [...this.sessions.entries()].sort(([left], [right]) => left.localeCompare(right));
    return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
  }

  async addManual(sessionId: string, values: string[]): Promise<SessionTags> {
    const additions = unique(values.map(normalizeTag).filter(Boolean));
    const current = this.get(sessionId);
    const additionSet = new Set(additions);
    const next: SessionTags = {
      manualTags: unique([...current.manualTags, ...additions]),
      autoTags: current.autoTags.filter((tag) => !additionSet.has(tag)),
      suppressedTags: current.suppressedTags.filter((tag) => !additionSet.has(tag)),
      updatedAt: Date.now(),
    };
    await this.set(sessionId, next);
    return this.get(sessionId);
  }

  async remove(sessionId: string, values: string[]): Promise<SessionTags> {
    const removals = new Set(values.map(normalizeTag).filter(Boolean));
    const current = this.get(sessionId);
    const next: SessionTags = {
      manualTags: current.manualTags.filter((tag) => !removals.has(tag)),
      autoTags: current.autoTags.filter((tag) => !removals.has(tag)),
      suppressedTags: unique([...current.suppressedTags, ...removals]),
      updatedAt: Date.now(),
    };
    await this.set(sessionId, next);
    return this.get(sessionId);
  }

  async setAuto(sessionId: string, values: string[]): Promise<SessionTags> {
    const current = this.get(sessionId);
    const manual = new Set(current.manualTags);
    const suppressed = new Set(current.suppressedTags);
    const autoTags = unique(values.map(normalizeTag).filter((tag) => tag && !manual.has(tag) && !suppressed.has(tag)));
    const next: SessionTags = { ...current, autoTags, updatedAt: Date.now() };
    await this.set(sessionId, next);
    return this.get(sessionId);
  }

  private async set(sessionId: string, value: SessionTags): Promise<void> {
    if (value.manualTags.length === 0 && value.autoTags.length === 0 && value.suppressedTags.length === 0) {
      this.sessions.delete(sessionId);
    } else {
      this.sessions.set(sessionId, value);
    }
    await this.save();
  }

  private async save(): Promise<void> {
    const sessions = Object.fromEntries([...this.sessions.entries()].sort(([left], [right]) => left.localeCompare(right)));
    const serialized = `${JSON.stringify({ version: TAG_STORE_VERSION, sessions }, null, 2)}\n`;
    const temporary = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    await mkdir(dirname(this.path), { recursive: true });
    try {
      await writeFile(temporary, serialized);
      try {
        await rename(temporary, this.path);
      } catch (error) {
        if (process.platform !== "win32") throw error;
        await rm(this.path, { force: true });
        await rename(temporary, this.path);
      }
    } finally {
      await rm(temporary, { force: true });
    }
  }
}
