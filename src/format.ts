import type { ParsedSession, RecallSearchResult, SessionSummary } from "./types.js";

function iso(timestamp: number): string {
  return timestamp > 0 ? new Date(timestamp).toISOString() : "unknown";
}

function clean(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function clipped(text: string, limit: number): string {
  const normalized = clean(text);
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

export function formatSessionSummary(session: SessionSummary): string {
  const title = session.name || session.firstMessage || "Untitled session";
  const lines = [
    `${title}`,
    `id: ${session.id}`,
    `cwd: ${session.cwd || "unknown"}`,
    `updated: ${iso(session.modified)}`,
    `messages: ${session.messageCount}`,
  ];
  if (session.tags?.length) lines.push(`tags: ${session.tags.map((tag) => `#${tag}`).join(" ")}`);
  lines.push(`path: ${session.path}`);
  return lines.join("\n");
}

export function formatSearchResults(query: string, results: RecallSearchResult[]): string {
  if (results.length === 0) return `No Pi sessions matched: ${query}`;

  const blocks = results.map((result, index) => {
    const session = formatSessionSummary(result.session);
    const matches = result.matches
      .map(
        (match) =>
          `  - ${match.role} @ ${iso(match.timestamp)} (entry ${match.entryId}): ${clipped(match.snippet, 800)}`,
      )
      .join("\n");
    return `${index + 1}. ${session.replace(/\n/g, "\n   ")}\n   matches:\n${matches || "  - metadata match"}`;
  });

  return `Pi session search: ${query}\n\n${blocks.join("\n\n")}`;
}

export function formatSessionList(sessions: SessionSummary[]): string {
  if (sessions.length === 0) return "No Pi sessions found.";
  return sessions
    .map((session, index) => `${index + 1}. ${formatSessionSummary(session).replace(/\n/g, "\n   ")}`)
    .join("\n\n");
}

export function formatReadSession(parsed: ParsedSession, limit: number): string {
  const documents = limit > 0 ? parsed.documents.slice(-limit) : parsed.documents;
  const omitted = parsed.documents.length - documents.length;
  const messages = documents
    .map(
      (document, index) =>
        `${index + 1 + omitted}. [${document.role} @ ${iso(document.timestamp)}; entry ${document.entryId}]\n${clipped(document.content, 4_000)}`,
    )
    .join("\n\n");
  const omission = omitted > 0 ? `\nShowing the last ${documents.length} of ${parsed.documents.length} indexed messages.\n` : "";
  return `${formatSessionSummary(parsed.summary)}\n${omission}\n${messages}`;
}
