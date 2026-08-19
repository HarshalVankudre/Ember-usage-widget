//! Read-only Oh My Pi statistics importer.
//!
//! OMP's dashboard is backed by `~/.omp/stats.db`. Ember reads the same
//! per-request accounting columns from that SQLite database (including its WAL)
//! and never selects prompts, responses, tool payloads, or error messages.
//! First-party Anthropic rows join Claude; first-party OpenAI/OpenAI-Codex rows
//! join Codex. All other OMP providers and models are deliberately ignored.

use super::claude_pricing::price_for as claude_price_for;
use super::codex_pricing::price_for as codex_price_for;
use super::model_attribution::{is_claude_model, is_openai_model};
use rusqlite::{Connection, OpenFlags};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

const QUERY_WITH_NO_CACHE_COST: &str = r#"
SELECT
  session_file,
  folder,
  model,
  provider,
  timestamp,
  input_tokens,
  output_tokens,
  cache_read_tokens,
  cache_write_tokens,
  cost_input,
  cost_output,
  cost_cache_read,
  cost_cache_write,
  cost_total,
  cost_no_cache_input
FROM messages
WHERE provider IN ('anthropic', 'openai', 'openai-codex')
ORDER BY timestamp, id
"#;

const QUERY_LEGACY: &str = r#"
SELECT
  session_file,
  folder,
  model,
  provider,
  timestamp,
  input_tokens,
  output_tokens,
  cache_read_tokens,
  cache_write_tokens,
  cost_input,
  cost_output,
  cost_cache_read,
  cost_cache_write,
  cost_total,
  NULL AS cost_no_cache_input
FROM messages
WHERE provider IN ('anthropic', 'openai', 'openai-codex')
ORDER BY timestamp, id
"#;

#[derive(Clone, Debug, PartialEq, Eq, Default)]
struct DbSignature(Vec<(String, u64, u128)>);

pub struct Aggregate {
    pub buckets: Vec<Value>,
    pub file_count: usize,
}

#[derive(Default)]
struct State {
    last_signature: DbSignature,
    memo: Option<Arc<Aggregate>>,
}

static STATE: Mutex<State> = Mutex::new(State {
    last_signature: DbSignature(Vec::new()),
    memo: None,
});

#[derive(Clone, Debug)]
struct DbRow {
    session_file: String,
    folder: String,
    model: String,
    provider: String,
    timestamp: f64,
    input: f64,
    output: f64,
    cache_read: f64,
    cache_write: f64,
    cost_input: f64,
    cost_output: f64,
    cost_cache_read: f64,
    cost_cache_write: f64,
    cost_total: f64,
    cost_no_cache_input: Option<f64>,
}

pub fn data_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".omp")
}

pub fn stats_db_path() -> PathBuf {
    data_dir().join("stats.db")
}

fn sessions_dir() -> PathBuf {
    std::env::var("PI_CODING_AGENT_DIR")
        .ok()
        .filter(|path| !path.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| data_dir().join("agent"))
        .join("sessions")
}

pub fn init(_user_data: &Path) {
    let mut state = STATE.lock().unwrap();
    state.last_signature = DbSignature::default();
    state.memo = None;
}

/// Official price refreshes can change whether a stored model is considered
/// priced even when the OMP database itself has not changed.
pub fn invalidate() {
    STATE.lock().unwrap().memo = None;
}

fn db_signature() -> DbSignature {
    let db = stats_db_path();
    let mut files = vec![db.clone()];
    files.push(PathBuf::from(format!("{}-wal", db.to_string_lossy())));
    files.push(PathBuf::from(format!("{}-shm", db.to_string_lossy())));
    DbSignature(
        files
            .into_iter()
            .map(|path| {
                let metadata = std::fs::metadata(&path).ok();
                let size = metadata.as_ref().map(|m| m.len()).unwrap_or(0);
                let modified = metadata
                    .and_then(|m| m.modified().ok())
                    .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|duration| duration.as_nanos())
                    .unwrap_or(0);
                (path.to_string_lossy().into_owned(), size, modified)
            })
            .collect(),
    )
}

fn has_column(connection: &Connection, table: &str, column: &str) -> rusqlite::Result<bool> {
    let mut statement = connection.prepare(&format!("PRAGMA table_info({table})"))?;
    let names = statement.query_map([], |row| row.get::<_, String>(1))?;
    for name in names {
        if name? == column {
            return Ok(true);
        }
    }
    Ok(false)
}

