// The Tantivy schema, query construction, message grouping, and recency ranking
// in this file are derived from zippoxer/recall (MIT, commit e605ab9).
// See THIRD_PARTY_NOTICES.md at the package root.

use napi_derive::napi;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};
use tantivy::collector::TopDocs;
use tantivy::columnar::{Column, StrColumn};
use tantivy::query::{
    BooleanQuery, BoostQuery, Occur, PhrasePrefixQuery, PhraseQuery, Query, QueryParser,
    TermSetQuery,
};
use tantivy::schema::*;
use tantivy::snippet::SnippetGenerator;
use tantivy::DocAddress;
use tantivy::{doc, Index, IndexReader, IndexWriter, ReloadPolicy};

fn napi_error(error: impl std::fmt::Display) -> napi::Error {
    napi::Error::from_reason(error.to_string())
}

/// Prefix matching for the token the user is still typing. Deliberately weaker than
/// a whole-term match, so completed words keep outranking partial ones.
const PREFIX_BOOST: f32 = 0.5;
const PREFIX_MAX_EXPANSIONS: u32 = 64;
const PREFIX_MIN_CHARS: usize = 2;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeMessage {
    role: String,
    content: String,
    timestamp: i64,
    entry_id: String,
    message_index: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeSession {
    id: String,
    path: String,
    cwd: String,
    timestamp: i64,
    tags: Vec<String>,
    messages: Vec<NativeMessage>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeTagChange {
    session_id: String,
    path: String,
    cwd: String,
    timestamp: i64,
    tags: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApplyChanges {
    delete_paths: Vec<String>,
    upserts: Vec<NativeSession>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeSearchResult {
    session_id: String,
    path: String,
    cwd: String,
    session_timestamp: i64,
    score: f32,
    matched_message_index: u64,
    role: String,
    message_timestamp: i64,
    entry_id: String,
    snippet: String,
    match_spans: Vec<(usize, usize)>,
    tags: Vec<String>,
}

/// A session's best matching document, ranked from fast fields alone.
struct GroupedMatch {
    address: DocAddress,
    score: f32,
    ranked_score: f32,
    message_index: u64,
    session_timestamp: i64,
}

/// Columnar readers for one segment, opened once per search.
struct SegmentColumns {
    session_id: Option<StrColumn>,
    message_index: Column<u64>,
    session_timestamp: Column<i64>,
}

impl SegmentColumns {
    /// Resolve a document's session id, caching each term ordinal's text per segment.
    fn session_id(
        &self,
        cache: &mut HashMap<(u32, u64), String>,
        segment_ord: u32,
        doc_id: u32,
    ) -> tantivy::Result<Option<String>> {
        let Some(column) = self.session_id.as_ref() else {
            return Ok(None);
        };
        let Some(ord) = column.term_ords(doc_id).next() else {
            return Ok(None);
        };
        if let Some(cached) = cache.get(&(segment_ord, ord)) {
            return Ok(Some(cached.clone()));
        }
        let mut bytes = Vec::new();
        if !column.ord_to_bytes(ord, &mut bytes)? {
            return Ok(None);
        }
        let session_id = String::from_utf8_lossy(&bytes).into_owned();
        cache.insert((segment_ord, ord), session_id.clone());
        Ok(Some(session_id))
    }
}

struct SessionIndex {
    index: Index,
    reader: IndexReader,
    session_id: Field,
    file_path: Field,
    cwd: Field,
    session_timestamp: Field,
    content: Field,
    tag_text: Field,
    tags: Field,
    tag_key: Field,
    doc_kind: Field,
    message_index: Field,
    role: Field,
    message_timestamp: Field,
    entry_id: Field,
}

impl SessionIndex {
    fn build_schema() -> Schema {
        let mut builder = Schema::builder();
        // session_id and message_index are FAST so grouping by session never touches
        // the document store: only the results that survive grouping are fetched.
        builder.add_text_field("session_id", STRING | STORED | FAST);
        builder.add_text_field("file_path", STRING | STORED);
        builder.add_text_field("cwd", STRING | STORED);
        builder.add_i64_field("session_timestamp", INDEXED | STORED | FAST);
        builder.add_text_field("content", TEXT | STORED);
        builder.add_text_field("tag_text", TEXT | STORED);
        builder.add_text_field("tags", STRING | STORED);
        builder.add_text_field("tag_key", STRING | STORED);
        builder.add_text_field("doc_kind", STRING | STORED);
        builder.add_u64_field("message_index", STORED | FAST);
        builder.add_text_field("role", STRING | STORED);
        builder.add_i64_field("message_timestamp", STORED);
        builder.add_text_field("entry_id", STRING | STORED);
        builder.build()
    }

    fn open_or_create(index_path: &Path) -> tantivy::Result<Self> {
        std::fs::create_dir_all(index_path)?;
        let schema = Self::build_schema();
        let index = if index_path.join("meta.json").exists() {
            Index::open_in_dir(index_path)?
        } else {
            Index::create_in_dir(index_path, schema.clone())?
        };
        let reader = index
            .reader_builder()
            .reload_policy(ReloadPolicy::Manual)
            .try_into()?;

        Ok(Self {
            reader,
            session_id: schema.get_field("session_id")?,
            file_path: schema.get_field("file_path")?,
            cwd: schema.get_field("cwd")?,
            session_timestamp: schema.get_field("session_timestamp")?,
            content: schema.get_field("content")?,
            tag_text: schema.get_field("tag_text")?,
            tags: schema.get_field("tags")?,
            tag_key: schema.get_field("tag_key")?,
            doc_kind: schema.get_field("doc_kind")?,
            message_index: schema.get_field("message_index")?,
            role: schema.get_field("role")?,
            message_timestamp: schema.get_field("message_timestamp")?,
            entry_id: schema.get_field("entry_id")?,
            index,
        })
    }

    fn writer(&self) -> tantivy::Result<IndexWriter> {
        self.index.writer(50_000_000)
    }

    fn delete_session(&self, writer: &mut IndexWriter, file_path: &str) {
        writer.delete_term(tantivy::Term::from_field_text(self.file_path, file_path));
    }

    fn index_session(
        &self,
        writer: &mut IndexWriter,
        session: NativeSession,
    ) -> tantivy::Result<()> {
        let session_timestamp = session.timestamp.div_euclid(1_000);
        let session_id = session.id.clone();
        let path = session.path.clone();
        let cwd = session.cwd.clone();
        for message in session.messages {
            writer.add_document(doc!(
                self.session_id => session_id.clone(),
                self.file_path => path.clone(),
                self.cwd => cwd.clone(),
                self.session_timestamp => session_timestamp,
                self.content => message.content,
                self.doc_kind => "message",
                self.message_index => message.message_index,
                self.role => message.role,
                self.message_timestamp => message.timestamp,
                self.entry_id => message.entry_id,
            ))?;
        }
        self.index_tag_document(
            writer,
            NativeTagChange {
                session_id,
                path,
                cwd,
                timestamp: session.timestamp,
                tags: session.tags,
            },
        )?;
        Ok(())
    }

    fn index_tag_document(
        &self,
        writer: &mut IndexWriter,
        change: NativeTagChange,
    ) -> tantivy::Result<()> {
        if change.tags.is_empty() {
            return Ok(());
        }

        let tag_text = change.tags.join(" ");
        let mut document = TantivyDocument::default();
        document.add_text(self.session_id, &change.session_id);
        document.add_text(self.file_path, &change.path);
        document.add_text(self.cwd, &change.cwd);
        document.add_i64(self.session_timestamp, change.timestamp.div_euclid(1_000));
        document.add_text(self.tag_text, &tag_text);
        document.add_text(self.tag_key, &change.session_id);
        document.add_text(self.doc_kind, "tag");
        document.add_u64(self.message_index, 0);
        document.add_text(self.role, "tag");
        document.add_i64(self.message_timestamp, change.timestamp);
        document.add_text(self.entry_id, "");
        for tag in change.tags {
            document.add_text(self.tags, tag);
        }
        writer.add_document(document)?;
        Ok(())
    }

    fn apply_changes(&self, changes: ApplyChanges) -> tantivy::Result<()> {
        let mut writer = self.writer()?;
        for file_path in changes.delete_paths {
            self.delete_session(&mut writer, &file_path);
        }
        for session in changes.upserts {
            self.delete_session(&mut writer, &session.path);
            self.index_session(&mut writer, session)?;
        }
        writer.commit()?;
        self.reader.reload()?;
        Ok(())
    }

    fn apply_tag_changes(&self, changes: Vec<NativeTagChange>) -> tantivy::Result<()> {
        if changes.is_empty() {
            return Ok(());
        }
        let mut writer = self.writer()?;
        for change in changes {
            writer.delete_term(tantivy::Term::from_field_text(
                self.tag_key,
                &change.session_id,
            ));
            self.index_tag_document(&mut writer, change)?;
        }
        writer.commit()?;
        self.reader.reload()?;
        Ok(())
    }

    fn reset(&self) -> tantivy::Result<()> {
        let mut writer = self.writer()?;
        writer.delete_all_documents()?;
        writer.commit()?;
        self.reader.reload()?;
        Ok(())
    }

    fn document_count(&self) -> u64 {
        self.reader.searcher().num_docs()
    }

    /// Prefix query for a trailing token, over both searchable fields.
    fn prefix_query(&self, token: &str) -> Box<dyn Query> {
        let clauses = [(self.content, 1.0), (self.tag_text, 4.0)]
            .into_iter()
            .map(|(field, boost)| {
                let mut prefix =
                    PhrasePrefixQuery::new(vec![tantivy::Term::from_field_text(field, token)]);
                prefix.set_max_expansions(PREFIX_MAX_EXPANSIONS);
                let clause: Box<dyn Query> = Box::new(BoostQuery::new(Box::new(prefix), boost));
                (Occur::Should, clause)
            })
            .collect();
        Box::new(BoostQuery::new(
            Box::new(BooleanQuery::new(clauses)),
            PREFIX_BOOST,
        ))
    }

    fn search(
        &self,
        query_str: &str,
        limit: usize,
        allowed_session_ids: Option<&[String]>,
        prefix_last_token: bool,
    ) -> tantivy::Result<Vec<NativeSearchResult>> {
        if query_str.trim().is_empty() || limit == 0 {
            return Ok(Vec::new());
        }
        if allowed_session_ids.is_some_and(|ids| ids.is_empty()) {
            return Ok(Vec::new());
        }

        let searcher = self.reader.searcher();
        let mut query_parser =
            QueryParser::for_index(&self.index, vec![self.content, self.tag_text]);
        query_parser.set_field_boost(self.tag_text, 4.0);
        let base_query = query_parser.parse_query(query_str)?;

        let mut tokens: Vec<(usize, String)> = Vec::new();
        if let Some(mut tokenizer) = self.index.tokenizers().get("default") {
            let mut token_stream = tokenizer.token_stream(query_str);
            token_stream.process(&mut |token| tokens.push((token.position, token.text.clone())));
        }

        // This is intentionally kept in lockstep with Recall's SessionIndex::search:
        // a 10x exact-phrase query is ORed with Tantivy's parsed base query.
        let mut lexical_query: Box<dyn Query> = if tokens.len() > 1 {
            let terms = tokens
                .iter()
                .map(|(position, text)| {
                    (
                        *position,
                        tantivy::Term::from_field_text(self.content, text),
                    )
                })
                .collect();
            let phrase_query = PhraseQuery::new_with_offset(terms);
            let boosted_phrase = BoostQuery::new(Box::new(phrase_query), 10.0);
            Box::new(BooleanQuery::new(vec![
                (Occur::Should, Box::new(boosted_phrase) as Box<dyn Query>),
                (Occur::Should, base_query),
            ]))
        } else {
            base_query
        };

        // Interactive typing: the final token is still being typed unless the caller
        // already ended it with whitespace, so match it as a prefix too.
        let typing_token = tokens
            .last()
            .map(|(_, text)| text.as_str())
            .filter(|_| prefix_last_token && !query_str.ends_with(char::is_whitespace))
            .filter(|text| text.chars().count() >= PREFIX_MIN_CHARS);
        if let Some(token) = typing_token {
            lexical_query = Box::new(BooleanQuery::new(vec![
                (Occur::Should, lexical_query),
                (Occur::Should, self.prefix_query(token)),
            ]));
        }
        let query: Box<dyn Query> = if let Some(session_ids) = allowed_session_ids {
            let allowed_query = TermSetQuery::new(
                session_ids
                    .iter()
                    .map(|id| tantivy::Term::from_field_text(self.session_id, id)),
            );
            Box::new(BooleanQuery::new(vec![
                (Occur::Must, lexical_query),
                (Occur::Must, Box::new(allowed_query) as Box<dyn Query>),
            ]))
        } else {
            lexical_query
        };

        // Recall intentionally over-fetches message documents before grouping. Grouping
        // and ranking read fast fields only; the document store, which holds every
        // message body, is touched once per returned session instead of once per
        // over-fetched document.
        let top_docs = searcher.search(&query, &TopDocs::with_limit(limit.saturating_mul(10)))?;
        let mut columns_by_segment: HashMap<u32, SegmentColumns> = HashMap::new();
        let mut session_ids: HashMap<(u32, u64), String> = HashMap::new();
        let mut grouped: HashMap<String, GroupedMatch> = HashMap::new();

        for (score, address) in top_docs {
            let columns = match columns_by_segment.entry(address.segment_ord) {
                std::collections::hash_map::Entry::Occupied(entry) => entry.into_mut(),
                std::collections::hash_map::Entry::Vacant(entry) => {
                    let fast_fields = searcher.segment_reader(address.segment_ord).fast_fields();
                    entry.insert(SegmentColumns {
                        session_id: fast_fields.str("session_id")?,
                        message_index: fast_fields.u64("message_index")?,
                        session_timestamp: fast_fields.i64("session_timestamp")?,
                    })
                }
            };
            let Some(session_id) =
                columns.session_id(&mut session_ids, address.segment_ord, address.doc_id)?
            else {
                continue;
            };
            let message_index = columns.message_index.first(address.doc_id).unwrap_or(0);
            let session_timestamp = columns.session_timestamp.first(address.doc_id).unwrap_or(0);
            // Later messages win ties, matching Recall's matched-message recency bonus.
            let ranked_score = score + message_index as f32 * 0.01;

            grouped
                .entry(session_id)
                .and_modify(|existing| {
                    if ranked_score > existing.ranked_score {
                        *existing = GroupedMatch {
                            address,
                            score,
                            ranked_score,
                            message_index,
                            session_timestamp,
                        };
                    }
                })
                .or_insert(GroupedMatch {
                    address,
                    score,
                    ranked_score,
                    message_index,
                    session_timestamp,
                });
        }

        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs_f64();
        let half_life_secs = 7.0 * 24.0 * 3_600.0;
        let recency_weight = |timestamp_secs: i64| -> f64 {
            let age = (now - timestamp_secs as f64).max(0.0);
            1.0 + (-age / half_life_secs).exp()
        };
        let mut ranked: Vec<GroupedMatch> = grouped.into_values().collect();
        ranked.sort_by(|left, right| {
            let left_final = left.score as f64 * recency_weight(left.session_timestamp);
            let right_final = right.score as f64 * recency_weight(right.session_timestamp);
            right_final
                .partial_cmp(&left_final)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        ranked.truncate(limit);

        let mut snippet_generator = SnippetGenerator::create(&searcher, &*query, self.content)?;
        snippet_generator.set_max_num_chars(200);
        ranked
            .into_iter()
            .map(|matched| self.hydrate(&searcher, &snippet_generator, &matched))
            .collect()
    }

    /// Read the stored fields for one grouped match. Called only for returned results.
    fn hydrate(
        &self,
        searcher: &tantivy::Searcher,
        snippet_generator: &SnippetGenerator,
        matched: &GroupedMatch,
    ) -> tantivy::Result<NativeSearchResult> {
        let document: TantivyDocument = searcher.doc(matched.address)?;
        let tags = text_fields(&document, self.tags);
        let (snippet, match_spans) = if text_field(&document, self.doc_kind) == "tag" {
            (
                tags.iter()
                    .map(|tag| format!("#{tag}"))
                    .collect::<Vec<_>>()
                    .join(" "),
                Vec::new(),
            )
        } else {
            let tantivy_snippet = snippet_generator.snippet_from_doc(&document);
            (
                tantivy_snippet.fragment().replace('\n', " "),
                tantivy_snippet
                    .highlighted()
                    .iter()
                    .map(|range| (range.start, range.end))
                    .collect(),
            )
        };
        Ok(NativeSearchResult {
            session_id: text_field(&document, self.session_id),
            path: text_field(&document, self.file_path),
            cwd: text_field(&document, self.cwd),
            session_timestamp: matched.session_timestamp.saturating_mul(1_000),
            score: matched.score,
            matched_message_index: matched.message_index,
            role: text_field(&document, self.role),
            message_timestamp: i64_field(&document, self.message_timestamp),
            entry_id: text_field(&document, self.entry_id),
            snippet,
            match_spans,
            tags,
        })
    }
}

fn text_field(document: &TantivyDocument, field: Field) -> String {
    document
        .get_first(field)
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .to_string()
}

fn text_fields(document: &TantivyDocument, field: Field) -> Vec<String> {
    document
        .get_all(field)
        .filter_map(|value| value.as_str().map(str::to_string))
        .collect()
}

fn i64_field(document: &TantivyDocument, field: Field) -> i64 {
    document
        .get_first(field)
        .and_then(|value| value.as_i64())
        .unwrap_or(0)
}

#[napi]
pub struct RecallNative {
    index: SessionIndex,
}

#[napi]
impl RecallNative {
    #[napi(constructor)]
    pub fn new(index_path: String) -> napi::Result<Self> {
        let index = SessionIndex::open_or_create(Path::new(&index_path)).map_err(napi_error)?;
        Ok(Self { index })
    }

    #[napi(js_name = "applyChanges")]
    pub fn apply_changes(&self, changes_json: String) -> napi::Result<()> {
        let changes: ApplyChanges = serde_json::from_str(&changes_json).map_err(napi_error)?;
        self.index.apply_changes(changes).map_err(napi_error)
    }

    #[napi(js_name = "applyTagChanges")]
    pub fn apply_tag_changes(&self, changes_json: String) -> napi::Result<()> {
        let changes: Vec<NativeTagChange> =
            serde_json::from_str(&changes_json).map_err(napi_error)?;
        self.index.apply_tag_changes(changes).map_err(napi_error)
    }

    #[napi]
    pub fn reset(&self) -> napi::Result<()> {
        self.index.reset().map_err(napi_error)
    }

    #[napi(js_name = "documentCount")]
    pub fn document_count(&self) -> u32 {
        self.index.document_count().min(u32::MAX as u64) as u32
    }

    #[napi]
    pub fn search(
        &self,
        query: String,
        limit: u32,
        allowed_session_ids_json: Option<String>,
        prefix_last_token: Option<bool>,
    ) -> napi::Result<String> {
        let allowed_session_ids = allowed_session_ids_json
            .map(|json| serde_json::from_str::<Vec<String>>(&json).map_err(napi_error))
            .transpose()?;
        let results = self
            .index
            .search(
                &query,
                limit as usize,
                allowed_session_ids.as_deref(),
                prefix_last_token.unwrap_or(false),
            )
            .map_err(napi_error)?;
        serde_json::to_string(&results).map_err(napi_error)
    }
}
