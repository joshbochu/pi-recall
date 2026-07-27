import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RecallIndex } from "../src/recall-index.js";
import {
  highlightSpans,
  projectLabel,
  RecallPicker,
  SEARCH_DEBOUNCE_MS,
  visibleResultCount,
} from "../src/recall-picker.js";
import type { RecallSearchResult } from "../src/types.js";

function plainTheme(): Theme {
  return {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
    bold: (text: string) => text,
    getBgAnsi: () => "",
  } as unknown as Theme;
}

/** Styles every fragment so the layout math is exercised against escape codes. */
function ansiTheme(): Theme {
  return {
    fg: (_color: string, text: string) => `\u001b[32m${text}\u001b[39m`,
    bg: (_color: string, text: string) => `\u001b[48;5;60m${text}\u001b[49m`,
    bold: (text: string) => `\u001b[1m${text}\u001b[22m`,
    getBgAnsi: () => "\u001b[48;5;60m",
  } as unknown as Theme;
}

/** Feeding a keybinding id as input triggers that binding, so tests can "press" keys. */
function keybindings(): KeybindingsManager {
  return {
    matches: (data: string, keybinding: string) => data === keybinding,
    getKeys: () => ["enter"],
  } as unknown as KeybindingsManager;
}

function result(overrides: Partial<RecallSearchResult["session"]> = {}, snippet = "a matched snippet"): RecallSearchResult {
  const session = {
    id: "019f8d92-5275-70a0-bf67-654332ba2304",
    path: "/sessions/a.jsonl",
    cwd: "/work/app",
    name: "a session title that is quite long and will need truncating somewhere",
    created: Date.now() - 86_400_000,
    modified: Date.now() - 7_200_000,
    messageCount: 84,
    firstMessage: "first message",
    tags: ["pi-extensions", "tui"],
    ...overrides,
  };
  return {
    session,
    score: 1,
    tags: session.tags ?? [],
    matches: [
      {
        role: "user" as const,
        content: snippet,
        snippet,
        timestamp: session.modified,
        entryId: "entry",
        score: 1,
        terms: [],
        messageIndex: 2,
        matchSpans: [[2, 9]],
      },
    ],
  };
}

const searches: Array<{ query: string; prefixLastToken: boolean | undefined }> = [];

afterEach(() => {
  searches.length = 0;
  vi.useRealTimers();
});

function picker(options: {
  theme?: Theme;
  results?: RecallSearchResult[];
  rows?: number;
  query?: string;
  done?: (path: string | undefined) => void;
} = {}) {
  const results = options.results ?? [result(), result({ path: "/sessions/b.jsonl", tags: [] })];
  const index = {
    countSessions: () => 2438,
    search: (query: string, searchOptions: { prefixLastToken?: boolean }) => {
      searches.push({ query, prefixLastToken: searchOptions.prefixLastToken });
      return results;
    },
  } as unknown as RecallIndex;
  return new RecallPicker({
    index,
    cwd: "/work/app",
    initialQuery: options.query ?? "matched",
    currentSessionPath: "/sessions/a.jsonl",
    tui: { terminal: { rows: options.rows ?? 30, columns: 80 }, requestRender: () => {} } as never,
    theme: options.theme ?? plainTheme(),
    keybindings: keybindings(),
    done: options.done ?? (() => {}),
  });
}

describe("highlightSpans", () => {
  it("paints byte ranges reported by Tantivy", () => {
    expect(highlightSpans("find the overlay", [[9, 16]], (text) => `<${text}>`)).toBe("find the <overlay>");
  });

  it("treats spans as byte offsets, not UTF-16 indices", () => {
    const text = "héllo wörld";
    const start = Buffer.from("héllo ", "utf8").length;
    const end = start + Buffer.from("wörld", "utf8").length;
    expect(highlightSpans(text, [[start, end]], (matched) => `<${matched}>`)).toBe("héllo <wörld>");
  });

  it("ignores out-of-range and overlapping spans", () => {
    expect(highlightSpans("abc", [[0, 99]], (text) => `<${text}>`)).toBe("abc");
    expect(
      highlightSpans("abcdef", [
        [0, 3],
        [1, 4],
      ], (text) => `<${text}>`),
    ).toBe("<abc>def");
  });

  it("returns the text unchanged without spans", () => {
    expect(highlightSpans("abc", [], (text) => `<${text}>`)).toBe("abc");
  });
});

