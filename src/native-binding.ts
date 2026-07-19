import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

export interface NativeMessageInput {
  role: "user" | "assistant";
  content: string;
  timestamp: number;
  entryId: string;
  messageIndex: number;
}

export interface NativeSessionInput {
  id: string;
  path: string;
  cwd: string;
  timestamp: number;
  tags: string[];
  messages: NativeMessageInput[];
}

export interface NativeTagInput {
  sessionId: string;
  path: string;
  cwd: string;
  timestamp: number;
  tags: string[];
}

export interface NativeChangesInput {
  deletePaths: string[];
  upserts: NativeSessionInput[];
}

export interface NativeSearchResult {
  sessionId: string;
  path: string;
  cwd: string;
  sessionTimestamp: number;
  score: number;
  matchedMessageIndex: number;
  role: string;
  messageTimestamp: number;
  entryId: string;
  snippet: string;
  matchSpans: Array<[number, number]>;
  tags: string[];
}

export interface NativeRecallEngine {
  applyChanges(changesJson: string): void;
  applyTagChanges(changesJson: string): void;
  reset(): void;
  documentCount(): number;
  search(query: string, limit: number, allowedSessionIdsJson?: string): string;
  recent(limit: number): string;
  indexPath(): string;
}

interface NativeBinding {
  RecallNative: new (indexPath: string) => NativeRecallEngine;
}

function isNativeBinding(value: unknown): value is NativeBinding {
  if (!value || typeof value !== "object") return false;
  return typeof (value as { RecallNative?: unknown }).RecallNative === "function";
}

export function openNativeEngine(indexPath: string): NativeRecallEngine {
  const require = createRequire(import.meta.url);
  const bindingPath = fileURLToPath(new URL("../native/pi-recall-native-v2.node", import.meta.url));
  const binding: unknown = require(bindingPath);
  if (!isNativeBinding(binding)) throw new Error(`Invalid pi-recall native binding: ${bindingPath}`);
  return new binding.RecallNative(indexPath);
}

export function parseNativeResults(json: string): NativeSearchResult[] {
  const value: unknown = JSON.parse(json);
  if (!Array.isArray(value)) throw new Error("Invalid search response from pi-recall native binding");
  return value as NativeSearchResult[];
}
