# pi-recall

Fast full-text search and native session resume for [Pi](https://github.com/earendil-works/pi).

`pi-recall` is a hybrid TypeScript/Rust Pi extension. Pi supplies session parsing, the overlay, and
native `ctx.switchSession()` handling; a small Rust N-API addon supplies the Tantivy index and ranking
engine.

## Prerequisites and install

The package builds a platform-native addon during installation, so Rust and Cargo must be available.

```bash
pi install npm:@joshbochu/pi-recall
```

For local development or installation from a checkout:

```bash
git clone https://github.com/joshbochu/pi-recall.git
cd pi-recall
npm install
pi install /absolute/path/to/pi-recall
```

Or try the checkout without installing it:

```bash
pi -e /absolute/path/to/pi-recall
```

## Use

Open the Pi-native picker:

```text
/recall
/recall staging deploy
/recall #codebase
/recall authentication #codebase
```

While it is open:

- Type to search.
- Up/Down changes the selected session.
- Tab switches between the current folder and all projects.
- Enter resumes through Pi's native session switch.
- Escape closes the picker.

The header reports displayed results against the searchable corpus, such as `50 of 120 sessions`.
Force a clean rebuild with `/recall-reindex`; ordinary use automatically reconciles new, modified,
and deleted sessions.

The model also receives one `recall` tool with `search`, `list`, and `read` actions, allowing it to
retrieve prior Pi work without shelling out to a separate application.

### Session tags

Tags belong to the current session and survive index rebuilds:

```text
/recall tag #codebase #rust #search
/recall tags
/recall untag #search
/recall autotag
/recall autotag --all-untagged
```

Because those words are command names, use `/recall search tag`, `/recall search tags`, or similar
when you want to search for the literal command word.

`/recall autotag` generates tags for the current session. `--all-untagged` finds every searchable
session with no manual or generated tags, then shows an overlay containing the exact session count
and model before making any calls. Escape cancels the progress overlay. Manual tags are never
replaced by generated tags, and an explicitly removed tag is suppressed from later generation.

Auto-tagging uses Pi's currently selected model by default. To choose a model and tag count, create
`~/.pi/agent/pi-recall/config.json`:

```json
{
  "autoTags": {
    "model": "provider/model-id",
    "minimum": 3,
    "maximum": 7
  }
}
```

The model must exist in Pi's model registry and have configured credentials. Auto-tagging sends a
bounded excerpt of each selected session to that provider, so API usage and provider privacy terms
apply. `PI_RECALL_DATA_DIR` relocates the durable tag/config directory;
`PI_RECALL_CONFIG_FILE` can point at a specific config file.

## Search behavior

The native search engine behaves as follows:

- One Tantivy document is indexed per normalized user/assistant message, plus one metadata document
  for each tagged session.
- Consecutive messages with the same role are joined before indexing.
- Message content and tag text are searchable; session IDs, names, and paths remain stored metadata.
- Tantivy's default `QueryParser` handles ordinary terms with OR semantics. Tag-text matches receive
  a 4x field boost.
- `#tag` is an exact session filter. Multiple hashtags use AND, and remaining words still use the
  normal content/tag query (for example, `authentication #codebase`).
- Multi-token queries also receive a 10x exact-phrase query joined with the base query using OR.
- Search retrieves `limit * 10` documents, groups them by session ID, and keeps one representative
  match per session. Cwd and exact-tag constraints become a native `TermSetQuery`, excluding
  irrelevant sessions before Tantivy collects its top documents.
- When message scores are close, later message positions are preferred by `messageIndex * 0.01`.
- Final session ordering multiplies relevance by `1 + exp(-age / 7 days)`, giving current sessions up
  to a 2x boost.
- Snippets come from Tantivy's `SnippetGenerator` with a 200-character target.
- The picker requests Recall's 50-session limit.

This is lexical search, not semantic retrieval. There is deliberately no prefix search, edit-distance
typo matching, stemming, synonym expansion, or embedding model layered on top of the results.

## Storage and incremental refresh

The native index lives under `~/.pi/agent/cache/pi-recall-tantivy-v2/`. File signatures and Pi session
summaries live in `~/.pi/agent/cache/pi-recall-v3.json`. Set `PI_RECALL_CACHE_DIR` to place both in a
different directory.

Tags live separately at `~/.pi/agent/pi-recall/tags-v1.json`. This file is user data, not a cache, and
is intentionally preserved by `/recall-reindex`.

The Pi adapter uses millisecond file timestamps, cache-version validation, atomic state writes,
corrupt-index recovery, and deletion reconciliation.

Only user and assistant text is indexed alongside tag metadata. Thinking blocks, tool calls, and tool
output are excluded to avoid duplicated command output.

## Development

```bash
npm run check
npm run check:native
npm test
```

`npm test` rebuilds the native addon incrementally before running integration tests. Both Node and Bun
load the generated N-API module.

See [docs/architecture.md](docs/architecture.md) for the component boundaries, native bridge, data
flow, and operational tradeoffs.

## License

MIT. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for required third-party notices.
