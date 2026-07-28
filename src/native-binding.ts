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
  search(
    query: string,
    limit: number,
    allowedSessionIdsJson?: string,
    prefixLastToken?: boolean,
  ): string;
}

interface NativeBinding {
  RecallNative: new (indexPath: string) => NativeRecallEngine;
}

function isNativeBinding(value: unknown): value is NativeBinding {
  if (!value || typeof value !== "object") return false;
  return typeof (value as { RecallNative?: unknown }).RecallNative === "function";
}

/**
 * Platform key for bundled prebuilt addons, matching napi-rs naming.
 * Exported for tests; `libc` distinguishes glibc from musl on Linux.
 */
export function nativeTarget(
  platform: string = process.platform,
  arch: string = process.arch,
  libc: "glibc" | "musl" = detectLibc(),
): string {
  if (platform === "win32") return `win32-${arch}-msvc`;
  if (platform === "linux") return `linux-${arch}-${libc === "musl" ? "musl" : "gnu"}`;
  return `${platform}-${arch}`;
}

function detectLibc(): "glibc" | "musl" {
  if (process.platform !== "linux") return "glibc";
  const report = process.report?.getReport?.();
  const header = (report as { header?: { glibcVersionRuntime?: string } } | undefined)?.header;
  return header?.glibcVersionRuntime ? "glibc" : "musl";
}

export function prebuiltPackageName(target: string = nativeTarget()): string {
  return `@joshbochu/pi-recall-native-${target}`;
}

export function bundledPrebuiltPath(target: string = nativeTarget()): string {
  return fileURLToPath(
    new URL(`../native/prebuilds/${target}/pi-recall-native.node`, import.meta.url),
  );
}

/**
 * Load the addon: the prebuilt bundled in the root package first, then a
 * separately installed legacy platform package, then a local
 * `npm run build:native` result.
 */
export function openNativeEngine(indexPath: string): NativeRecallEngine {
  const require = createRequire(import.meta.url);
  const prebuilt = prebuiltPackageName();
  const bundledPath = bundledPrebuiltPath();
  const localPath = fileURLToPath(new URL("../native/pi-recall-native-v2.node", import.meta.url));
  const attempts: string[] = [];

  for (const candidate of [bundledPath, prebuilt, localPath]) {
    let binding: unknown;
    try {
      binding = require(candidate);
    } catch (error) {
      attempts.push(`${candidate}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
      continue;
    }
    if (!isNativeBinding(binding)) throw new Error(`Invalid pi-recall native binding: ${candidate}`);
    return new binding.RecallNative(indexPath);
  }

  throw new Error(
    `Unable to load the pi-recall native addon for ${nativeTarget()}. Run "npm run build:native" (needs Rust). Tried:\n  ${attempts.join("\n  ")}`,
  );
}

export function parseNativeResults(json: string): NativeSearchResult[] {
  const value: unknown = JSON.parse(json);
  if (!Array.isArray(value)) throw new Error("Invalid search response from pi-recall native binding");
  return value as NativeSearchResult[];
}
