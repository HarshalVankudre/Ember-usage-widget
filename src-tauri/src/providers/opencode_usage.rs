//! OpenCode keeps its request-level token accounting in opencode.db. Its
//! bundled `opencode db` command is the safest read-only bridge: it
//! understands the live SQLite WAL and avoids shipping another native SQLite
//! binary. Only non-sensitive usage columns are selected here.

use super::codex_pricing::{cost_of, CodexUsage};
use super::codex_usage::Bucket;
use super::model_attribution::is_openai_model;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

const CACHE_VERSION: u32 = 1;

pub const QUERY: &str = "\nSELECT\n  m.id,\n  m.session_id,\n  m.time_created,\n  s.directory,\n  json_extract(m.data, '$.modelID') AS model,\n  json_extract(m.data, '$.tokens.input') AS input,\n  json_extract(m.data, '$.tokens.output') AS output,\n  json_extract(m.data, '$.tokens.reasoning') AS reasoning,\n  json_extract(m.data, '$.tokens.cache.read') AS cache_read,\n  json_extract(m.data, '$.tokens.cache.write') AS cache_write\nFROM message AS m\nJOIN session AS s ON s.id = m.session_id\nWHERE json_extract(m.data, '$.role') = 'assistant'\n  AND json_extract(m.data, '$.providerID') = 'openai'\n";

#[derive(Serialize, Deserialize)]
struct CacheFile {
    v: u32,
    rows: BTreeMap<String, Value>,
}

#[derive(Clone)]
pub struct Aggregate {
    pub buckets: Vec<Bucket>,
    pub file_count: usize,
}

#[derive(Default)]
struct State {
    cache_path: Option<PathBuf>,
    row_cache: BTreeMap<String, Value>,
    memo: Option<Arc<Aggregate>>,
    last_db_sig: String,
}

static STATE: Mutex<State> = Mutex::new(State {
    cache_path: None,
    row_cache: BTreeMap::new(),
    memo: None,
    last_db_sig: String::new(),
});

pub fn data_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".local")
        .join("share")
        .join("opencode")
}

pub fn db_path() -> PathBuf {
    data_dir().join("opencode.db")
}

pub fn invalidate() {
    let mut state = STATE.lock().unwrap();
    state.memo = None;
    state.last_db_sig = String::new();
}

/// Reading this source costs a subprocess, so a pass only pays for it when the
/// database files have actually moved. WAL mode writes beside the main file,
/// which is why all three names are watched.
fn db_signature() -> String {
    let db = db_path();
    let wal = PathBuf::from(format!("{}-wal", db.display()));
    let shm = PathBuf::from(format!("{}-shm", db.display()));
    [db, wal, shm]
        .iter()
        .map(|file| match std::fs::metadata(file) {
            Ok(st) => {
                let mtime = st
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_secs_f64() * 1000.0)
                    .unwrap_or(0.0);
                format!("{}:{}", crate::js_num(mtime), st.len())
            }
            Err(_) => "-".to_string(),
        })
        .collect::<Vec<_>>()
        .join("|")
}

pub fn init(user_data: &Path) {
    let mut state = STATE.lock().unwrap();
    state.cache_path = Some(user_data.join("opencode-usage-cache.json"));
    state.memo = None;
    state.last_db_sig = String::new();
    state.row_cache = BTreeMap::new();
    let Some(path) = state.cache_path.clone() else { return };
    let Ok(raw) = std::fs::read_to_string(&path) else { return };
    let Ok(parsed) = serde_json::from_str::<CacheFile>(&raw) else { return };
    if parsed.v == CACHE_VERSION {
        state.row_cache = parsed.rows;
    }
}

fn save_cache(path: &Path, rows: &BTreeMap<String, Value>) {
    let snapshot = CacheFile { v: CACHE_VERSION, rows: rows.clone() };
    if let Ok(body) = serde_json::to_string(&snapshot) {
        let _ = crate::persist::write_atomic(path, body);
    }
}

fn non_negative(value: Option<&Value>) -> f64 {
    value.and_then(|v| v.as_f64()).unwrap_or(0.0).max(0.0)
}

/// Keep project labels consistent with native Codex rollouts.
pub fn project_of_directory(directory: &str) -> String {
    if directory.is_empty() {
        return "unknown".to_string();
    }
    super::codex_usage::project_of_cwd(directory)
}

