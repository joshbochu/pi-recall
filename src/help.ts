/** In-session manual shown by `/recall help`. Keep this concise; README is the full guide. */
export const RECALL_HELP = `pi-recall — search and resume prior Pi sessions

Install
  pi install npm:@joshbochu/pi-recall

Commands
  /recall [query]              Open the session picker (optional initial query)
  /recall search <query>       Same as /recall, but lets you search for words like "tag"
  /recall help                 Show this manual
  /recall-reindex              Discard and rebuild the search index

Picker
  Type to search · ↑/↓ move · Enter resume · Tab this folder ↔ all projects · Esc close
  #tag filters are exact session tags (AND). Other words are full-text search.
  Trailing tokens get prefix matching while you type (at least 2 characters).

Tags (current session; survive reindex)
  /recall tag #codebase #rust
  /recall untag #rust
  /recall tags
  /recall autotag
  /recall autotag --all-untagged

Model tool
  The agent gets a recall tool with actions: search, list, read
  (scope current|all, optional query/session/limit).

Notes
  Lexical search (not semantic). User/assistant text + tags are indexed;
  thinking/tool output is not. Unreadable sessions are reported and skipped.
  Full guide: https://github.com/joshbochu/pi-recall#readme`;

export const HELP_SUBCOMMANDS = new Set(["help", "?", "manual", "--help", "-h"]);
