import { homedir } from "node:os";
import {
  keyHint,
  type KeybindingsManager,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { type Component, type Focusable, Input, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { RecallIndex } from "./recall-index.js";
import type { RecallScope, RecallSearchResult } from "./types.js";

const MAX_VISIBLE_RESULTS = 6;

function shortenPath(path: string): string {
  const home = homedir();
  return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

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

function padToWidth(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

export interface RecallPickerOptions {
  index: RecallIndex;
  cwd: string;
  initialQuery: string;
  initialScope?: RecallScope;
  currentSessionPath?: string;
  theme: Theme;
  keybindings: KeybindingsManager;
  done: (sessionPath: string | undefined) => void;
}

export class RecallPicker implements Component, Focusable {
  private readonly index: RecallIndex;
  private readonly cwd: string;
  private readonly currentSessionPath: string | undefined;
  private readonly theme: Theme;
  private readonly keybindings: KeybindingsManager;
  private readonly done: (sessionPath: string | undefined) => void;
  private readonly input: Input;
  private scope: RecallScope;
  private results: RecallSearchResult[] = [];
  private searchableSessionCount = 0;
  private searchError: string | undefined;
  private selectedIndex = 0;
  private _focused = false;

  constructor(options: RecallPickerOptions) {
    this.index = options.index;
    this.cwd = options.cwd;
    this.currentSessionPath = options.currentSessionPath;
    this.theme = options.theme;
    this.keybindings = options.keybindings;
    this.done = options.done;
    this.scope = options.initialScope ?? "current";
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

  handleInput(data: string): void {
    if (this.keybindings.matches(data, "tui.select.cancel")) {
      this.done(undefined);
      return;
    }
    if (this.keybindings.matches(data, "tui.select.confirm")) {
      const selected = this.results[this.selectedIndex];
      if (selected) this.done(selected.session.path);
      return;
    }
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
    if (this.input.getValue() !== previous) this.refresh();
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
    this.searchableSessionCount = this.index.countSessions(scope);
    try {
      this.results = this.index.search(this.input.getValue(), { ...scope, limit: 50 });
      this.searchError = undefined;
    } catch (error) {
      this.results = [];
      this.searchError = error instanceof Error ? error.message : String(error);
    }
    this.selectedIndex = 0;
  }

  render(width: number): string[] {
    const innerWidth = Math.max(10, width - 2);
    const scopeLabel = this.scope === "current" ? "current folder" : "all projects";
    const title = this.theme.bold("Recall");
    const sessionLabel = this.searchableSessionCount === 1 ? "session" : "sessions";
    const stats = this.theme.fg(
      "muted",
      `${scopeLabel} · ${this.results.length} of ${this.searchableSessionCount} ${sessionLabel}`,
    );
    const titleGap = " ".repeat(Math.max(1, innerWidth - visibleWidth(title) - visibleWidth(stats)));
    const lines = [` ${truncateToWidth(`${title}${titleGap}${stats}`, innerWidth, "")} `];

    const inputLine = this.input.render(innerWidth)[0] ?? "";
    lines.push(` ${inputLine} `);

    if (this.searchError) {
      lines.push(` ${this.theme.fg("error", truncateToWidth(this.searchError, innerWidth, "…"))} `);
    } else if (this.results.length === 0) {
      lines.push(` ${this.theme.fg("muted", "No matching sessions")} `);
    } else {
      const start = Math.max(
        0,
        Math.min(this.selectedIndex - Math.floor(MAX_VISIBLE_RESULTS / 2), this.results.length - MAX_VISIBLE_RESULTS),
      );
      const visible = this.results.slice(start, start + MAX_VISIBLE_RESULTS);
      for (let offset = 0; offset < visible.length; offset++) {
        const result = visible[offset]!;
        const selected = start + offset === this.selectedIndex;
        const marker = selected ? "›" : " ";
        const current = this.currentSessionPath === result.session.path ? " · current" : "";
        const titleText = result.session.name || result.session.firstMessage || result.session.id;
        const metadata = `${formatAge(result.session.modified)} · ${result.session.messageCount} msgs${current}`;
        const availableTitle = Math.max(8, innerWidth - visibleWidth(metadata) - 4);
        const primary = `${marker} ${truncateToWidth(titleText, availableTitle, "…")}`;
        const gap = " ".repeat(Math.max(1, innerWidth - visibleWidth(primary) - visibleWidth(metadata)));
        let header = truncateToWidth(`${primary}${gap}${this.theme.fg("muted", metadata)}`, innerWidth, "");

        const match = result.matches[0];
        const tags = result.tags.map((tag) => `#${tag}`).join(" ");
        const previewText = match
          ? match.role === "tag"
            ? `tags: ${tags}`
            : `${tags ? `${tags} · ` : ""}${match.role}: ${match.snippet}`
          : `${shortenPath(result.session.cwd)} · ${result.session.id}`;
        let preview = truncateToWidth(`  ${previewText}`, innerWidth, "…");
        if (selected) {
          header = this.theme.bg("selectedBg", padToWidth(header, innerWidth));
          preview = this.theme.bg("selectedBg", padToWidth(this.theme.fg("dim", preview), innerWidth));
        } else {
          preview = this.theme.fg("dim", preview);
        }
        lines.push(` ${header} `, ` ${preview} `);
      }
    }

    const separator = this.theme.fg("dim", " · ");
    const hints = [
      keyHint("tui.select.up", "navigate"),
      keyHint("tui.select.confirm", "resume"),
      keyHint("tui.input.tab", "scope"),
      keyHint("tui.select.cancel", "close"),
    ].join(separator);
    lines.push(` ${truncateToWidth(hints, innerWidth, "…")} `);
    return lines;
  }
}