pub fn parse_rows<F: Fn(&str) -> bool>(rows: &[Value], exists: F) -> Vec<Bucket> {
    let mut buckets: BTreeMap<String, Bucket> = BTreeMap::new();
    let mut order: Vec<String> = Vec::new();
    for row in rows {
        let model = row.get("model").and_then(|v| v.as_str()).unwrap_or("");
        if !is_openai_model(model) {
            continue;
        }
        let time_created = row.get("time_created").and_then(|v| v.as_f64()).unwrap_or(f64::NAN);
        let Some(parts) = crate::local_parts_ms(time_created) else { continue };

        let input = non_negative(row.get("input"));
        let cached = non_negative(row.get("cache_read"));
        let cache_write = non_negative(row.get("cache_write"));
        let reasoning = non_negative(row.get("reasoning"));
        // OpenCode/AI SDK reports reasoning beside visible output, whereas Codex
        // rollouts report it as a subset. Fold it into output for Ember's unified
        // billing shape, then retain `reasoning` as the informational subset.
        let output = non_negative(row.get("output")) + reasoning;
        if input + cached + cache_write + output == 0.0 {
            continue;
        }

        let directory = row.get("directory").and_then(|v| v.as_str()).unwrap_or("");
        let project = project_of_directory(directory);
        let session = row
            .get("session_id")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .unwrap_or("unknown")
            .to_string();
        let bk = format!("{}|{}|{}|{model}|{project}|{session}", parts.date, parts.hour, parts.minute);
        let bucket = buckets.entry(bk.clone()).or_insert_with(|| {
            order.push(bk.clone());
            Bucket {
                date: parts.date.clone(),
                hour: parts.hour,
                minute: Some(parts.minute),
                model: model.to_string(),
                project: project.clone(),
                session: session.clone(),
                input: 0.0, output: 0.0, cached: 0.0, reasoning: 0.0, cache_write: 0.0,
                total_input: 0.0, msgs: 0,
                cost: 0.0, cost_min: 0.0, cost_max: 0.0,
                c_in: 0.0, c_out: 0.0, c_cached: 0.0, c_reasoning: 0.0, c_write: 0.0,
                cache_savings: 0.0,
                priced_calls: 0, unpriced_calls: 0, estimated: false, long_context_calls: 0,
                pricing_source: String::new(),
                priced: false,
                project_deleted: !directory.is_empty() && !exists(directory),
            }
        });
        bucket.input += input;
        bucket.output += output;
        bucket.cached += cached;
        bucket.reasoning += reasoning;
        bucket.cache_write += cache_write;
        bucket.total_input += input + cached + cache_write;
        bucket.msgs += 1;

        let c = cost_of(model, &CodexUsage {
            input,
            output,
            cached,
            reasoning,
            cache_write,
            cache_write_known: row.get("cache_write").is_some_and(|v| !v.is_null()),
            total_input: input + cached + cache_write,
        });
        bucket.cost += c.total;
        bucket.cost_min += c.cost_min;
        bucket.cost_max += c.cost_max;
        bucket.c_in += c.input;
        bucket.c_out += c.output;
        bucket.c_cached += c.cached;
        bucket.c_reasoning += c.reasoning;
        bucket.c_write += c.cache_write;
        bucket.cache_savings += c.cache_savings;
        bucket.estimated = bucket.estimated || c.estimated;
        bucket.long_context_calls += if c.long_context { 1 } else { 0 };
        if !c.source.is_empty() {
            bucket.pricing_source = c.source.clone();
        }
        if c.known { bucket.priced_calls += 1 } else { bucket.unpriced_calls += 1 }
    }

    order
        .into_iter()
        .map(|bk| {
            let mut b = buckets.remove(&bk).unwrap();
            b.priced = b.priced_calls > 0 && b.unpriced_calls == 0;
            b
        })
        .collect()
}

pub fn find_opencode_bin() -> PathBuf {
    if let Ok(bin) = std::env::var("OPENCODE_BIN") {
        if !bin.is_empty() {
            return PathBuf::from(bin);
        }
    }
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    let candidates: Vec<PathBuf> = if cfg!(windows) {
        let mut list = Vec::new();
        if let Ok(appdata) = std::env::var("APPDATA") {
            list.push(PathBuf::from(appdata).join("npm").join("node_modules").join("opencode-ai").join("bin").join("opencode.exe"));
        }
        list.push(home.join(".opencode").join("bin").join("opencode.exe"));
        list.push(home.join(".local").join("bin").join("opencode.exe"));
        list
    } else {
        vec![
            home.join(".opencode").join("bin").join("opencode"),
            home.join(".local").join("bin").join("opencode"),
        ]
    };
    candidates
        .into_iter()
        .find(|c| c.exists())
        .unwrap_or_else(|| PathBuf::from(if cfg!(windows) { "opencode.exe" } else { "opencode" }))
}