fn read_rows() -> rusqlite::Result<Vec<DbRow>> {
    let connection = Connection::open_with_flags(
        stats_db_path(),
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    connection.busy_timeout(Duration::from_secs(2))?;
    let query = if has_column(&connection, "messages", "cost_no_cache_input")? {
        QUERY_WITH_NO_CACHE_COST
    } else {
        QUERY_LEGACY
    };
    let mut statement = connection.prepare(query)?;
    let rows = statement.query_map([], |row| {
        Ok(DbRow {
            session_file: row.get(0)?,
            folder: row.get(1)?,
            model: row.get(2)?,
            provider: row.get(3)?,
            timestamp: row.get::<_, i64>(4)? as f64,
            input: row.get::<_, i64>(5)? as f64,
            output: row.get::<_, i64>(6)? as f64,
            cache_read: row.get::<_, i64>(7)? as f64,
            cache_write: row.get::<_, i64>(8)? as f64,
            cost_input: row.get(9)?,
            cost_output: row.get(10)?,
            cost_cache_read: row.get(11)?,
            cost_cache_write: row.get(12)?,
            cost_total: row.get(13)?,
            cost_no_cache_input: row.get(14)?,
        })
    })?;
    rows.collect()
}

fn provider_of(provider: &str, model: &str) -> Option<&'static str> {
    if provider == "anthropic" && is_claude_model(model) {
        Some("claude")
    } else if matches!(provider, "openai" | "openai-codex") && is_openai_model(model) {
        Some("codex")
    } else {
        None
    }
}

fn session_of(session_file: &str) -> String {
    let file = Path::new(session_file);
    let root = sessions_dir();
    let rel = file.strip_prefix(&root).unwrap_or(file);
    let parts: Vec<_> = rel.components().collect();
    let id = if parts.len() == 2 {
        file.file_stem()
            .map(|stem| stem.to_string_lossy().into_owned())
            .unwrap_or_else(|| "unknown".to_string())
    } else {
        parts
            .get(1)
            .map(|part| part.as_os_str().to_string_lossy().into_owned())
            .unwrap_or_else(|| {
                file.file_stem()
                    .map(|stem| stem.to_string_lossy().into_owned())
                    .unwrap_or_else(|| "unknown".to_string())
            })
    };
    format!("omp:{id}")
}

fn officially_priced(provider: &str, model: &str, date: &str) -> bool {
    if provider == "claude" {
        claude_price_for(model, Some(date)).is_some()
    } else {
        codex_price_for(model).is_some()
    }
}

#[derive(Default)]
struct Bucket {
    provider: String,
    date: String,
    hour: u32,
    minute: u32,
    model: String,
    project: String,
    session: String,
    msgs: u64,
    input: f64,
    output: f64,
    cache_read: f64,
    cache_write: f64,
    cost: f64,
    c_in: f64,
    c_out: f64,
    c_cr: f64,
    c_cw: f64,
    cache_savings: f64,
    priced_calls: u64,
    unpriced_calls: u64,
    pricing_source: String,
}

impl Bucket {
    fn add(&mut self, row: &DbRow, priced: bool) {
        self.msgs += 1;
        self.input += row.input.max(0.0);
        self.output += row.output.max(0.0);
        self.cache_read += row.cache_read.max(0.0);
        self.cache_write += row.cache_write.max(0.0);
        if priced {
            self.cost += row.cost_total.max(0.0);
            self.c_in += row.cost_input.max(0.0);
            self.c_out += row.cost_output.max(0.0);
            self.c_cr += row.cost_cache_read.max(0.0);
            self.c_cw += row.cost_cache_write.max(0.0);
            let prompt_cost = row.cost_input + row.cost_cache_read + row.cost_cache_write;
            self.cache_savings += row
                .cost_no_cache_input
                .map(|uncached| (uncached - prompt_cost).max(0.0))
                .unwrap_or(0.0);
            self.priced_calls += 1;
            self.pricing_source = "Oh My Pi stats database".to_string();
        } else {
            self.unpriced_calls += 1;
            self.pricing_source = "No official price".to_string();
        }
    }

    fn into_json(self, project_deleted: bool) -> Value {
        json!({
            "provider": self.provider,
            "date": self.date, "hour": self.hour, "minute": self.minute,
            "model": self.model, "project": self.project, "session": self.session,
            "msgs": self.msgs,
            "input": self.input, "output": self.output,
            "cacheRead": self.cache_read, "cacheWrite": self.cache_write, "reasoning": 0,
            "cost": self.cost, "costMin": self.cost, "costMax": self.cost,
            "cIn": self.c_in, "cOut": self.c_out, "cCr": self.c_cr,
            "cCw": self.c_cw, "cRs": 0, "cTool": 0,
            "cacheSavings": self.cache_savings,
            "priced": self.priced_calls > 0 && self.unpriced_calls == 0,
            "estimated": false,
            "pricedCalls": self.priced_calls, "unpricedCalls": self.unpriced_calls,
            "longContextCalls": 0, "fastCalls": 0, "usRegionCalls": 0,
            "pricingSource": self.pricing_source,
            "projectDeleted": project_deleted,
        })
    }
}

