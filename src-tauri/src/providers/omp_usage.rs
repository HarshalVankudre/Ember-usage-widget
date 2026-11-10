//! Read-only Oh My Pi statistics importer.
//!
//! OMP's dashboard is backed by `~/.omp/stats.db`. Ember reads the same
//! per-request accounting columns from that SQLite database (including its WAL)
//! and never selects prompts, responses, tool payloads, or error messages.
//! First-party Anthropic rows join Claude; first-party OpenAI/OpenAI-Codex rows
//! join Codex. All other OMP providers and models are deliberately ignored.

use super::claude_pricing::{cost_of as claude_cost_of, ClaudeUsage};
use super::codex_pricing::{cost_of as codex_cost_of, CodexUsage};
use super::model_attribution::{is_claude_model, is_openai_model};
use rusqlite::{Connection, OpenFlags};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

const QUERY: &str = r#"
SELECT
  session_file,
  folder,
  model,
  provider,
  timestamp,
  input_tokens,
  output_tokens,
  cache_read_tokens,
  cache_write_tokens
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

fn read_rows() -> rusqlite::Result<Vec<DbRow>> {
    let connection = Connection::open_with_flags(
        stats_db_path(),
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    connection.busy_timeout(Duration::from_secs(2))?;
    let mut statement = connection.prepare(QUERY)?;
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

/// What a row is worth at the official rates — the same tables, and the same
/// rate-on-the-day rule, that price native Claude Code and Codex calls.
///
/// OMP stores a cost of its own, frozen from whatever price list it shipped
/// with on the day. Using that would value one model at two prices depending
/// on which tool made the call, so only the token counts are taken from OMP.
struct RowCost {
    total: f64,
    cost_min: f64,
    cost_max: f64,
    c_in: f64,
    c_out: f64,
    c_cr: f64,
    c_cw: f64,
    cache_savings: f64,
    estimated: bool,
    long_context: bool,
    known: bool,
    source: String,
}

fn price_row(provider: &str, row: &DbRow, date: &str) -> RowCost {
    let (input, output) = (row.input.max(0.0), row.output.max(0.0));
    let (cache_read, cache_write) = (row.cache_read.max(0.0), row.cache_write.max(0.0));
    if provider == "claude" {
        // OMP writes to the 5-minute cache.
        let c = claude_cost_of(&row.model, &ClaudeUsage {
            date: Some(date), input, output, cache_read, cache_w5m: cache_write,
            ..Default::default()
        });
        RowCost {
            total: c.total, cost_min: c.cost_min, cost_max: c.cost_max,
            c_in: c.input, c_out: c.output, c_cr: c.cache_read, c_cw: c.cache_write,
            cache_savings: c.cache_savings, estimated: c.estimated,
            long_context: c.long_context, known: c.known, source: c.source,
        }
    } else {
        let c = codex_cost_of(&row.model, &CodexUsage {
            input, output, cached: cache_read, cache_write,
            // A zero is "not reported", as in Codex's own rollouts.
            cache_write_known: cache_write > 0.0,
            total_input: input + cache_read + cache_write,
            date: Some(date),
            ..Default::default()
        });
        RowCost {
            total: c.total, cost_min: c.cost_min, cost_max: c.cost_max,
            c_in: c.input, c_out: c.output, c_cr: c.cached, c_cw: c.cache_write,
            cache_savings: c.cache_savings, estimated: c.estimated,
            long_context: c.long_context, known: c.known, source: c.source,
        }
    }
}

/// OMP names a project by its folder path with the separators turned into
/// dashes ("-Desktop-modal-finder"). Claude Code does the same, so the same
/// reading gives the same label and one folder stays one project.
fn project_of_folder(folder: &str) -> String {
    if folder.is_empty() {
        return "unknown".to_string();
    }
    let name = folder.trim_matches('-').replace('-', "/");
    if name.is_empty() { "~ (home)".to_string() } else { name }
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
    cost_min: f64,
    cost_max: f64,
    c_in: f64,
    c_out: f64,
    c_cr: f64,
    c_cw: f64,
    cache_savings: f64,
    priced_calls: u64,
    unpriced_calls: u64,
    long_context_calls: u64,
    estimated: bool,
    pricing_source: String,
}

impl Bucket {
    fn add(&mut self, row: &DbRow, c: RowCost) {
        self.msgs += 1;
        self.input += row.input.max(0.0);
        self.output += row.output.max(0.0);
        self.cache_read += row.cache_read.max(0.0);
        self.cache_write += row.cache_write.max(0.0);
        self.cost += c.total;
        self.cost_min += c.cost_min;
        self.cost_max += c.cost_max;
        self.c_in += c.c_in;
        self.c_out += c.c_out;
        self.c_cr += c.c_cr;
        self.c_cw += c.c_cw;
        self.cache_savings += c.cache_savings;
        self.estimated |= c.estimated;
        self.long_context_calls += u64::from(c.long_context);
        if c.known { self.priced_calls += 1 } else { self.unpriced_calls += 1 }
        if !c.source.is_empty() {
            self.pricing_source = c.source;
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
            "cost": self.cost, "costMin": self.cost_min, "costMax": self.cost_max,
            "cIn": self.c_in, "cOut": self.c_out, "cCr": self.c_cr,
            "cCw": self.c_cw, "cRs": 0, "cTool": 0,
            "cacheSavings": self.cache_savings,
            "priced": self.priced_calls > 0 && self.unpriced_calls == 0,
            "estimated": self.estimated,
            "pricedCalls": self.priced_calls, "unpricedCalls": self.unpriced_calls,
            "longContextCalls": self.long_context_calls, "fastCalls": 0, "usRegionCalls": 0,
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
        // A request that errored or was aborted before the model answered is
        // logged with no tokens. It used nothing, so it is not a call.
        if row.input.max(0.0) + row.output.max(0.0) + row.cache_read.max(0.0) + row.cache_write.max(0.0) == 0.0 {
            continue;
        }
        let session = session_of(&row.session_file);
        let project = project_of_folder(&row.folder);
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
        bucket.add(row, price_row(provider, row, &parts.date));
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

    fn row(provider: &str, model: &str, input: i64) -> DbRow {
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
        }
    }

    #[test]
    fn maps_only_first_party_database_rows_to_the_two_ember_providers() {
        let rows = vec![
            row("anthropic", "claude-opus-5", 10),
            row("openai-codex", "gpt-5.6-sol", 11),
            row("openai", "gpt-5.6-sol", 12),
            row("openrouter", "claude-opus-5", 100),
            row("google", "gemini-3-pro", 100),
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
    fn rows_are_priced_at_official_rates_not_at_the_cost_omp_stored() {
        // 1M input, 20 output, 30 cache read, 40 written to the 5-minute cache.
        let buckets = parse_rows(&[row("anthropic", "claude-fable-5", 1_000_000)], |_| true);
        let expected = 10.0 + 20.0 * 50.0 / 1e6 + 30.0 * 1.0 / 1e6 + 40.0 * 12.5 / 1e6;
        assert!((buckets[0]["cost"].as_f64().unwrap() - expected).abs() < 1e-9);
        assert_eq!(buckets[0]["costMin"], buckets[0]["cost"]);
        assert_eq!(buckets[0]["estimated"], false);
        assert_eq!(buckets[0]["project"], "Desktop/project");
    }

    #[test]
    fn a_codex_row_takes_the_price_in_force_on_its_day() {
        // The fixture row is dated 2026-08-17, before GPT-5.6 Sol's August 21
        // cut: $5 input, $0.50 cached, $6.25 write, $30 output.
        let buckets = parse_rows(&[row("openai-codex", "gpt-5.6-sol", 100_000)], |_| true);
        assert_eq!(buckets[0]["date"], "2026-08-17");
        let expected = 0.5 + 20.0 * 30.0 / 1e6 + 30.0 * 0.5 / 1e6 + 40.0 * 6.25 / 1e6;
        assert!((buckets[0]["cost"].as_f64().unwrap() - expected).abs() < 1e-9);
    }

    #[test]
    fn a_request_that_used_no_tokens_is_not_a_call() {
        let mut empty = row("anthropic", "claude-opus-5", 0);
        (empty.output, empty.cache_read, empty.cache_write) = (0.0, 0.0, 0.0);
        assert!(parse_rows(&[empty], |_| true).is_empty());
    }

    #[test]
    fn database_rows_survive_deleted_session_files() {
        let buckets = parse_rows(&[row("openai-codex", "gpt-5.6-sol", 1)], |_| false);
        assert_eq!(buckets[0]["projectDeleted"], true);
    }

    #[test]
    fn query_selects_only_accounting_and_attribution_columns() {
        let query = QUERY.to_lowercase();
        assert!(query.contains("from messages"));
        assert!(query.contains("input_tokens"));
        assert!(!query.contains("cost"), "OMP's own cost is not used");
        for sensitive in ["content", "error_message", "tool_calls", "user_messages"] {
            assert!(
                !query.contains(sensitive),
                "query must not select {sensitive}"
            );
        }
    }
}
