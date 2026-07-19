import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  openNativeEngine,
  parseNativeResults,
  type NativeChangesInput,
  type NativeRecallEngine,
  type NativeSearchResult,
  type NativeSessionInput,
  type NativeTagInput,
} from "./native-binding.js";
import { parseSessionFile } from "./session-parser.js";
import { displayTags, normalizeTag, TagStore, type SessionTags } from "./tag-store.js";
import type {
  CachedFileState,
  ParsedSession,
  RecallIndexOptions,
  RecallSearchResult,
  SearchOptions,
  SessionSummary,
  SyncProgress,
  SyncResult,
} from "./types.js";

const CACHE_VERSION = 3;
const DEFAULT_CONCURRENCY = 8;
const DEFAULT_LIMIT = 10;

interface PersistedCache {
  version: number;
  tagRevision: string;
  files: Array<[string, CachedFileState]>;
}

interface SessionFileMetadata {
  path: string;
  mtimeMs: number;
  size: number;
}

interface ParsedFileResult {
  metadata: SessionFileMetadata;
  parsed?: ParsedSession;
  error?: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isPersistedCache(value: unknown): value is PersistedCache {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { version?: unknown; files?: unknown };
  return (
    candidate.version === CACHE_VERSION &&
    typeof (candidate as { tagRevision?: unknown }).tagRevision === "string" &&
    Array.isArray(candidate.files)
  );
}

function pathKey(path: string): string {
  const normalized = resolve(path);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function samePath(left: string, right: string): boolean {
  return pathKey(left) === pathKey(right);
}

export function parseTagQuery(query: string): { text: string; requiredTags: string[] } {
  const requiredTags: string[] = [];
  const text = query
    .replace(/(^|\s)#([\p{L}\p{N}_-]+)/gu, (_match, prefix: string, value: string) => {
      const normalized = normalizeTag(value);
      if (normalized) requiredTags.push(normalized);
      return prefix;
    })
    .replace(/\s+/g, " ")
    .trim();
  return { text, requiredTags: [...new Set(requiredTags)] };
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;

  const worker = async (): Promise<void> => {
    while (nextIndex < values.length) {
      const index = nextIndex++;
      results[index] = await mapper(values[index]!, index);
    }
  };

  const workers = Array.from({ length: Math.min(Math.max(1, concurrency), values.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

export async function discoverSessionFiles(agentDir: string): Promise<string[]> {
  const root = join(agentDir, "sessions");
  const pending = [root];
  const files: string[] = [];

  while (pending.length > 0) {
    const directory = pending.pop()!;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") continue;
      throw error;
    }

    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(path);
    }
  }

  files.sort();
  return files;
}

function toNativeSession(parsed: ParsedSession, tags: string[]): NativeSessionInput {
  return {
    id: parsed.summary.id,
    path: parsed.summary.path,
    cwd: parsed.summary.cwd,
    timestamp: parsed.summary.modified,
    tags,
    messages: parsed.documents.map((document) => ({
      role: document.role,
      content: document.content,
      timestamp: document.timestamp,
      entryId: document.entryId,
      messageIndex: document.messageIndex,
    })),
  };
}

export class RecallIndex {
  private readonly files: Map<string, CachedFileState>;
  private readonly native: NativeRecallEngine;
  private readonly agentDir: string;
  private readonly cacheFile: string;
  private readonly concurrency: number;
  private readonly tagStore: TagStore;
  private syncPromise: Promise<SyncResult> | undefined;

  private constructor(
    options: RecallIndexOptions,
    native: NativeRecallEngine,
    files: Map<string, CachedFileState>,
    tagStore: TagStore,
  ) {
    this.agentDir = options.agentDir;
    this.cacheFile = options.cacheFile ?? join(options.agentDir, "cache", "pi-recall-v3.json");
    this.concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
    this.native = native;
    this.files = files;
    this.tagStore = tagStore;
  }

  static async open(options: RecallIndexOptions): Promise<RecallIndex> {
    const cacheFile = options.cacheFile ?? join(options.agentDir, "cache", "pi-recall-v3.json");
    const indexDir = options.indexDir ?? join(options.agentDir, "cache", "pi-recall-tantivy-v2");
    const tagFile = options.tagFile ?? join(options.agentDir, "pi-recall", "tags-v1.json");
    const tagStore = await TagStore.open(tagFile);
    let files = new Map<string, CachedFileState>();
    let cacheValid = false;
    let cachedTagRevision: string | undefined;
    try {
      const serialized = await readFile(cacheFile, "utf8");
      const cache: unknown = JSON.parse(serialized);
      if (!isPersistedCache(cache)) throw new Error("Unsupported cache format");
      files = new Map(cache.files);
      cachedTagRevision = cache.tagRevision;
      cacheValid = true;
    } catch {
      // Missing, stale, or corrupt state is rebuilt from Pi's session files below.
    }

    let native: NativeRecallEngine;
    try {
      native = openNativeEngine(indexDir);
    } catch {
      await rm(indexDir, { recursive: true, force: true });
      native = openNativeEngine(indexDir);
      cacheValid = false;
    }

    const expectedDocuments = [...files.values()].reduce(
      (count, state) => count + state.summary.messageCount + (tagStore.isUntagged(state.summary.id) ? 0 : 1),
      0,
    );
    if (!cacheValid || native.documentCount() !== expectedDocuments) {
      native.reset();
      files.clear();
    }

    const recallIndex = new RecallIndex({ ...options, cacheFile, indexDir, tagFile }, native, files, tagStore);
    if (files.size > 0 && cachedTagRevision !== tagStore.revision()) {
      recallIndex.reconcileNativeTags();
      await recallIndex.save();
    }
    return recallIndex;
  }

  get documentCount(): number {
    return this.native.documentCount();
  }

  get sessionCount(): number {
    return this.files.size;
  }

  get tagFile(): string {
    return this.tagStore.path;
  }

  countSessions(options: Pick<SearchOptions, "cwd" | "scope"> = {}): number {
    let count = 0;
    for (const state of this.files.values()) {
      if (state.summary.messageCount > 0 && this.inScope(state.summary, options)) count++;
    }
    return count;
  }

  async sync(onProgress?: (progress: SyncProgress) => void, force = false): Promise<SyncResult> {
    if (this.syncPromise) return this.syncPromise;
    this.syncPromise = this.runSync(onProgress, force).finally(() => {
      this.syncPromise = undefined;
    });
    return this.syncPromise;
  }

  private async runSync(onProgress?: (progress: SyncProgress) => void, force = false): Promise<SyncResult> {
    const discoveredPaths = await discoverSessionFiles(this.agentDir);
    const metadataResults = await mapWithConcurrency(discoveredPaths, this.concurrency, async (path) => {
      try {
        const metadata = await stat(path);
        return { path, mtimeMs: metadata.mtimeMs, size: metadata.size } satisfies SessionFileMetadata;
      } catch {
        return undefined;
      }
    });
    const metadata = metadataResults.filter((item): item is SessionFileMetadata => item !== undefined);
    const discoveredSet = new Set(metadata.map((item) => item.path));
    const removedPaths = [...this.files.keys()].filter((path) => !discoveredSet.has(path));

    const changed = metadata.filter((item) => {
      if (force) return true;
      const cached = this.files.get(item.path);
      return !cached || cached.mtimeMs !== item.mtimeMs || cached.size !== item.size;
    });

    let completed = 0;
    const parsed = await mapWithConcurrency(changed, this.concurrency, async (item): Promise<ParsedFileResult> => {
      try {
        return { metadata: item, parsed: await parseSessionFile(item.path) };
      } catch (error) {
        return { metadata: item, error: errorMessage(error) };
      } finally {
        completed++;
        onProgress?.({ indexed: completed, total: changed.length });
      }
    });

    const failed: Array<{ path: string; error: string }> = [];
    const successful: Array<{ metadata: SessionFileMetadata; parsed: ParsedSession }> = [];
    for (const result of parsed) {
      if (!result.parsed) {
        failed.push({ path: result.metadata.path, error: result.error ?? "Unknown parse error" });
      } else {
        successful.push({ metadata: result.metadata, parsed: result.parsed });
      }
    }

    if (changed.length > 0 || removedPaths.length > 0 || force) {
      const changes: NativeChangesInput = {
        // Delete a changed file's old documents before inserting its replacement.
        // Including every changed path also keeps parse failures out of the index.
        deletePaths: [...new Set([...removedPaths, ...changed.map((item) => item.path)])],
        upserts: successful.map((result) =>
          toNativeSession(result.parsed, this.tagStore.all(result.parsed.summary.id)),
        ),
      };
      this.native.applyChanges(JSON.stringify(changes));

      for (const path of removedPaths) this.files.delete(path);
      for (const result of successful) {
        this.files.set(result.metadata.path, {
          mtimeMs: result.metadata.mtimeMs,
          size: result.metadata.size,
          summary: result.parsed.summary,
        });
      }
      await this.save();
    }

    return {
      discovered: metadata.length,
      indexed: successful.length,
      removed: removedPaths.length,
      failed,
    };
  }

  private async save(): Promise<void> {
    const cache: PersistedCache = {
      version: CACHE_VERSION,
      tagRevision: this.tagStore.revision(),
      files: [...this.files.entries()],
    };
    const temporary = `${this.cacheFile}.${process.pid}.${Date.now()}.tmp`;
    await mkdir(dirname(this.cacheFile), { recursive: true });
    try {
      await writeFile(temporary, JSON.stringify(cache));
      try {
        await rename(temporary, this.cacheFile);
      } catch (error) {
        if (process.platform !== "win32") throw error;
        await rm(this.cacheFile, { force: true });
        await rename(temporary, this.cacheFile);
      }
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async rebuild(onProgress?: (progress: SyncProgress) => void): Promise<SyncResult> {
    if (this.syncPromise) await this.syncPromise;
    this.native.reset();
    this.files.clear();
    await rm(this.cacheFile, { force: true });
    return this.sync(onProgress, true);
  }

  list(options: SearchOptions = {}): SessionSummary[] {
    const limit = options.limit ?? DEFAULT_LIMIT;
    return [...this.files.values()]
      .map((state) => this.withTags(state.summary))
      .filter((session) => session.messageCount > 0 && this.inScope(session, options))
      .sort((left, right) => right.modified - left.modified)
      .slice(0, limit);
  }

  search(query: string, options: SearchOptions = {}): RecallSearchResult[] {
    const trimmed = query.trim();
    if (!trimmed) {
      return this.list(options).map((session) => ({ session, score: 0, matches: [], tags: session.tags ?? [] }));
    }

    const limit = options.limit ?? DEFAULT_LIMIT;
    const parsedQuery = parseTagQuery(trimmed);
    if (!parsedQuery.text) {
      return this.list({ ...options, limit: this.sessionCount })
        .filter((session) => this.tagStore.hasAll(session.id, parsedQuery.requiredTags))
        .slice(0, limit)
        .map((session) => this.tagOnlyResult(session));
    }

    const constrained = parsedQuery.requiredTags.length > 0 || options.scope === "current";
    const allowedSessionIds = constrained
      ? [...this.files.values()]
          .map((state) => state.summary)
          .filter((session) => this.inScope(session, options))
          .filter((session) => this.tagStore.hasAll(session.id, parsedQuery.requiredTags))
          .map((session) => session.id)
      : undefined;
    if (allowedSessionIds?.length === 0) return [];
    const nativeResults = parseNativeResults(
      this.native.search(parsedQuery.text, limit, allowedSessionIds ? JSON.stringify(allowedSessionIds) : undefined),
    );
    return nativeResults
      .map((result) => this.toSearchResult(result))
      .filter((result): result is RecallSearchResult => result !== undefined)
      .filter((result) => this.inScope(result.session, options))
      .filter((result) => this.tagStore.hasAll(result.session.id, parsedQuery.requiredTags))
      .slice(0, limit);
  }

  private toSearchResult(result: NativeSearchResult): RecallSearchResult | undefined {
    const state = this.files.get(result.path);
    if (!state || (result.role !== "user" && result.role !== "assistant" && result.role !== "tag")) return undefined;
    const tags = this.tagStore.all(state.summary.id);
    return {
      session: this.withTags(state.summary),
      score: result.score,
      tags,
      matches: [
        {
          role: result.role,
          content: result.snippet,
          snippet: result.snippet,
          timestamp: result.messageTimestamp,
          entryId: result.entryId,
          score: result.score,
          terms: [],
          messageIndex: result.matchedMessageIndex,
          matchSpans: result.matchSpans,
        },
      ],
    };
  }

  private tagOnlyResult(session: SessionSummary): RecallSearchResult {
    const tags = this.tagStore.all(session.id);
    return {
      session: this.withTags(session),
      score: 0,
      tags,
      matches: [
        {
          role: "tag",
          content: displayTags(tags),
          snippet: displayTags(tags),
          timestamp: session.modified,
          entryId: "",
          score: 0,
          terms: [],
          messageIndex: 0,
          matchSpans: [],
        },
      ],
    };
  }

  private withTags(session: SessionSummary): SessionSummary {
    return { ...session, tags: this.tagStore.all(session.id) };
  }

  getTags(reference: string): SessionTags {
    const session = this.resolveSession(reference);
    return this.tagStore.get(session.id);
  }

  async addManualTags(reference: string, tags: string[]): Promise<SessionTags> {
    const session = this.resolveSession(reference);
    const updated = await this.tagStore.addManual(session.id, tags);
    this.applyNativeTags(session);
    await this.save();
    return updated;
  }

  async removeTags(reference: string, tags: string[]): Promise<SessionTags> {
    const session = this.resolveSession(reference);
    const updated = await this.tagStore.remove(session.id, tags);
    this.applyNativeTags(session);
    await this.save();
    return updated;
  }

  async setAutoTags(reference: string, tags: string[]): Promise<SessionTags> {
    const session = this.resolveSession(reference);
    const updated = await this.tagStore.setAuto(session.id, tags);
    this.applyNativeTags(session);
    await this.save();
    return updated;
  }

  untaggedSessions(options: Pick<SearchOptions, "cwd" | "scope"> = {}): SessionSummary[] {
    return this.list({ ...options, limit: this.sessionCount }).filter((session) => this.tagStore.isUntagged(session.id));
  }

  private nativeTagInput(session: SessionSummary): NativeTagInput {
    return {
      sessionId: session.id,
      path: session.path,
      cwd: session.cwd,
      timestamp: session.modified,
      tags: this.tagStore.all(session.id),
    };
  }

  private applyNativeTags(session: SessionSummary): void {
    this.native.applyTagChanges(JSON.stringify([this.nativeTagInput(session)]));
  }

  private reconcileNativeTags(): void {
    const changes = [...this.files.values()].map((state) => this.nativeTagInput(state.summary));
    this.native.applyTagChanges(JSON.stringify(changes));
  }

  private inScope(session: SessionSummary, options: SearchOptions): boolean {
    if (options.scope !== "current" || !options.cwd) return true;
    return samePath(session.cwd, options.cwd);
  }

  resolveSession(reference: string): SessionSummary {
    const trimmed = reference.trim();
    if (!trimmed) throw new Error("Session reference is required");
    const candidates = [...this.files.values()]
      .map((state) => state.summary)
      .filter(
        (session) =>
          session.path === trimmed ||
          session.id === trimmed ||
          session.id.startsWith(trimmed) ||
          session.path.endsWith(trimmed),
      );

    if (candidates.length === 0) throw new Error(`Session not found: ${reference}`);
    const exact = candidates.find((session) => session.path === trimmed || session.id === trimmed);
    if (exact) return this.withTags(exact);
    if (candidates.length > 1) throw new Error(`Ambiguous session reference: ${reference}`);
    return this.withTags(candidates[0]!);
  }

  async readSession(reference: string): Promise<ParsedSession> {
    const session = this.resolveSession(reference);
    const parsed = await parseSessionFile(session.path);
    return { ...parsed, summary: this.withTags(parsed.summary) };
  }
}
