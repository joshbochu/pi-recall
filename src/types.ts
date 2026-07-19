export type RecallScope = "current" | "all";

export type RecallRole = "user" | "assistant";

export interface IndexedMessage {
  id: string;
  sessionId: string;
  sessionPath: string;
  sessionName: string;
  cwd: string;
  role: RecallRole;
  content: string;
  timestamp: number;
  entryId: string;
  messageIndex: number;
}

export interface SessionSummary {
  id: string;
  path: string;
  cwd: string;
  name?: string;
  created: number;
  modified: number;
  messageCount: number;
  firstMessage: string;
  parentSessionPath?: string;
  tags?: string[];
}

export interface ParsedSession {
  summary: SessionSummary;
  documents: IndexedMessage[];
}

export interface CachedFileState {
  mtimeMs: number;
  size: number;
  summary: SessionSummary;
}

export interface RecallMatch {
  role: RecallRole | "tag";
  content: string;
  snippet: string;
  timestamp: number;
  entryId: string;
  score: number;
  terms: string[];
  messageIndex: number;
  matchSpans: Array<[number, number]>;
}

export interface RecallSearchResult {
  session: SessionSummary;
  score: number;
  matches: RecallMatch[];
  tags: string[];
}

export interface SyncProgress {
  indexed: number;
  total: number;
}

export interface SyncResult {
  discovered: number;
  indexed: number;
  removed: number;
  failed: Array<{ path: string; error: string }>;
}

export interface SearchOptions {
  cwd?: string;
  scope?: RecallScope;
  limit?: number;
  matchesPerSession?: number;
}

export interface RecallIndexOptions {
  agentDir: string;
  cacheFile?: string;
  indexDir?: string;
  tagFile?: string;
  concurrency?: number;
}