describe("visibleResultCount", () => {
  it("grows with terminal height and stays clamped", () => {
    expect(visibleResultCount(18)).toBe(3);
    expect(visibleResultCount(30)).toBe(6);
    expect(visibleResultCount(60)).toBe(12);
    expect(visibleResultCount(0)).toBe(4); // falls back to 24 rows
    expect(visibleResultCount(8)).toBe(3);
  });
});

describe("projectLabel", () => {
  it("reduces a cwd to its project folder", () => {
    expect(projectLabel("/work/app")).toBe("app");
    expect(projectLabel("/work/app/")).toBe("app");
    expect(projectLabel("  ")).toBe("unknown");
  });
});

describe("RecallPicker.render", () => {
  it.each([
    ["plain", plainTheme()],
    ["styled", ansiTheme()],
  ])("draws a rectangular box with %s theme", (_label, theme) => {
    for (const width of [40, 60, 78, 120]) {
      const lines = picker({ theme }).render(width);
      const widths = [...new Set(lines.map((line) => visibleWidth(line)))];
      expect(widths, `width ${width}`).toEqual([width]);
      expect(lines.at(0)?.includes("╭")).toBe(true);
      expect(lines.at(-1)?.includes("╯")).toBe(true);
    }
  });

  it("shows the match highlight, project, age and scroll counter", () => {
    const lines = picker({ rows: 24 }).render(78).join("\n");
    expect(lines).toContain("app");
    expect(lines).toContain("1 of 2");
    expect(lines).toContain("2h");
    expect(lines).toContain("current");
  });

  it("nudges toward all projects when a scoped search finds nothing", () => {
    const lines = picker({ results: [] }).render(78).join("\n");
    expect(lines).toContain("no matching sessions");
    expect(lines).toContain("searches all projects");
  });

  it("asks for prefix matching so half-typed words still match", () => {
    picker({ query: "handof" });
    expect(searches).toEqual([{ query: "handof", prefixLastToken: true }]);
  });

  it("coalesces keystrokes into one search", () => {
    vi.useFakeTimers();
    const view = picker({ query: "han" });
    expect(searches).toHaveLength(1);

    for (const character of "doff") view.handleInput(character);
    expect(searches).toHaveLength(1);
    expect(view.render(78).join("\n")).toContain("searching…");

    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
    expect(searches).toEqual([
      { query: "han", prefixLastToken: true },
      { query: "handoff", prefixLastToken: true },
    ]);
    expect(view.render(78).join("\n")).not.toContain("searching…");
  });

  it("refuses to resume the session already open, and resumes any other", () => {
    const resumed: Array<string | undefined> = [];
    const view = picker({ done: (path) => resumed.push(path) });

    view.handleInput("tui.select.confirm"); // first row is the current session
    expect(resumed).toEqual([]);
    expect(view.render(78).join("\n")).toContain("already in this session");

    view.handleInput("tui.select.down");
    expect(view.render(78).join("\n")).not.toContain("already in this session");
    view.handleInput("tui.select.confirm");
    expect(resumed).toEqual(["/sessions/b.jsonl"]);
  });

  it("keeps the box rectangular for a tag-filtered query", () => {
    const lines = picker({ query: "#pi-extensions deploy", theme: ansiTheme() }).render(64);
    expect([...new Set(lines.map((line) => visibleWidth(line)))]).toEqual([64]);
    expect(lines.join("\n")).toContain("filter");
  });
});
