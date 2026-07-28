# pi-recall

Fast full-text search and native session resume for [Pi](https://github.com/earendil-works/pi).

Search prior Pi sessions, filter by `#tags`, and resume the one you want — from a
terminal picker or from the model via a built-in `recall` tool.

## Install

```bash
pi install npm:@joshbochu/pi-recall
```

Supported prebuilt addons: macOS (arm64, x64), Linux glibc (x64, arm64), Windows (x64).
Other platforms compile during install and need Rust/Cargo.

In-session manual (after install):

```text
/recall help
```

## Quick start

```text
/recall
/recall staging deploy
/recall #codebase
/recall authentication #codebase
```

| Key | Action |
| --- | --- |
| Type | Search (trailing tokens get prefix matching while you type) |
| ↑ / ↓ | Move selection |
| Enter | Resume the selected session |
| Tab | Toggle this folder ↔ all projects |
| Esc | Close |

`/recall-reindex` rebuilds the search index. Tags and config are kept.

## Commands

| Command | What it does |
| --- | --- |
| `/recall [query]` | Open the session picker, optionally with an initial query |
| `/recall search <query>` | Same as `/recall`, but safe when the query starts with a command word (`tag`, `help`, …) |
| `/recall help` | Show the in-session manual (`?`, `manual`, `-h`, `--help` also work) |
| `/recall tag #a #b` | Add manual tags to the **current** session |
| `/recall untag #a` | Remove tags from the current session |
| `/recall tags` | Show manual and generated tags for the current session |
| `/recall autotag` | Generate tags for the current session |
| `/recall autotag --all-untagged` | Confirm, then auto-tag every searchable session that has no tags |
| `/recall-reindex` | Discard and rebuild the Tantivy index |

## Session tags

Tags belong to the current session and survive `/recall-reindex`:

```text
/recall tag #codebase #rust #search
/recall tags
/recall untag #search
/recall autotag
/recall autotag --all-untagged
```

- `#tag` in a search query is an **exact** session filter (multiple hashtags AND together).
- Remaining words are ordinary full-text search over message content and tag text.
- Manual tags are never replaced by generated tags; an explicitly removed tag is suppressed from later generation.
- `--all-untagged` shows a confirmation overlay with session count and model before any API calls. Esc cancels.

Default auto-tag model is whatever Pi has selected. Override in `~/.pi/agent/pi-recall/config.json`:

```json
{
  "autoTags": {
    "model": "provider/model-id",
    "minimum": 3,
    "maximum": 7
  }
}
```

The model must exist in Pi’s registry with credentials configured. Auto-tagging sends a bounded
session excerpt to that provider (API usage and provider privacy terms apply).

Env overrides:

- `PI_RECALL_DATA_DIR` — durable tag/config directory (default `~/.pi/agent/pi-recall`)
- `PI_RECALL_CONFIG_FILE` — specific config file path

## Model tool

The agent gets one `recall` tool with actions:

| Action | Purpose |
| --- | --- |
| `search` | Full-text search (optional `query`, `scope`, `limit`) |
| `list` | List sessions (`scope`, `limit`) |
| `read` | Read a session by id / id prefix / path (`session`, `limit` = latest N messages) |

`scope` is `current` (this folder) or `all` (default for the tool). Output is capped at 800 lines / 40KB.

## Search behavior

- One Tantivy document per normalized user/assistant message, plus a metadata document for each tagged session.
- Consecutive same-role messages are joined before indexing.
- Message content and tag text are searchable; IDs, names, and paths are stored metadata.
- Ordinary terms use OR semantics; tag-text matches get a 4× field boost; multi-token queries also get a 10× exact-phrase OR clause.
- `#tag` filters are exact. Cwd / allowed-session constraints are applied natively before top-doc collection.
- Results are grouped by session; near-tied messages prefer later `messageIndex`; session scores get a seven-day recency boost.
- Snippets are ~200 characters with byte-offset match spans for highlighting.
- The **picker** prefix-expands an unfinished trailing token (≥2 chars, not a `#tag`, query not ending in whitespace). The **recall tool** keeps exact lexical semantics (no prefix expansion).

This is lexical search, not semantic retrieval: no embeddings, stemming, synonyms, or typo edit-distance.

Only user and assistant text (plus tags) are indexed. Thinking blocks, tool calls, and tool output are excluded.

## Storage

| Path | Contents |
| --- | --- |
| `~/.pi/agent/cache/pi-recall-tantivy-v3/` | Native Tantivy index |
| `~/.pi/agent/cache/pi-recall-v3.json` | File signatures + session summaries |
| `~/.pi/agent/pi-recall/tags-v1.json` | Tags (user data; kept across reindex) |

`PI_RECALL_CACHE_DIR` relocates both cache files. Unreadable sessions are skipped with a warning; searchable sessions remain indexed.

## Local development

```bash
git clone https://github.com/joshbochu/pi-recall.git
cd pi-recall
npm install
pi install /absolute/path/to/pi-recall
# or: pi -e /absolute/path/to/pi-recall
```

```bash
npm run check
npm run check:native
npm test
```

See [docs/architecture.md](docs/architecture.md) for component boundaries and the native bridge.

## Publishing

Every push to `main` publishes a new package version via GitHub Actions (`publish.yml`).
The workflow chooses the next patch from `max(package.json, npm latest)`, verifies the source,
builds every supported platform addon, bundles those artifacts into the root package, publishes
it, then records `release: vX.Y.Z` and tag `vX.Y.Z`. The publish job fails if any prebuilt is
missing, so a release cannot silently fall back to requiring Rust on supported platforms.

Trusted publisher on npm:

- Repository: `joshbochu/pi-recall`
- Workflow: `publish.yml`
- Allowed action: `npm publish`

Helpers: `npm run pack:platform`, `npm run version:next`, `npm run check:release`,
`npm run check:prebuilds`.

## License

MIT. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for required third-party notices.
