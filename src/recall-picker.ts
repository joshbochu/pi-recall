import { basename } from "node:path";
import {
  type KeybindingsManager,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  type Component,
  type Focusable,
  Input,
  type OverlayOptions,
  type TUI,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { parseTagQuery, type RecallIndex } from "./recall-index.js";
import type { RecallScope, RecallSearchResult } from "./types.js";

/** Kept next to the picker so its height math cannot drift from the overlay it renders into. */
export const RECALL_OVERLAY_HEIGHT_RATIO = 0.85;

export const RECALL_OVERLAY_OPTIONS: OverlayOptions = {
  anchor: "center",
  width: "90%",
  minWidth: 60,
  maxHeight: "85%",
  margin: 1,
};

/** Border, input, filter, counter, separator and hint rows that surround the results. */
const CHROME_LINES = 7;
/** Header, preview and trailing blank per result. */
const LINES_PER_RESULT = 3;
const MIN_VISIBLE_RESULTS = 3;
const MAX_VISIBLE_RESULTS = 12;
const MIN_INNER_WIDTH = 24;
/** Keystrokes coalesce into one native search; searching is synchronous. */
export const SEARCH_DEBOUNCE_MS = 40;
/**
 * Native search fetches `limit * 10` stored documents before grouping them by
 * session, so latency tracks this number: on a 20k-message index, 50 costs
 * ~97ms per search and 20 costs ~33ms. Twenty scrollable hits is plenty for a
 * picker; the recall tool picks its own limit.
 */
export const PICKER_RESULT_LIMIT = 20;
const MAX_TAG_WIDTH = 16;
const ROLE_GUTTER: Record<string, string> = { user: "user", assistant: "asst", tag: "tags" };

function formatAge(timestamp: number): string {
  const elapsed = Math.max(0, Date.now() - timestamp);
  const minutes = Math.floor(elapsed / 60_000);
  const hours = Math.floor(elapsed / 3_600_000);
  const days = Math.floor(elapsed / 86_400_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  if (hours < 24) return `${hours}h`;
  if (days < 7) return `${days}d`;
  if (days < 30) return `${Math.floor(days / 7)}w`;
  if (days < 365) return `${Math.floor(days / 30)}mo`;
  return `${Math.floor(days / 365)}y`;
}

/** Project a session belongs to; the picker shows this in every row so "all projects" stays legible. */
export function projectLabel(cwd: string): string {
  const trimmed = cwd.trim().replace(/[/\\]+$/, "");
  if (!trimmed) return "unknown";
  return basename(trimmed) || trimmed;
}

function padToWidth(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

/**
 * Paint Tantivy's highlighted ranges. Spans are byte offsets into the snippet,
 * so the text is sliced as bytes rather than UTF-16 code units.
 */
export function highlightSpans(
  text: string,
  spans: Array<[number, number]>,
  paint: (matched: string) => string,
): string {
  if (spans.length === 0) return text;
  const bytes = Buffer.from(text, "utf8");
  const ordered = [...spans]
    .filter(([start, end]) => start >= 0 && end > start && end <= bytes.length)
    .sort((left, right) => left[0] - right[0]);

  let cursor = 0;
  let out = "";
  for (const [start, end] of ordered) {
    if (start < cursor) continue; // Overlapping span: keep the earlier one.
    out += bytes.subarray(cursor, start).toString("utf8");
    out += paint(bytes.subarray(start, end).toString("utf8"));
    cursor = end;
  }
  return out + bytes.subarray(cursor).toString("utf8");
}

/** Rows visible for a given terminal height, matching RECALL_OVERLAY_OPTIONS. */
export function visibleResultCount(terminalRows: number): number {
  const rows = terminalRows > 0 ? terminalRows : 24;
  const overlayRows = Math.min(Math.floor(rows * RECALL_OVERLAY_HEIGHT_RATIO), rows - 2);
  const forResults = Math.floor((overlayRows - CHROME_LINES) / LINES_PER_RESULT);
  return Math.max(MIN_VISIBLE_RESULTS, Math.min(MAX_VISIBLE_RESULTS, forResults));
}

export interface RecallPickerOptions {
  index: RecallIndex;
  cwd: string;
  initialQuery: string;
  initialScope?: RecallScope;
  currentSessionPath?: string;
  tui: TUI;
  theme: Theme;
  keybindings: KeybindingsManager;
  done: (sessionPath: string | undefined) => void;
}

export class RecallPicker implements Component, Focusable {
  private readonly index: RecallIndex;
  private readonly cwd: string;
  private readonly currentSessionPath: string | undefined;
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly keybindings: KeybindingsManager;
  private readonly done: (sessionPath: string | undefined) => void;
  private readonly input: Input;
  private scope: RecallScope;
  private results: RecallSearchResult[] = [];
  private searchableSessionCount = 0;
  private requiredTags: string[] = [];
  private searchError: string | undefined;
  private selectedIndex = 0;
  private _focused = false;
  private notice: string | undefined;
  private pendingSearch: ReturnType<typeof setTimeout> | undefined;

  constructor(options: RecallPickerOptions) {
    this.index = options.index;
    this.cwd = options.cwd;
    this.currentSessionPath = options.currentSessionPath;
    this.tui = options.tui;
    this.theme = options.theme;
    this.keybindings = options.keybindings;
    this.done = options.done;
    this.scope = options.initialScope ?? "all";
    this.input = new Input();
    if (options.initialQuery) this.input.handleInput(options.initialQuery);
    this.refresh();
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.input.focused = value;
  }

  invalidate(): void {
    this.input.invalidate();
  }

  dispose(): void {
    if (this.pendingSearch) clearTimeout(this.pendingSearch);
    this.pendingSearch = undefined;
  }

  handleInput(data: string): void {
    if (this.keybindings.matches(data, "tui.select.cancel")) {
      this.done(undefined);
      return;
    }
    if (this.keybindings.matches(data, "tui.select.confirm")) {
      const selected = this.results[this.selectedIndex];
      if (!selected) return;
      // Resuming the open session would restart it and lose nothing but time.
      if (selected.session.path === this.currentSessionPath) {
        this.notice = "already in this session";
        return;
      }
      this.done(selected.session.path);
      return;
    }
    this.notice = undefined;
    if (this.keybindings.matches(data, "tui.select.up")) {
      this.moveSelection(-1);
      return;
    }
    if (this.keybindings.matches(data, "tui.select.down")) {
      this.moveSelection(1);
      return;
    }
    if (this.keybindings.matches(data, "tui.input.tab")) {
      this.scope = this.scope === "current" ? "all" : "current";
      this.refresh();
      return;
    }

    const previous = this.input.getValue();
    this.input.handleInput(data);
    if (this.input.getValue() !== previous) this.scheduleRefresh();
  }

  /** Coalesce fast typing into one search instead of one per keystroke. */
  private scheduleRefresh(): void {
    if (this.pendingSearch) clearTimeout(this.pendingSearch);
    this.pendingSearch = setTimeout(() => {
      this.pendingSearch = undefined;
      this.refresh();
      this.tui.requestRender();
    }, SEARCH_DEBOUNCE_MS);
    this.pendingSearch.unref?.();
  }

  private moveSelection(delta: number): void {
    if (this.results.length === 0) return;
    this.selectedIndex = (this.selectedIndex + delta + this.results.length) % this.results.length;
  }

  private refresh(): void {
    const scope = {
      cwd: this.cwd,
      scope: this.scope,
    } as const;
    const query = this.input.getValue();
    this.searchableSessionCount = this.index.countSessions(scope);
    this.requiredTags = parseTagQuery(query).requiredTags;
    try {
      this.results = this.index.search(query, {
        ...scope,
        limit: PICKER_RESULT_LIMIT,
        prefixLastToken: true,
      });
      this.searchError = undefined;
    } catch (error) {
      this.results = [];
      this.searchError = error instanceof Error ? error.message : String(error);
    }
    this.selectedIndex = 0;
  }

  render(width: number): string[] {
    const innerWidth = Math.max(MIN_INNER_WIDTH, width - 4);
    const rows = [this.inputRow(innerWidth), this.filterRow(innerWidth)];

    const visibleCount = visibleResultCount(this.tui.terminal.rows);
    const start = Math.max(
      0,
      Math.min(this.selectedIndex - Math.floor(visibleCount / 2), this.results.length - visibleCount),
    );
    if (this.searchError || this.results.length === 0) {
      rows.push(this.statusRow(innerWidth));
    } else {
      const visible = this.results.slice(start, start + visibleCount);
      for (let offset = 0; offset < visible.length; offset++) {
        const isLast = offset === visible.length - 1;
        rows.push(...this.resultRows(visible[offset]!, start + offset === this.selectedIndex, innerWidth, isLast));
      }
    }
    rows.push(this.counterRow(innerWidth, start, visibleCount));

    return [
      this.borderTop(width),
      ...rows.map((row) => this.borderRow(row, innerWidth)),
      this.borderSeparator(width),
      this.borderRow(this.hintRow(innerWidth), innerWidth),
      this.borderBottom(width),
    ];
  }

  // ---------------------------------------------------------------- frame

  private border(text: string): string {
    return this.theme.fg("border", text);
  }

  private borderTop(width: number): string {
    const title = ` ${this.theme.bold(this.theme.fg("accent", "Recall"))} `;
    const stats = ` ${this.theme.fg("muted", this.statsText())} `;
    const titleWidth = visibleWidth(title);
    const statsWidth = visibleWidth(stats);

    // Title left, stats right; drop stats then the title as the box narrows.
    const withStats = width - 4 - titleWidth - statsWidth;
    if (withStats >= 1) {
      return (
        this.border("╭─") + title + this.border("─".repeat(withStats)) + stats + this.border("─╮")
      );
    }
    const withTitle = width - 3 - titleWidth;
    if (withTitle >= 1) {
      return this.border("╭─") + title + this.border(`${"─".repeat(withTitle)}╮`);
    }
    return this.border(`╭${"─".repeat(Math.max(0, width - 2))}╮`);
  }

  private borderRow(row: string, innerWidth: number): string {
    return `${this.border("│")} ${padToWidth(truncateToWidth(row, innerWidth, "…"), innerWidth)} ${this.border("│")}`;
  }

  private borderSeparator(width: number): string {
    return this.border(`├${"─".repeat(Math.max(0, width - 2))}┤`);
  }

  private borderBottom(width: number): string {
    return this.border(`╰${"─".repeat(Math.max(0, width - 2))}╯`);
  }

  // ----------------------------------------------------------------- rows

  private statsText(): string {
    const scopeLabel = this.scope === "current" ? "this folder" : "all projects";
    if (this.pendingSearch) return `searching… · ${this.searchableSessionCount} indexed · ${scopeLabel}`;
    const matches = `${this.results.length} ${this.results.length === 1 ? "match" : "matches"}`;
    return `${matches} · ${this.searchableSessionCount} indexed · ${scopeLabel}`;
  }

  private inputRow(innerWidth: number): string {
    // Input renders its own "> " prompt and cursor marker.
    const inputLine = this.input.render(innerWidth)[0] ?? "";
    if (this.input.getValue()) return inputLine;
    return `${inputLine}${this.theme.fg("dim", "search sessions · #tag filters")}`;
  }

  /** Paint a full-width selection band that survives the resets inside styled text. */
  private selectedBand(text: string, innerWidth: number): string {
    const bg = this.theme.getBgAnsi("selectedBg");
    const padded = padToWidth(truncateToWidth(text, innerWidth, "…"), innerWidth);
    return `${bg}${padded.replaceAll("\u001b[0m", `\u001b[0m${bg}`)}\u001b[49m`;
  }

  private filterRow(innerWidth: number): string {
    if (this.requiredTags.length === 0) return "";
    const pills = this.requiredTags.map((tag) => this.theme.fg("accent", ` #${tag} `)).join(" ");
    return truncateToWidth(`  ${this.theme.fg("muted", "filter")} ${pills}`, innerWidth, "…");
  }

  private statusRow(innerWidth: number): string {
    if (this.searchError) {
      return this.theme.fg("error", truncateToWidth(`  ${this.searchError}`, innerWidth, "…"));
    }
    const tab = this.keyName("tui.input.tab");
    const reason = this.requiredTags.length
      ? `no sessions tagged ${this.requiredTags.map((tag) => `#${tag}`).join(" ")}`
      : "no matching sessions";
    const nudge = this.scope === "current" ? ` — ${tab} searches all projects` : "";
    return this.theme.fg("muted", truncateToWidth(`  ${reason}${nudge}`, innerWidth, "…"));
  }

  private resultRows(
    result: RecallSearchResult,
    selected: boolean,
    innerWidth: number,
    isLast: boolean,
  ): string[] {
    const metadata = this.metadataText(result, Math.max(24, Math.floor(innerWidth / 2)));
    const marker = selected ? this.theme.fg("accent", "▸ ") : "  ";
    const titleText = result.session.name || result.session.firstMessage || result.session.id;
    const titleWidth = Math.max(8, innerWidth - visibleWidth(metadata) - 4);
    const title = truncateToWidth(titleText, titleWidth, "…");
    const primary = `${marker}${selected ? this.theme.bold(title) : title}`;
    const gap = " ".repeat(Math.max(1, innerWidth - visibleWidth(primary) - visibleWidth(metadata)));
    let header = truncateToWidth(`${primary}${gap}${metadata}`, innerWidth, "");

    const match = result.matches[0];
    const gutter = this.theme.fg("dim", padToWidth(match ? (ROLE_GUTTER[match.role] ?? match.role) : "", 4));
    const body = match
      ? highlightSpans(match.snippet, match.matchSpans, (matched) =>
          this.theme.bold(this.theme.fg("accent", matched)),
        )
      : `${projectLabel(result.session.cwd)} · ${result.session.id}`;
    let preview = truncateToWidth(`  ${gutter} ${this.theme.fg("dim", body)}`, innerWidth, "…");

    if (selected) {
      header = this.selectedBand(header, innerWidth);
      preview = this.selectedBand(preview, innerWidth);
    }
    return isLast ? [header, preview] : [header, preview, ""];
  }

  /**
   * Metadata within `budget` columns so titles keep room. Parts are dropped
   * lowest-priority first (message count, then tags) but always render in
   * display order: tags · project · age · msgs · current.
   */
  private metadataText(result: RecallSearchResult, budget: number): string {
    const dot = this.theme.fg("dim", " · ");
    const tags = result.tags.length
      ? truncateToWidth(result.tags.map((tag) => `#${tag}`).join(" "), MAX_TAG_WIDTH, "…")
      : undefined;
    const candidates: Array<[order: number, text: string | undefined]> = [
      [2, this.theme.fg("dim", formatAge(result.session.modified))],
      [
        4,
        this.currentSessionPath === result.session.path
          ? this.theme.fg("warning", "current")
          : undefined,
      ],
      [1, this.theme.fg("muted", projectLabel(result.session.cwd))],
      [0, tags ? this.theme.fg("accent", tags) : undefined],
      [3, this.theme.fg("dim", `${result.session.messageCount} msgs`)],
    ];

    let kept: Array<[number, string]> = [];
    for (const [order, text] of candidates) {
      if (!text) continue;
      const next = [...kept, [order, text] as [number, string]].sort((left, right) => left[0] - right[0]);
      if (visibleWidth(next.map(([, value]) => value).join(dot)) <= budget) kept = next;
    }
    return kept.map(([, text]) => text).join(dot);
  }

  private counterRow(innerWidth: number, start: number, visibleCount: number): string {
    if (this.notice) {
      const notice = this.theme.fg("warning", this.notice);
      const padding = " ".repeat(Math.max(0, innerWidth - visibleWidth(notice)));
      return `${padding}${notice}`;
    }
    if (this.results.length === 0) return "";
    const above = start > 0 ? "↑" : "";
    const below = start + visibleCount < this.results.length ? "↓" : "";
    const arrows = `${above}${below}`;
    const counter = `${arrows ? `${arrows} ` : ""}${this.selectedIndex + 1} of ${this.results.length}`;
    const padding = " ".repeat(Math.max(0, innerWidth - visibleWidth(counter)));
    return `${padding}${this.theme.fg("dim", counter)}`;
  }

  private keyName(keybinding: "tui.select.confirm" | "tui.select.cancel" | "tui.input.tab"): string {
    return this.keybindings.getKeys(keybinding)[0] ?? keybinding;
  }

  private hintRow(innerWidth: number): string {
    const hint = (keys: string, label: string): string =>
      this.theme.fg("dim", keys) + this.theme.fg("muted", ` ${label}`);
    const scopeTarget = this.scope === "current" ? "all projects" : "this folder";
    const hints = [
      hint("↑↓", "move"),
      hint(this.keyName("tui.select.confirm"), "resume"),
      hint(this.keyName("tui.input.tab"), scopeTarget),
      hint(this.keyName("tui.select.cancel"), "close"),
    ].join(this.theme.fg("dim", " · "));
    return truncateToWidth(hints, innerWidth, "…");
  }
}
