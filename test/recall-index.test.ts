import { appendFile, chmod, mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RecallIndex, toNativeSession, toNativeTagInput } from "../src/recall-index.js";

const temporaryRoots: string[] = [];

function sessionContent(
  id: string,
  cwd: string,
  messages: Array<{ role: "user" | "assistant"; content: string }>,
  name?: string,
): string {
  const timestamp = "2026-01-02T03:04:05.000Z";
  const entries: unknown[] = [{ type: "session", version: 3, id, timestamp, cwd }];
  let parentId: string | null = null;
  for (let index = 0; index < messages.length; index++) {
    const item = messages[index]!;
    const entryId = `${index.toString(16).padStart(8, "0")}`;
    entries.push({
      type: "message",
      id: entryId,
      parentId,
      timestamp,
      message: { role: item.role, content: item.content, timestamp: Date.parse(timestamp) + index },
    });
    parentId = entryId;
  }
  if (name) {
    entries.push({ type: "session_info", id: "ffffffff", parentId, timestamp, name });
  }
  return `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

async function createFixture(): Promise<{
  root: string;
  agentDir: string;
  firstPath: string;
  secondPath: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "pi-recall-test-"));
  temporaryRoots.push(root);
  const agentDir = join(root, "agent");
  const firstDir = join(agentDir, "sessions", "--work-app--");
  const secondDir = join(agentDir, "sessions", "--other--");
  await Promise.all([mkdir(firstDir, { recursive: true }), mkdir(secondDir, { recursive: true })]);
  const firstPath = join(firstDir, "first.jsonl");
  const secondPath = join(secondDir, "second.jsonl");
  await Promise.all([
    writeFile(
      firstPath,
      sessionContent(
        "session-first",
        "/work/app",
        [
          { role: "user", content: "Deploy the staging application" },
          { role: "assistant", content: "The staging deploy completed successfully" },
        ],
        "Staging release",
      ),
    ),
    writeFile(
      secondPath,
      sessionContent("session-second", "/other", [
        { role: "user", content: "Investigate the database migration" },
        { role: "assistant", content: "The migration needs a rollback guard" },
      ]),
    ),
  ]);
  return { root, agentDir, firstPath, secondPath };
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("native input conversion", () => {
  const fractional = 1_780_966_757_402.787;

  it("squares off timestamps that the native i64 fields would reject", () => {
    const session = {
      id: "session-first",
      path: "/sessions/first.jsonl",
      cwd: "/work/app",
      created: fractional,
      modified: fractional,
      messageCount: 1,
      firstMessage: "hello",
    };
    const native = toNativeSession(
      {
        summary: session,
        documents: [
          {
            id: "doc",
            sessionId: session.id,
            sessionPath: session.path,
            sessionName: "",
            cwd: session.cwd,
            role: "user" as const,
            content: "hello",
            timestamp: fractional,
            entryId: "entry",
            messageIndex: 0,
          },
        ],
      },
      [],
    );
    expect(native.timestamp).toBe(1_780_966_757_402);
    expect(native.messages[0]!.timestamp).toBe(1_780_966_757_402);

    // Tag documents take their timestamp from a cached summary, which may predate
    // the parser truncation.
    expect(toNativeTagInput(session, ["codebase"]).timestamp).toBe(1_780_966_757_402);
    expect(toNativeTagInput({ ...session, modified: Number.NaN }, []).timestamp).toBe(0);
  });
});

describe("RecallIndex", () => {
  it("indexes, ranks, filters, updates, persists, and removes sessions", async () => {
    const fixture = await createFixture();
    const cacheFile = join(fixture.root, "cache", "index.json");
    const index = await RecallIndex.open({ agentDir: fixture.agentDir, cacheFile, concurrency: 2 });

    const firstSync = await index.sync();
    expect(firstSync).toMatchObject({ discovered: 2, indexed: 2, removed: 0, failed: [] });
    expect(index.sessionCount).toBe(2);
    expect(index.documentCount).toBe(4);
    expect(index.countSessions()).toBe(2);
    expect(index.countSessions({ scope: "current", cwd: "/work/app" })).toBe(1);
    expect(index.countSessions({ scope: "current", cwd: "/missing" })).toBe(0);

    const staging = index.search("deploy staging", { scope: "all" });
    expect(staging).toHaveLength(1);
    expect(staging[0]!.session.id).toBe("session-first");
    expect(staging[0]!.matches[0]!.snippet).toContain("staging");

    const currentOnly = index.search("migration", { scope: "current", cwd: "/work/app" });
    expect(currentOnly).toEqual([]);
    expect(index.list({ scope: "current", cwd: "/work/app" })).toHaveLength(1);

    // Recall/Tantivy's default query parser uses OR semantics for plain terms.
    expect(index.search("deploy migration", { scope: "all" }).map((result) => result.session.id).sort()).toEqual([
      "session-first",
      "session-second",
    ]);

    // Recall indexes content only: session names and paths are stored metadata, not search fields.
    expect(index.search("release", { scope: "all" })).toEqual([]);

    // Recall does not enable fuzzy edit-distance matching in Tantivy's query parser.
    expect(index.search("deploi", { scope: "all" })).toEqual([]);

    const reloaded = await RecallIndex.open({ agentDir: fixture.agentDir, cacheFile });
    expect(reloaded.sessionCount).toBe(2);
    expect(reloaded.documentCount).toBe(4);
    expect(reloaded.search("rollback guard")[0]!.session.id).toBe("session-second");

    await appendFile(
      fixture.firstPath,
      `${JSON.stringify({
        type: "message",
        id: "aaaaaaaa",
        parentId: "ffffffff",
        timestamp: "2026-01-02T04:00:00.000Z",
        message: {
          role: "user",
          content: "The canary used a feature semaphore",
          timestamp: Date.parse("2026-01-02T04:00:00.000Z"),
        },
      })}\n`,
    );
    const update = await reloaded.sync();
    expect(update.indexed).toBe(1);
    expect(reloaded.documentCount).toBe(5);
    expect(reloaded.search("feature semaphore")[0]!.session.id).toBe("session-first");

    await unlink(fixture.secondPath);
    const removal = await reloaded.sync();
    expect(removal.removed).toBe(1);
    expect(reloaded.sessionCount).toBe(1);
    expect(reloaded.search("database migration")).toEqual([]);
  });

  it("prefix-matches the token being typed, only when asked", async () => {
    const fixture = await createFixture();
    const index = await RecallIndex.open({
      agentDir: fixture.agentDir,
      cacheFile: join(fixture.root, "prefix.json"),
      indexDir: join(fixture.root, "cache", "tantivy-prefix"),
    });
    await index.sync();
    const ids = (query: string, prefixLastToken = false) =>
      index.search(query, { scope: "all", prefixLastToken }).map((result) => result.session.id);

    // Lexical search alone finds nothing until the word is complete.
    expect(ids("stagin")).toEqual([]);
    expect(ids("stagin", true)).toEqual(["session-first"]);
    expect(ids("migratio", true)).toEqual(["session-second"]);
    expect(ids("deploy stagin", true)).toEqual(["session-first"]);

    // A trailing space means the user finished that token: no prefix expansion.
    expect(ids("stagin ", true)).toEqual([]);
    // Single characters are too broad to expand.
    expect(ids("s", true)).toEqual([]);
    // Whole-word matches still outrank prefix-only matches.
    expect(ids("migration deplo", true)).toEqual(["session-second", "session-first"]);

    await index.addManualTags("session-first", ["codebase"]);
    expect(ids("codeba", true)).toEqual(["session-first"]);
    // A trailing hashtag is an exact filter, never a prefix.
    expect(ids("#codeba", true)).toEqual([]);
  });

  // Unreadable-file behavior cannot be provoked as root, which can read anything.
  it.skipIf(process.getuid?.() === 0)("reports unreadable session files instead of dropping them silently", async () => {
    const fixture = await createFixture();
    const brokenPath = join(fixture.agentDir, "sessions", "--work-app--", "broken.jsonl");
    await writeFile(brokenPath, sessionContent("session-broken", "/work/app", []));
    await chmod(brokenPath, 0o000);
    const index = await RecallIndex.open({
      agentDir: fixture.agentDir,
      cacheFile: join(fixture.root, "failed.json"),
      indexDir: join(fixture.root, "cache", "tantivy-failed"),
    });

    const result = await index.sync();
    expect(result.discovered).toBe(3);
    expect(result.indexed).toBe(2);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]!.path).toContain("broken.jsonl");
    expect(result.failed[0]!.error).toBeTruthy();
    // The readable sessions are still searchable.
    expect(index.search("deploy staging", { scope: "all" })).toHaveLength(1);
    await chmod(brokenPath, 0o600);
  });

  it("resolves and reads sessions by a unique ID prefix", async () => {
    const fixture = await createFixture();
    const index = await RecallIndex.open({ agentDir: fixture.agentDir, cacheFile: join(fixture.root, "index.json") });
    await index.sync();

    const parsed = await index.readSession("session-f");
    expect(parsed.summary.id).toBe("session-first");
    expect(parsed.documents.map((document) => document.content)).toContain("Deploy the staging application");
  });

  it("matches Recall's phrase boost and matched-message recency behavior", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-recall-parity-test-"));
    temporaryRoots.push(root);
    const agentDir = join(root, "agent");
    const sessionsDir = join(agentDir, "sessions", "--parity--");
    await mkdir(sessionsDir, { recursive: true });
    await Promise.all([
      writeFile(
        join(sessionsDir, "exact.jsonl"),
        sessionContent("exact-phrase", "/parity", [{ role: "user", content: "neural search pipeline" }]),
      ),
      writeFile(
        join(sessionsDir, "separate.jsonl"),
        sessionContent("separate-terms", "/parity", [
          { role: "user", content: "neural indexing with a separate search pipeline" },
        ]),
      ),
      writeFile(
        join(sessionsDir, "recency.jsonl"),
        sessionContent("message-recency", "/parity", [
          { role: "user", content: "needle" },
          { role: "assistant", content: "needle" },
        ]),
      ),
    ]);

    const index = await RecallIndex.open({ agentDir, cacheFile: join(root, "state.json") });
    await index.sync();

    const phraseResults = index.search("neural search", { scope: "all" });
    expect(phraseResults.map((result) => result.session.id)).toEqual(["exact-phrase", "separate-terms"]);

    const recencyResult = index.search("needle", { scope: "all" })[0]!;
    expect(recencyResult.session.id).toBe("message-recency");
    expect(recencyResult.matches[0]).toMatchObject({ entryId: "00000001", messageIndex: 1 });
  });

  it("persists tags, boosts ordinary tag matches, and applies exact hashtag filters", async () => {
    const fixture = await createFixture();
    const cacheFile = join(fixture.root, "cache", "tag-index.json");
    const tagFile = join(fixture.root, "data", "tags.json");
    const indexDir = join(fixture.root, "cache", "tantivy-tags");
    const index = await RecallIndex.open({ agentDir: fixture.agentDir, cacheFile, tagFile, indexDir });
    await index.sync();

    await index.addManualTags("session-first", ["codebase", "Rust"]);
    await index.addManualTags("session-second", ["database"]);
    expect(index.documentCount).toBe(6);
    expect(index.getTags("session-first").manualTags).toEqual(["codebase", "rust"]);

    const ordinary = index.search("codebase", { scope: "all" });
    expect(ordinary[0]).toMatchObject({ session: { id: "session-first" }, tags: ["codebase", "rust"] });
    expect(ordinary[0]!.matches[0]!.role).toBe("tag");

    expect(index.search("#codebase", { scope: "all" }).map((result) => result.session.id)).toEqual([
      "session-first",
    ]);
    expect(index.search("deploy #codebase", { scope: "all" }).map((result) => result.session.id)).toEqual([
      "session-first",
    ]);
    expect(index.search("migration #codebase", { scope: "all" })).toEqual([]);
    expect(index.search("#codebase #rust", { scope: "all" })).toHaveLength(1);
    expect(index.search("#codebase #database", { scope: "all" })).toEqual([]);

    const reloaded = await RecallIndex.open({ agentDir: fixture.agentDir, cacheFile, tagFile, indexDir });
    expect(reloaded.documentCount).toBe(6);
    expect(reloaded.search("rust", { scope: "all" })[0]!.session.id).toBe("session-first");

    await reloaded.removeTags("session-first", ["rust"]);
    await reloaded.setAutoTags("session-first", ["rust", "search"]);
    expect(reloaded.getTags("session-first")).toMatchObject({
      manualTags: ["codebase"],
      autoTags: ["search"],
      suppressedTags: ["rust"],
    });
    expect(reloaded.search("#rust", { scope: "all" })).toEqual([]);
    expect(reloaded.search("#search", { scope: "all" })).toHaveLength(1);
  });
});
