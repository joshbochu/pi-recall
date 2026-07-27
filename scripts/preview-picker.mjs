// Render the /recall picker to stdout with fixture data, so layout changes can be
// eyeballed (and diffed) without launching Pi.
//
//   node scripts/preview-picker.mjs [width] [terminalRows] [query]
//
// Pi's packages are loaded from the globally installed CLI, the same modules the
// extension gets at runtime.
import { execSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const width = Number(process.argv[2] ?? 78);
const terminalRows = Number(process.argv[3] ?? 30);
const query = process.argv[4] ?? "auto handoff overlay";

function globalPiPackage() {
  try {
    const prefix = execSync("npm prefix -g", { encoding: "utf8" }).trim();
    return join(prefix, "lib/node_modules/@wealthsimple/pi-coding-agent");
  } catch (error) {
    throw new Error(`cannot locate the global pi install (npm prefix -g failed): ${error.message}`);
  }
}

const pkg = globalPiPackage();
const deps = join(pkg, "node_modules/@wealthsimple");
const { createJiti } = await import(join(pkg, "node_modules/jiti/lib/jiti.mjs"));
const { getKeybindings } = await import(join(deps, "pi-tui/dist/index.js"));
const { theme, initTheme } = await import(join(pkg, "dist/modes/interactive/theme/theme.js"));

initTheme();

const jiti = createJiti(import.meta.url, {
  alias: {
    "@earendil-works/pi-coding-agent": join(pkg, "dist/index.js"),
    "@earendil-works/pi-tui": join(deps, "pi-tui/dist/index.js"),
    "@earendil-works/pi-ai": join(deps, "pi-ai/dist/compat.js"),
    "@earendil-works/pi-ai/compat": join(deps, "pi-ai/dist/compat.js"),
  },
});

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const { RecallPicker } = await jiti.import(join(root, "src/recall-picker.ts"));

const minute = 60_000;
const day = 24 * 60 * minute;

/** Byte offsets of every query term inside the snippet, as Tantivy would report them. */
function spansFor(snippet, terms) {
  const bytes = Buffer.from(snippet, "utf8");
  const spans = [];
  for (const term of terms) {
    const needle = Buffer.from(term, "utf8");
    let at = bytes.indexOf(needle);
    while (at !== -1) {
      spans.push([at, at + needle.length]);
      at = bytes.indexOf(needle, at + needle.length);
    }
  }
  return spans.sort((left, right) => left[0] - right[0]);
}

function result({ id, name, cwd, age, messageCount, tags, role, snippet, path }) {
  const terms = query.split(/\s+/u).filter((term) => term && !term.startsWith("#"));
  return {
    session: {
      id,
      path,
      cwd,
      name,
      created: Date.now() - age - day,
      modified: Date.now() - age,
      messageCount,
      firstMessage: name,
      tags,
    },
    score: 1,
    tags,
    matches: [
      {
        role,
        content: snippet,
        snippet,
        timestamp: Date.now() - age,
        entryId: "entry",
        score: 1,
        terms: [],
        messageIndex: 3,
        matchSpans: spansFor(snippet, terms),
      },
    ],
  };
}

const fixtures = [
  result({
    id: "019f8d92-5275-70a0-bf67-654332ba2304",
    name: "fix the auto handoff overlay",
    cwd: "/Users/dev/.pi/agent",
    path: "/Users/dev/.pi/agent/sessions/a.jsonl",
    age: 2 * 60 * minute,
    messageCount: 84,
    tags: ["pi-extensions", "tui"],
    role: "user",
    snippet: "help me fixup my pi autohandoff extension overlay; it's very brittle/busted can you analyze and fix",
  }),
  result({
    id: "019f9517-fbb2-7dc6-b4e5-3820653f120a",
    name: "recall picker polish",
    cwd: "/Users/dev/src/pi-recall",
    path: "/Users/dev/.pi/agent/sessions/b.jsonl",
    age: 3 * day,
    messageCount: 12,
    tags: ["search"],
    role: "assistant",
    snippet: "the picker renders with a 1-space margin and no frame, so the overlay blends into the transcript",
  }),
  result({
    id: "019f7001-1111-7000-9000-000000000001",
    name: "staging slackbot deploy runbook with a title long enough to need truncation",
    cwd: "/Users/dev/src/slackbot",
    path: "/Users/dev/.pi/agent/sessions/c.jsonl",
    age: 9 * day,
    messageCount: 231,
    tags: [],
    role: "user",
    snippet: "the handoff doc should list the deploy steps for staging before we hand it to the next agent",
  }),
  result({
    id: "019f5555-2222-7000-9000-000000000002",
    name: "tantivy index size investigation",
    cwd: "/Users/dev/src/pi-recall",
    path: "/Users/dev/.pi/agent/sessions/d.jsonl",
    age: 40 * day,
    messageCount: 57,
    tags: ["rust", "tantivy", "performance"],
    role: "assistant",
    snippet: "content is STORED, so the index keeps a second copy of every indexed message body",
  }),
];

const stubIndex = {
  countSessions: () => 2438,
  search: (value) => (value.includes("#nothing") ? [] : fixtures),
};

const picker = new RecallPicker({
  index: stubIndex,
  cwd: "/Users/dev/.pi/agent",
  initialQuery: query,
  currentSessionPath: "/Users/dev/.pi/agent/sessions/a.jsonl",
  tui: { terminal: { rows: terminalRows, columns: width } },
  theme,
  keybindings: getKeybindings(),
  done: () => {},
});
picker.focused = true;

// The TUI strips the cursor marker before painting; do the same here.
const CURSOR_MARKER = "\u001b_pi:c\u0007";
console.log(picker.render(width).join("\n").replaceAll(CURSOR_MARKER, ""));