async fn query_rows() -> Result<Vec<Value>, String> {
    if !db_path().exists() {
        return Ok(Vec::new());
    }
    let mut cmd = tokio::process::Command::new(find_opencode_bin());
    cmd.arg("db").arg(QUERY).arg("--format").arg("json");
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    let output = tokio::time::timeout(std::time::Duration::from_secs(15), cmd.output())
        .await
        .map_err(|_| "timed out".to_string())?
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(format!("exit {:?}", output.status.code()));
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let trimmed = stdout.trim();
    let body = if trimmed.is_empty() { "[]" } else { trimmed };
    match serde_json::from_str::<Value>(body) {
        Ok(Value::Array(rows)) => Ok(rows),
        Ok(_) => Ok(Vec::new()),
        Err(e) => Err(e.to_string()),
    }
}

pub async fn aggregate() -> Arc<Aggregate> {
    let signature = db_signature();
    {
        let state = STATE.lock().unwrap();
        if let Some(memo) = &state.memo {
            if signature == state.last_db_sig {
                return memo.clone();
            }
        }
    }
    match query_rows().await {
        Ok(rows) => {
            let mut state = STATE.lock().unwrap();
            let mut dirty = false;
            for row in rows {
                let Some(id) = row.get("id").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) else {
                    continue;
                };
                let id = id.to_string();
                if state.row_cache.get(&id) != Some(&row) {
                    state.row_cache.insert(id, row);
                    dirty = true;
                }
            }
            if dirty {
                if let Some(path) = state.cache_path.clone() {
                    save_cache(&path, &state.row_cache);
                }
            }
        }
        Err(err) => {
            // A locked/migrating database or absent CLI must not take Ember
            // down. The last successful snapshot remains available.
            eprintln!("OpenCode usage scan failed: {err}");
        }
    }

    let rows: Vec<Value> = {
        let state = STATE.lock().unwrap();
        state.row_cache.values().cloned().collect()
    };
    let buckets = parse_rows(&rows, |dir| Path::new(dir).exists());
    // Read the signature again after querying: opening the database updates the
    // WAL sidecars, so recording the pre-query state would invalidate the memo
    // on every pass and keep paying for the subprocess.
    let memo = Arc::new(Aggregate {
        buckets,
        file_count: if db_path().exists() { 1 } else { 0 },
    });
    let mut state = STATE.lock().unwrap();
    state.last_db_sig = db_signature();
    state.memo = Some(memo.clone());
    memo
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn maps_opencode_oauth_requests_into_codex_billing_buckets() {
        let rows = vec![json!({
            "id": "msg_1", "session_id": "ses_1", "time_created": 1_784_890_620_000_i64,
            "directory": "C:/Users/dev/Desktop/widget", "model": "gpt-5.6-sol",
            "input": 100, "output": 20, "reasoning": 5, "cache_read": 50, "cache_write": 0
        })];
        let buckets = parse_rows(&rows, |_| true);
        assert_eq!(buckets.len(), 1);
        let b = &buckets[0];
        assert_eq!(b.model, "gpt-5.6-sol");
        assert_eq!(b.project, "Desktop/widget");
        assert_eq!(b.session, "ses_1");
        assert_eq!(b.input, 100.0);
        assert_eq!(b.cached, 50.0);
        assert_eq!(b.output, 25.0, "reasoning is folded into billed output");
        assert_eq!(b.reasoning, 5.0);
        assert_eq!(b.msgs, 1);
        assert!(!b.estimated, "OpenCode reports cache writes explicitly");
    }

    #[test]
    fn ignores_unfinished_and_non_openai_messages() {
        let rows = vec![
            json!({
                "id": "msg_empty", "session_id": "ses_1", "time_created": 1_784_890_620_000_i64,
                "directory": "C:/repo", "model": "gpt-5.6-sol",
                "input": 0, "output": 0, "reasoning": 0, "cache_read": 0, "cache_write": 0
            }),
            json!({
                "id": "msg_claude", "session_id": "ses_1", "time_created": 1_784_890_620_000_i64,
                "directory": "C:/repo", "model": "claude-sonnet-5",
                "input": 100, "output": 20, "reasoning": 0, "cache_read": 0, "cache_write": 0
            }),
        ];
        assert!(parse_rows(&rows, |_| true).is_empty());
    }

    #[test]
    fn query_selects_only_content_free_openai_usage_fields() {
        assert!(QUERY.contains("providerID"));
        assert!(QUERY.contains("tokens.cache.read"));
        assert!(!QUERY.to_lowercase().contains("select m.data"));
        for word in ["error", "content", "system"] {
            assert!(!QUERY.to_lowercase().contains(word), "query must not select {word}");
        }
    }
}
