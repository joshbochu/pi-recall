import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import {
  migrateSessionEntries,
  parseSessionEntries,
  type FileEntry,
  type SessionHeader,
  type SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";
import type { IndexedMessage, ParsedSession, RecallRole, SessionSummary } from "./types.js";

const MAX_TITLE_CHARS = 160;

function singleLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function truncate(text: string, length: number): string {
  if (text.length <= length) return text;
  return `${text.slice(0, Math.max(0, length - 1)).trimEnd()}…`;
}

function extractText(message: SessionMessageEntry["message"]): string {
  if (message.role !== "user" && message.role !== "assistant") return "";
  if (typeof message.content === "string") return message.content.trim();
  if (!Array.isArray(message.content)) return "";

  const text = message.content
    .flatMap((block) => (block.type === "text" && typeof block.text === "string" ? [block.text] : []))
    .join("\n")
    .trim();

  return text;
}

function getHeader(entries: FileEntry[], path: string): SessionHeader {
  const header = entries.find((entry): entry is SessionHeader => entry.type === "session");
  if (header) return header;

  return {
    type: "session",
    version: 3,
    id: basename(path, ".jsonl"),
    timestamp: new Date(0).toISOString(),
    cwd: "",
  };
}

function timestampOf(entry: SessionMessageEntry, fallback: number): number {
  const messageTimestamp = entry.message.timestamp;
  if (typeof messageTimestamp === "number" && Number.isFinite(messageTimestamp)) return messageTimestamp;
  const parsed = Date.parse(entry.timestamp);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function joinConsecutiveMessages(documents: IndexedMessage[]): IndexedMessage[] {
  const joined: IndexedMessage[] = [];
  for (const document of documents) {
    const previous = joined.at(-1);
    if (previous?.role === document.role) {
      previous.content += `\n\n${document.content}`;
      previous.timestamp = document.timestamp;
      previous.entryId = document.entryId;
      continue;
    }
    joined.push({ ...document });
  }
  for (let index = 0; index < joined.length; index++) joined[index]!.messageIndex = index;
  return joined;
}

export function parseSessionContent(path: string, content: string, modified: number): ParsedSession {
  const entries = parseSessionEntries(content);
  migrateSessionEntries(entries);
  const header = getHeader(entries, path);

  let sessionName: string | undefined;
  for (const entry of entries) {
    if (entry.type === "session_info") {
      sessionName = entry.name?.trim() || undefined;
    }
  }

  const rawDocuments: IndexedMessage[] = [];

  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const role = entry.message.role;
    if (role !== "user" && role !== "assistant") continue;

    const contentText = extractText(entry.message);
    if (!contentText) continue;
    rawDocuments.push({
      id: `${path}#${entry.id}`,
      sessionId: header.id,
      sessionPath: path,
      sessionName: sessionName ?? "",
      cwd: header.cwd ?? "",
      role: role satisfies RecallRole,
      content: contentText,
      timestamp: timestampOf(entry, modified),
      entryId: entry.id,
      messageIndex: 0,
    });
  }

  const documents = joinConsecutiveMessages(rawDocuments);
  const firstUserMessage = documents.find((document) => document.role === "user")?.content ?? "";
  const firstMessage = truncate(singleLine(firstUserMessage), MAX_TITLE_CHARS);
  const latestMessageTimestamp = documents.reduce(
    (latest, document) => Math.max(latest, document.timestamp),
    0,
  );

  const created = Date.parse(header.timestamp);
  const summary: SessionSummary = {
    id: header.id,
    path,
    cwd: header.cwd ?? "",
    ...(sessionName ? { name: sessionName } : {}),
    created: Number.isFinite(created) ? created : modified,
    modified: latestMessageTimestamp || modified,
    messageCount: documents.length,
    firstMessage,
    ...(header.parentSession ? { parentSessionPath: header.parentSession } : {}),
  };

  return { summary, documents };
}

export async function parseSessionFile(path: string): Promise<ParsedSession> {
  const [content, metadata] = await Promise.all([readFile(path, "utf8"), stat(path)]);
  return parseSessionContent(path, content, metadata.mtimeMs);
}
