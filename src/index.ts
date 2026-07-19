import { join, resolve } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import {
  BorderedLoader,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  getAgentDir,
  truncateHead,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { formatReadSession, formatSearchResults, formatSessionList } from "./format.js";
import {
  generateSessionTags,
  loadAutoTagConfig,
  modelLabel,
  resolveAutoTagModel,
} from "./auto-tag.js";
import { RecallIndex } from "./recall-index.js";
import { RecallPicker } from "./recall-picker.js";
import { displayTags, parseTags, type SessionTags } from "./tag-store.js";
import type { RecallScope, SyncProgress } from "./types.js";

const TOOL_OUTPUT_LINES = Math.min(DEFAULT_MAX_LINES, 800);
const TOOL_OUTPUT_BYTES = Math.min(DEFAULT_MAX_BYTES, 40_000);

interface RecallPaths {
  cacheFile?: string;
  indexDir?: string;
  tagFile: string;
  configFile: string;
}

function getRecallPaths(agentDir: string): RecallPaths {
  const cacheDir = process.env.PI_RECALL_CACHE_DIR?.trim();
  const dataDir = resolve(process.env.PI_RECALL_DATA_DIR?.trim() || join(agentDir, "pi-recall"));
  return {
    cacheFile: cacheDir ? resolve(cacheDir, "state-v3.json") : undefined,
    indexDir: cacheDir ? resolve(cacheDir, "tantivy-v2") : undefined,
    tagFile: resolve(dataDir, "tags-v1.json"),
    configFile: resolve(process.env.PI_RECALL_CONFIG_FILE?.trim() || join(dataDir, "config.json")),
  };
}

function truncateToolOutput(output: string): string {
  const truncated = truncateHead(output, { maxLines: TOOL_OUTPUT_LINES, maxBytes: TOOL_OUTPUT_BYTES });
  if (!truncated.truncated) return output;
  return `${truncated.content}\n\n[Recall output truncated to ${truncated.outputLines} of ${truncated.totalLines} lines.]`;
}

function scopeOf(value: string | undefined, fallback: RecallScope): RecallScope {
  return value === "current" || value === "all" ? value : fallback;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatTagState(tags: SessionTags): string {
  const lines: string[] = [];
  if (tags.manualTags.length) lines.push(`Manual: ${displayTags(tags.manualTags)}`);
  if (tags.autoTags.length) lines.push(`Generated: ${displayTags(tags.autoTags)}`);
  return lines.length ? lines.join("\n") : "This session has no tags.";
}

async function withAutoTagLoader<T>(
  ctx: ExtensionContext,
  message: string,
  work: (signal: AbortSignal | undefined) => Promise<T>,
): Promise<{ value?: T; error?: string; cancelled: boolean }> {
  if (ctx.mode !== "tui") {
    try {
      return { value: await work(ctx.signal), cancelled: false };
    } catch (error) {
      return { error: errorMessage(error), cancelled: ctx.signal?.aborted ?? false };
    }
  }

  return ctx.ui.custom((tui, theme, _keybindings, done) => {
    const loader = new BorderedLoader(tui, theme, message, { cancellable: true });
    loader.onAbort = () => {
      ctx.ui.setStatus("pi-recall-tags", "Cancelling Recall auto-tagging…");
    };
    work(loader.signal)
      .then((value) => done({ value, cancelled: loader.signal.aborted }))
      .catch((error) => done({ error: errorMessage(error), cancelled: loader.signal.aborted }));
    return loader;
  });
}

export default function recallExtension(pi: ExtensionAPI) {
  let indexPromise: Promise<RecallIndex> | undefined;
  const agentDir = getAgentDir();
  const recallPaths = getRecallPaths(agentDir);

  const getIndex = (): Promise<RecallIndex> => {
    indexPromise ??= RecallIndex.open({
      agentDir,
      ...recallPaths,
    });
    return indexPromise;
  };

  const currentSessionReference = (ctx: ExtensionContext): string =>
    ctx.sessionManager.getSessionFile() || ctx.sessionManager.getSessionId();

  const runAutoTagCommand = async (
    allUntagged: boolean,
    ctx: ExtensionContext,
    index: RecallIndex,
  ): Promise<void> => {
    const config = await loadAutoTagConfig(recallPaths.configFile);
    const model = resolveAutoTagModel(ctx, config.model);
    const label = modelLabel(model);
    const sessions = allUntagged
      ? index.untaggedSessions({ scope: "all" })
      : [index.resolveSession(currentSessionReference(ctx))];

    if (sessions.length === 0) {
      if (ctx.hasUI) ctx.ui.notify("Every searchable session already has tags", "info");
      return;
    }

    if (allUntagged) {
      if (!ctx.hasUI) throw new Error("Batch auto-tagging requires an interactive confirmation");
      const noun = sessions.length === 1 ? "session" : "sessions";
      const confirmed = await ctx.ui.confirm(
        "Auto-tag sessions?",
        `This command will tag all ${sessions.length} currently untagged ${noun} using ${label}.\n\nSession excerpts will be sent to the model and usage charges may apply.`,
      );
      if (!confirmed) {
        ctx.ui.notify("Auto-tagging cancelled", "info");
        return;
      }
    }

    let completed = 0;
    let succeeded = 0;
    const failures: Array<{ id: string; error: string }> = [];
    const loaderMessage = allUntagged
      ? `Auto-tagging ${sessions.length} sessions using ${label}…`
      : `Auto-tagging this session using ${label}…`;
    const outcome = await withAutoTagLoader(ctx, loaderMessage, async (signal) => {
      for (const session of sessions) {
        if (signal?.aborted) break;
        try {
          const parsed = await index.readSession(session.id);
          const tags = await generateSessionTags(parsed, model, ctx, config, signal);
          if (signal?.aborted) break;
          await index.setAutoTags(session.id, tags);
          succeeded++;
        } catch (error) {
          if (signal?.aborted) break;
          failures.push({ id: session.id, error: errorMessage(error) });
        } finally {
          completed++;
          if (ctx.hasUI) {
            ctx.ui.setStatus(
              "pi-recall-tags",
              `Recall tags ${Math.min(completed, sessions.length)}/${sessions.length}`,
            );
          }
        }
      }
      return { completed: Math.min(completed, sessions.length), succeeded, failures };
    });
    if (ctx.hasUI) ctx.ui.setStatus("pi-recall-tags", undefined);

    if (outcome.cancelled) {
      if (ctx.hasUI) ctx.ui.notify(`Auto-tagging cancelled after ${succeeded} sessions`, "info");
      return;
    }
    if (outcome.error || !outcome.value) throw new Error(outcome.error || "Auto-tagging failed");

    const { failures: failed } = outcome.value;
    if (ctx.hasUI) {
      if (failed.length === 0) {
        const tags = allUntagged ? `${succeeded} sessions` : formatTagState(index.getTags(sessions[0]!.id));
        ctx.ui.notify(allUntagged ? `Auto-tagged ${tags}` : tags, "info");
      } else {
        ctx.ui.notify(`Auto-tagged ${succeeded}; ${failed.length} failed`, "warning");
      }
    }
  };

  const syncIndex = async (
    ctx: ExtensionContext,
    onProgress?: (progress: SyncProgress) => void,
    force = false,
  ): Promise<RecallIndex> => {
    const index = await getIndex();
    const progress = (value: SyncProgress): void => {
      onProgress?.(value);
      if (ctx.hasUI && value.total > 0) ctx.ui.setStatus("pi-recall", `Recall ${value.indexed}/${value.total}`);
    };
    try {
      if (force) await index.rebuild(progress);
      else await index.sync(progress);
      return index;
    } finally {
      if (ctx.hasUI) ctx.ui.setStatus("pi-recall", undefined);
    }
  };

  pi.registerCommand("recall", {
    description: "Search and resume any Pi session",
    handler: async (args, ctx) => {
      const index = await syncIndex(ctx);
      const trimmedArgs = args.trim();
      const [subcommand = "", ...rest] = trimmedArgs.split(/\s+/u);
      const commandArgs = rest.join(" ");

      if (subcommand === "tag") {
        const tags = parseTags(commandArgs);
        if (tags.length === 0) throw new Error("Usage: /recall tag #tag [#another-tag]");
        const updated = await index.addManualTags(currentSessionReference(ctx), tags);
        if (ctx.hasUI) ctx.ui.notify(formatTagState(updated), "info");
        return;
      }

      if (subcommand === "untag") {
        const tags = parseTags(commandArgs);
        if (tags.length === 0) throw new Error("Usage: /recall untag #tag [#another-tag]");
        const updated = await index.removeTags(currentSessionReference(ctx), tags);
        if (ctx.hasUI) ctx.ui.notify(formatTagState(updated), "info");
        return;
      }

      if (subcommand === "tags") {
        const tags = index.getTags(currentSessionReference(ctx));
        if (ctx.hasUI) ctx.ui.notify(formatTagState(tags), "info");
        return;
      }

      if (subcommand === "autotag") {
        const allUntagged = rest.includes("--all-untagged");
        const unexpected = rest.filter((arg) => arg !== "--all-untagged");
        if (unexpected.length) throw new Error("Usage: /recall autotag [--all-untagged]");
        await runAutoTagCommand(allUntagged, ctx, index);
        return;
      }

      const initialQuery = subcommand === "search" ? commandArgs : trimmedArgs;

      if (ctx.mode !== "tui") {
        const results = index.search(initialQuery, { cwd: ctx.cwd, scope: "current", limit: 20 });
        if (!ctx.hasUI) return;
        const labels = results.map((result, index) => {
          const title = result.session.name || result.session.firstMessage || result.session.id;
          return `${index + 1}. ${title} — ${result.session.cwd}`;
        });
        const selected = await ctx.ui.select("Recall a Pi session", labels);
        const selectedIndex = selected ? labels.indexOf(selected) : -1;
        if (selectedIndex >= 0) await ctx.switchSession(results[selectedIndex]!.session.path);
        return;
      }

      const selectedPath = await ctx.ui.custom<string | undefined>(
        (_tui, theme, keybindings, done) =>
          new RecallPicker({
            index,
            cwd: ctx.cwd,
            initialQuery,
            currentSessionPath: ctx.sessionManager.getSessionFile(),
            theme,
            keybindings,
            done,
          }),
        {
          overlay: true,
          overlayOptions: { anchor: "center", width: "90%", maxHeight: "85%", margin: 1 },
        },
      );

      if (selectedPath) await ctx.switchSession(selectedPath);
    },
  });

  pi.registerCommand("recall-reindex", {
    description: "Discard and rebuild the Pi Recall search index",
    handler: async (_args, ctx) => {
      const index = await syncIndex(ctx, undefined, true);
      if (ctx.hasUI) ctx.ui.notify(`Recall indexed ${index.sessionCount} sessions`, "info");
    },
  });

  pi.registerTool({
    name: "recall",
    label: "Recall",
    description:
      "Search, list, or read prior Pi sessions. Search uses Tantivy BM25 ranking, exact-phrase boosting, message grouping, and recency handling. Output is capped at 800 lines or 40KB.",
    promptSnippet: "Search, list, or read prior Pi sessions",
    promptGuidelines: [
      "Use recall when the user refers to work, decisions, commands, or context from an earlier Pi session.",
    ],
    parameters: Type.Object({
      action: StringEnum(["search", "list", "read"] as const, {
        description: "Operation to perform",
      }),
      query: Type.Optional(Type.String({ description: "Full-text query for search" })),
      session: Type.Optional(Type.String({ description: "Session ID, unique ID prefix, or path for read" })),
      scope: Type.Optional(
        StringEnum(["current", "all"] as const, {
          description: "Limit search/list to the current cwd or include all projects (default: all)",
        }),
      ),
      limit: Type.Optional(
        Type.Integer({ minimum: 1, maximum: 100, description: "Result limit; read returns the latest N messages" }),
      ),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      if (signal?.aborted) throw new Error("Recall cancelled");
      let lastUpdate = 0;
      const index = await syncIndex(ctx, (progress) => {
        if (progress.indexed - lastUpdate < 20 && progress.indexed !== progress.total) return;
        lastUpdate = progress.indexed;
        onUpdate?.({
          content: [{ type: "text", text: `Refreshing Recall index: ${progress.indexed}/${progress.total}` }],
          details: { progress },
        });
      });
      if (signal?.aborted) throw new Error("Recall cancelled");

      const scope = scopeOf(params.scope, "all");
      const limit = params.limit ?? (params.action === "read" ? 50 : 10);
      let output: string;
      let count: number;

      if (params.action === "search") {
        const query = params.query?.trim();
        if (!query) throw new Error("query is required for recall search");
        const results = index.search(query, { cwd: ctx.cwd, scope, limit });
        output = formatSearchResults(query, results);
        count = results.length;
      } else if (params.action === "list") {
        const sessions = index.list({ cwd: ctx.cwd, scope, limit });
        output = formatSessionList(sessions);
        count = sessions.length;
      } else {
        const session = params.session?.trim();
        if (!session) throw new Error("session is required for recall read");
        const parsed = await index.readSession(session);
        output = formatReadSession(parsed, limit);
        count = parsed.documents.length;
      }

      return {
        content: [{ type: "text", text: truncateToolOutput(output) }],
        details: { action: params.action, count, scope },
      };
    },
  });
}
