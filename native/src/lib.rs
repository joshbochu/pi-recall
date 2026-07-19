// The Tantivy schema, query construction, message grouping, and recency ranking
// in this file are derived from zippoxer/recall (MIT, commit e605ab9).
// See THIRD_PARTY_NOTICES.md at the package root.

use napi_derive::napi;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tantivy::collector::TopDocs;
use tantivy::query::{
    BooleanQuery, BoostQuery, Occur, PhraseQuery, Query, QueryParser, TermSetQuery,
};
use tantivy::schema::*;
use tantivy::snippet::SnippetGenerator;
use tantivy::{doc, Index, IndexReader, IndexWriter, Order, ReloadPolicy};

fn napi_error(error: impl std::fmt::Display) -> napi::Error {
    napi::Error::from_reason(error.to_string())
}

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
        builder.add_text_field("session_id", STRING | STORED);
        builder.add_text_field("file_path", STRING | STORED);
        builder.add_text_field("cwd", STRING | STORED);
        builder.add_i64_field("session_timestamp", INDEXED | STORED | FAST);
        builder.add_text_field("content", TEXT | STORED);
        builder.add_text_field("tag_text", TEXT | STORED);
        builder.add_text_field("tags", STRING | STORED);
        builder.add_text_field("tag_key", STRING | STORED);
        builder.add_text_field("doc_kind", STRING | STORED);
        builder.add_u64_field("message_index", STORED);
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

    fn search(
        &self,
        query_str: &str,
        limit: usize,
        allowed_session_ids: Option<&[String]>,
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

        // This is intentionally kept in lockstep with Recall's SessionIndex::search:
        // a 10x exact-phrase query is ORed with Tantivy's parsed base query.
        let lexical_query: Box<dyn Query> =
            if let Some(mut tokenizer) = self.index.tokenizers().get("default") {
                let mut terms: Vec<(usize, tantivy::Term)> = Vec::new();
                let mut token_stream = tokenizer.token_stream(query_str);
                token_stream.process(&mut |token| {
                    terms.push((
                        token.position,
                        tantivy::Term::from_field_text(self.content, &token.text),
                    ));
                });

                if terms.len() > 1 {
                    let phrase_query = PhraseQuery::new_with_offset(terms);
                    let boosted_phrase = BoostQuery::new(Box::new(phrase_query), 10.0);
                    Box::new(BooleanQuery::new(vec![
                        (Occur::Should, Box::new(boosted_phrase) as Box<dyn Query>),
                        (Occur::Should, base_query),
                    ]))
                } else {
                    base_query
                }
            } else {
                base_query
            };
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

        let mut snippet_generator = SnippetGenerator::create(&searcher, &*query, self.content)?;
        snippet_generator.set_max_num_chars(200);

        // Recall intentionally over-fetches message documents before grouping.
        let top_docs = searcher.search(&query, &TopDocs::with_limit(limit.saturating_mul(10)))?;
        let mut grouped: HashMap<String, (f32, NativeSearchResult)> = HashMap::new();

        for (score, doc_addr) in top_docs {
            let document: TantivyDocument = searcher.doc(doc_addr)?;
            let session_id = text_field(&document, self.session_id);
            let message_index = u64_field(&document, self.message_index);
            let is_tag_match = text_field(&document, self.doc_kind) == "tag";
            let tags = text_fields(&document, self.tags);
            let (snippet, match_spans) = if is_tag_match {
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
            let result = NativeSearchResult {
                session_id: session_id.clone(),
                path: text_field(&document, self.file_path),
                cwd: text_field(&document, self.cwd),
                session_timestamp: i64_field(&document, self.session_timestamp)
                    .saturating_mul(1_000),
                score,
                matched_message_index: message_index,
                role: text_field(&document, self.role),
                message_timestamp: i64_field(&document, self.message_timestamp),
                entry_id: text_field(&document, self.entry_id),
                snippet,
                match_spans,
                tags,
            };

            grouped
                .entry(session_id)
                .and_modify(|(existing_score, existing_result)| {
                    let message_recency_bonus = message_index as f32 * 0.01;
                    if score + message_recency_bonus > *existing_score {
                        *existing_score = score + message_recency_bonus;
                        *existing_result = result.clone();
                    }
                })
                .or_insert((score, result));
        }

        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs_f64();
        let half_life_secs = 7.0 * 24.0 * 3_600.0;
        let mut results: Vec<_> = grouped.into_values().map(|(_, result)| result).collect();
        results.sort_by(|left, right| {
            let left_age = (now - left.session_timestamp as f64 / 1_000.0).max(0.0);
            let right_age = (now - right.session_timestamp as f64 / 1_000.0).max(0.0);
            let left_recency = 1.0 + (-left_age / half_life_secs).exp();
            let right_recency = 1.0 + (-right_age / half_life_secs).exp();
            let left_final = left.score as f64 * left_recency;
            let right_final = right.score as f64 * right_recency;
            right_final
                .partial_cmp(&left_final)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        results.truncate(limit);
        Ok(results)
    }

    fn recent(&self, limit: usize) -> tantivy::Result<Vec<NativeSearchResult>> {
        if limit == 0 {
            return Ok(Vec::new());
        }
        let searcher = self.reader.searcher();
        let top_docs = searcher.search(
            &tantivy::query::AllQuery,
            &TopDocs::with_limit(limit.saturating_mul(100))
                .order_by_fast_field::<i64>("session_timestamp", Order::Desc),
        )?;
        let mut grouped: HashMap<String, NativeSearchResult> = HashMap::new();

        for (_timestamp, doc_addr) in top_docs {
            let document: TantivyDocument = searcher.doc(doc_addr)?;
            let session_id = text_field(&document, self.session_id);
            if grouped.contains_key(&session_id) {
                continue;
            }
            let content = text_field(&document, self.content);
            grouped.insert(
                session_id.clone(),
                NativeSearchResult {
                    session_id,
                    path: text_field(&document, self.file_path),
                    cwd: text_field(&document, self.cwd),
                    session_timestamp: i64_field(&document, self.session_timestamp)
                        .saturating_mul(1_000),
                    score: 0.0,
                    matched_message_index: u64_field(&document, self.message_index),
                    role: text_field(&document, self.role),
                    message_timestamp: i64_field(&document, self.message_timestamp),
                    entry_id: text_field(&document, self.entry_id),
                    snippet: content
                        .chars()
                        .take(200)
                        .collect::<String>()
                        .replace('\n', " "),
                    match_spans: Vec::new(),
                    tags: text_fields(&document, self.tags),
                },
            );
            if grouped.len() >= limit {
                break;
            }
        }

        let mut results: Vec<_> = grouped.into_values().collect();
        results.sort_by(|left, right| right.session_timestamp.cmp(&left.session_timestamp));
        results.truncate(limit);
        Ok(results)
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

fn u64_field(document: &TantivyDocument, field: Field) -> u64 {
    document
        .get_first(field)
        .and_then(|value| value.as_u64())
        .unwrap_or(0)
}

#[napi]
pub struct RecallNative {
    index: SessionIndex,
    index_path: PathBuf,
}

#[napi]
impl RecallNative {
    #[napi(constructor)]
    pub fn new(index_path: String) -> napi::Result<Self> {
        let index_path = PathBuf::from(index_path);
        let index = SessionIndex::open_or_create(&index_path).map_err(napi_error)?;
        Ok(Self { index, index_path })
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
    ) -> napi::Result<String> {
        let allowed_session_ids = allowed_session_ids_json
            .map(|json| serde_json::from_str::<Vec<String>>(&json).map_err(napi_error))
            .transpose()?;
        let results = self
            .index
            .search(&query, limit as usize, allowed_session_ids.as_deref())
            .map_err(napi_error)?;
        serde_json::to_string(&results).map_err(napi_error)
    }

    #[napi]
    pub fn recent(&self, limit: u32) -> napi::Result<String> {
        let results = self.index.recent(limit as usize).map_err(napi_error)?;
        serde_json::to_string(&results).map_err(napi_error)
    }

    #[napi(js_name = "indexPath")]
    pub fn index_path(&self) -> String {
        self.index_path.to_string_lossy().into_owned()
    }
}