fn parse_rows<F: Fn(&str) -> bool>(rows: &[DbRow], exists: F) -> Vec<Value> {
    let mut project_live: HashMap<String, bool> = HashMap::new();
    let mut buckets: BTreeMap<String, Bucket> = BTreeMap::new();
    for row in rows {
        let Some(provider) = provider_of(&row.provider, &row.model) else {
            continue;
        };
        let Some(parts) = crate::local_parts_ms(row.timestamp) else {
            continue;
        };
        let session = session_of(&row.session_file);
        let project = if row.folder.is_empty() {
            "unknown".to_string()
        } else {
            row.folder.clone()
        };
        let live = project_live.entry(project.clone()).or_insert(false);
        *live |= exists(&row.session_file);
        let key = format!(
            "{}|{}|{}|{}|{}|{}|{}",
            provider, parts.date, parts.hour, parts.minute, row.model, project, session,
        );
        let bucket = buckets.entry(key).or_insert_with(|| Bucket {
            provider: provider.to_string(),
            date: parts.date.clone(),
            hour: parts.hour,
            minute: parts.minute,
            model: row.model.clone(),
            project: project.clone(),
            session: session.clone(),
            ..Default::default()
        });
        bucket.add(row, officially_priced(provider, &row.model, &parts.date));
    }

    buckets
        .into_values()
        .map(|bucket| {
            let deleted = !project_live.get(&bucket.project).copied().unwrap_or(false);
            bucket.into_json(deleted)
        })
        .collect()
}

pub fn aggregate() -> Arc<Aggregate> {
    let signature = db_signature();
    {
        let state = STATE.lock().unwrap();
        if signature == state.last_signature {
            if let Some(memo) = &state.memo {
                return memo.clone();
            }
        }
    }

    let rows = match read_rows() {
        Ok(rows) => rows,
        Err(error) => {
            let state = STATE.lock().unwrap();
            if let Some(memo) = &state.memo {
                eprintln!("Oh My Pi stats scan failed, keeping last snapshot: {error}");
                return memo.clone();
            }
            Vec::new()
        }
    };
    let buckets = parse_rows(&rows, |file| Path::new(file).exists());
    let aggregate = Arc::new(Aggregate {
        buckets,
        file_count: usize::from(stats_db_path().exists()),
    });
    let mut state = STATE.lock().unwrap();
    // SQLite may checkpoint or extend the WAL while a query is open. Record
    // the post-query state so an unchanged database hits the memo next time.
    state.last_signature = db_signature();
    state.memo = Some(aggregate.clone());
    aggregate
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(provider: &str, model: &str, input: i64, cost: f64) -> DbRow {
        DbRow {
            session_file: format!(
                "{}\\project\\2026-08-17_session.jsonl",
                sessions_dir().to_string_lossy()
            ),
            folder: "-Desktop-project".to_string(),
            model: model.to_string(),
            provider: provider.to_string(),
            timestamp: 1_786_994_385_849.0,
            input: input as f64,
            output: 20.0,
            cache_read: 30.0,
            cache_write: 40.0,
            cost_input: cost / 5.0,
            cost_output: cost / 5.0,
            cost_cache_read: cost / 5.0,
            cost_cache_write: cost / 5.0,
            cost_total: cost,
            cost_no_cache_input: Some(cost),
        }
    }

    #[test]
    fn maps_only_first_party_database_rows_to_the_two_ember_providers() {
        let rows = vec![
            row("anthropic", "claude-opus-5", 10, 1.0),
            row("openai-codex", "gpt-5.6-sol", 11, 2.0),
            row("openai", "gpt-5.6-sol", 12, 0.0),
            row("openrouter", "claude-opus-5", 100, 9.0),
            row("google", "gemini-3-pro", 100, 9.0),
        ];
        let buckets = parse_rows(&rows, |_| true);
        assert_eq!(buckets.len(), 2);
        let claude = buckets.iter().find(|b| b["provider"] == "claude").unwrap();
        let codex = buckets.iter().find(|b| b["provider"] == "codex").unwrap();
        assert_eq!(claude["model"], "claude-opus-5");
        assert_eq!(claude["msgs"], 1);
        assert_eq!(codex["model"], "gpt-5.6-sol");
        assert_eq!(codex["msgs"], 2, "both OMP OpenAI provider ids merge");
        assert_eq!(codex["input"], 23.0);
    }

    #[test]
    fn uses_the_dashboard_database_cost_instead_of_repricing_tokens() {
        let buckets = parse_rows(&[row("anthropic", "claude-fable-5", 1, 12.34)], |_| true);
        assert_eq!(buckets[0]["cost"], 12.34);
        assert_eq!(buckets[0]["costMin"], 12.34);
        assert_eq!(buckets[0]["costMax"], 12.34);
        assert_eq!(buckets[0]["pricingSource"], "Oh My Pi stats database");
    }

    #[test]
    fn database_rows_survive_deleted_session_files() {
        let buckets = parse_rows(&[row("openai-codex", "gpt-5.6-sol", 1, 1.0)], |_| false);
        assert_eq!(buckets[0]["projectDeleted"], true);
    }

    #[test]
    fn query_selects_only_accounting_and_attribution_columns() {
        let query = QUERY_WITH_NO_CACHE_COST.to_lowercase();
        assert!(query.contains("from messages"));
        assert!(query.contains("input_tokens"));
        assert!(query.contains("cost_total"));
        for sensitive in ["content", "error_message", "tool_calls", "user_messages"] {
            assert!(
                !query.contains(sensitive),
                "query must not select {sensitive}"
            );
        }
    }
}
