import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildSessionSample, loadAutoTagConfig, parseGeneratedTags } from "../src/auto-tag.js";
import { normalizeTag, parseTags, TagStore } from "../src/tag-store.js";
import type { ParsedSession } from "../src/types.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("TagStore", () => {
  it("normalizes, persists, and protects manual and suppressed tags", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-recall-tags-"));
    roots.push(root);
    const path = join(root, "tags.json");
    const store = await TagStore.open(path);

    expect(normalizeTag(" #Rust/Search! ")).toBe("rust-search");
    expect(parseTags("#Codebase, rust  #codebase")).toEqual(["codebase", "rust"]);
    await store.addManual("one", ["Codebase"]);
    await store.setAuto("one", ["codebase", "search", "temporary"]);
    await store.remove("one", ["temporary"]);
    await store.setAuto("one", ["temporary", "search", "typescript"]);

    const reloaded = await TagStore.open(path);
    expect(reloaded.get("one")).toMatchObject({
      manualTags: ["codebase"],
      autoTags: ["search", "typescript"],
      suppressedTags: ["temporary"],
    });
  });
});

describe("auto-tag helpers", () => {
  it("loads bounded config and parses JSON-only or fenced model output", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-recall-config-"));
    roots.push(root);
    expect(await loadAutoTagConfig(join(root, "missing.json"))).toEqual({ minimum: 3, maximum: 7 });
    const config = { minimum: 3, maximum: 4 };
    expect(parseGeneratedTags('{"tags":["Rust","Full Text Search","Pi","extra","ignored"]}', config)).toEqual([
      "rust",
      "full-text-search",
      "pi",
      "extra",
    ]);
    expect(parseGeneratedTags('```json\n["one","two","three"]\n```', config)).toEqual([
      "one",
      "two",
      "three",
    ]);
  });

  it("builds a bounded, role-labelled session sample", () => {
    const parsed: ParsedSession = {
      summary: {
        id: "session",
        path: "/tmp/session.jsonl",
        cwd: "/work/app",
        created: 1,
        modified: 2,
        messageCount: 2,
        firstMessage: "Build search",
      },
      documents: [
        {
          id: "one",
          sessionId: "session",
          sessionPath: "/tmp/session.jsonl",
          sessionName: "",
          cwd: "/work/app",
          role: "user",
          content: "Build a Tantivy index",
          timestamp: 1,
          entryId: "one",
          messageIndex: 0,
        },
        {
          id: "two",
          sessionId: "session",
          sessionPath: "/tmp/session.jsonl",
          sessionName: "",
          cwd: "/work/app",
          role: "assistant",
          content: "Implemented the Rust bridge",
          timestamp: 2,
          entryId: "two",
          messageIndex: 1,
        },
      ],
    };
    expect(buildSessionSample(parsed)).toContain("[user] Build a Tantivy index");
    expect(buildSessionSample(parsed)).toContain("[assistant] Implemented the Rust bridge");
  });
});
