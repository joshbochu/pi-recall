import { readFile } from "node:fs/promises";
import { complete, type Model, type UserMessage } from "@earendil-works/pi-ai/compat";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { normalizeTag } from "./tag-store.js";
import type { ParsedSession } from "./types.js";

export interface AutoTagConfig {
  model?: string;
  minimum: number;
  maximum: number;
}

const DEFAULT_CONFIG: AutoTagConfig = { minimum: 3, maximum: 7 };
const MAX_SAMPLE_CHARS = 12_000;

function integer(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) ? value : fallback;
}

export async function loadAutoTagConfig(path: string): Promise<AutoTagConfig> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as {
      autoTags?: { model?: unknown; minimum?: unknown; maximum?: unknown };
    };
    const minimum = Math.max(3, Math.min(10, integer(parsed.autoTags?.minimum, DEFAULT_CONFIG.minimum)));
    const maximum = Math.max(minimum, Math.min(10, integer(parsed.autoTags?.maximum, DEFAULT_CONFIG.maximum)));
    return {
      model: typeof parsed.autoTags?.model === "string" && parsed.autoTags.model.trim()
        ? parsed.autoTags.model.trim()
        : undefined,
      minimum,
      maximum,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...DEFAULT_CONFIG };
    throw new Error(`Unable to read Recall config at ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function resolveAutoTagModel(
  ctx: ExtensionContext,
  configuredModel: string | undefined,
): Model<any> {
  if (!configuredModel) {
    if (!ctx.model) throw new Error("No Pi model is selected and no autoTags.model is configured");
    return ctx.model;
  }

  const separator = configuredModel.indexOf("/");
  if (separator < 1 || separator === configuredModel.length - 1) {
    throw new Error(`Invalid autoTags.model: ${configuredModel}. Expected provider/model-id`);
  }
  const provider = configuredModel.slice(0, separator);
  const modelId = configuredModel.slice(separator + 1);
  const model = ctx.modelRegistry.find(provider, modelId);
  if (!model) throw new Error(`Auto-tag model is not available in Pi: ${configuredModel}`);
  return model;
}

export function modelLabel(model: Model<any>): string {
  return `${model.provider}/${model.id}`;
}

export function buildSessionSample(session: ParsedSession): string {
  const firstUsers = session.documents.filter((document) => document.role === "user").slice(0, 5);
  const lastMessages = session.documents.slice(-7);
  const selected = [...new Map([...firstUsers, ...lastMessages].map((document) => [document.id, document])).values()];
  const header = [
    `Session: ${session.summary.name || session.summary.firstMessage || session.summary.id}`,
    `Project: ${session.summary.cwd}`,
    ...(session.summary.tags?.length ? [`Existing manual/generated tags: ${session.summary.tags.join(", ")}`] : []),
  ].join("\n");
  const body = selected
    .map((document) => `[${document.role}] ${document.content.replace(/\s+/g, " ").trim().slice(0, 2_000)}`)
    .join("\n\n");
  return `${header}\n\n${body}`.slice(0, MAX_SAMPLE_CHARS);
}

function parseJsonCandidate(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    const arrayStart = trimmed.indexOf("[");
    const arrayEnd = trimmed.lastIndexOf("]");
    if (arrayStart >= 0 && arrayEnd > arrayStart) {
      return JSON.parse(trimmed.slice(arrayStart, arrayEnd + 1)) as unknown;
    }
    const objectStart = trimmed.indexOf("{");
    const objectEnd = trimmed.lastIndexOf("}");
    if (objectStart >= 0 && objectEnd > objectStart) {
      return JSON.parse(trimmed.slice(objectStart, objectEnd + 1)) as unknown;
    }
    throw new Error("The model did not return valid JSON tags");
  }
}

export function parseGeneratedTags(text: string, config: AutoTagConfig): string[] {
  const parsed = parseJsonCandidate(text);
  const values = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && Array.isArray((parsed as { tags?: unknown }).tags)
      ? (parsed as { tags: unknown[] }).tags
      : undefined;
  if (!values) throw new Error('The model response must be a JSON array or {"tags": [...]}');

  const tags = [...new Set(values.filter((value): value is string => typeof value === "string").map(normalizeTag).filter(Boolean))]
    .slice(0, config.maximum);
  if (tags.length < config.minimum) {
    throw new Error(`The model returned ${tags.length} valid tags; expected at least ${config.minimum}`);
  }
  return tags;
}

export async function generateSessionTags(
  session: ParsedSession,
  model: Model<any>,
  ctx: ExtensionContext,
  config: AutoTagConfig,
  signal?: AbortSignal,
): Promise<string[]> {
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) throw new Error(auth.error);
  if (!auth.apiKey) throw new Error(`No API key is configured for ${model.provider}`);

  const systemPrompt = `You assign concise retrieval tags to coding-agent sessions.
Return only JSON in the shape {"tags":["tag-one","tag-two"]}.
Generate between ${config.minimum} and ${config.maximum} distinct tags.
Use lowercase, durable topic labels rather than transient status words.
Prefer technologies, codebases, features, domains, and task types.
Do not include # prefixes, explanations, project paths, secrets, or personal data.`;
  const userMessage: UserMessage = {
    role: "user",
    content: [{ type: "text", text: buildSessionSample(session) }],
    timestamp: Date.now(),
  };
  const response = await complete(
    model,
    { systemPrompt, messages: [userMessage] },
    {
      apiKey: auth.apiKey,
      headers: auth.headers,
      env: auth.env,
      signal,
      maxTokens: 512,
      temperature: 0.2,
    },
  );
  if (response.stopReason === "aborted" || signal?.aborted) throw new Error("Auto-tagging cancelled");
  const text = response.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n");
  return parseGeneratedTags(text, config);
}
