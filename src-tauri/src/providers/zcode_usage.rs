//! Read-only zcode usage importer.
//!
//! zcode keeps request-level token accounting in `~/.zcode/cli/db/db.sqlite`
//! (`model_usage`, joined to `session` for the working directory). Ember reads
//! only those counting columns and the directory — never prompts, responses,
//! tool payloads, raw provider metadata, or error text.
//!
//! Only two of zcode's configured providers are imported: the Z.ai GLM coding
//! plan and OpenRouter. They are resolved by name from zcode's own
//! `v2/config.json`, because every non-builtin provider id is a per-install
//! UUID and hardcoding one would work on exactly one machine.

use super::zcode_pricing::{cost_of, ZcodeUsage};
use rusqlite::{Connection, OpenFlags};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// `input_tokens` already contains the cached prefix, so the fresh portion is
/// derived at parse time rather than in SQL.
const QUERY: &str = r#"
SELECT
  m.provider_id,
  m.model_id,
  m.started_at,
  m.input_tokens,
  m.output_tokens,
  m.reasoning_tokens,
  m.cache_read_input_tokens,
  m.cache_creation_input_tokens,
  m.session_id,
  s.directory
FROM model_usage AS m
LEFT JOIN session AS s ON s.id = m.session_id
ORDER BY m.started_at
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
    provider_id: String,
    model: String,
    started_at: f64,
    input_total: f64,
    output: f64,
    reasoning: f64,
    cache_read: f64,
    cache_write: f64,
    session: String,
    directory: String,
}

pub fn data_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from(".")).join(".zcode")
}

pub fn db_path() -> PathBuf {
    data_dir().join("cli").join("db").join("db.sqlite")
}

fn config_path() -> PathBuf {
    data_dir().join("v2").join("config.json")
}

pub fn init(_user_data: &Path) {
    let mut state = STATE.lock().unwrap();
    state.last_signature = DbSignature::default();
    state.memo = None;
}

pub fn invalidate() {
    STATE.lock().unwrap().memo = None;
}

/// Which of zcode's providers Ember imports, by display name.
fn is_wanted_provider_name(name: &str) -> bool {
    let name = name.to_lowercase();
    let zai_coding_plan = name.contains("z.ai") && name.contains("coding plan");
    zai_coding_plan || name.contains("openrouter")
}

/// Map the ids in `model_usage.provider_id` to the label Ember shows.
///
/// Missing or unreadable config falls back to the builtin Z.ai coding-plan ids,
/// which are stable across installs; OpenRouter is UUID-keyed and can only come
/// from the config.
pub fn wanted_providers_from(config: &Value) -> BTreeMap<String, String> {
    let mut wanted = BTreeMap::new();
    if let Some(map) = config.get("provider").and_then(|p| p.as_object()) {
        for (id, entry) in map {
            let name = entry.get("name").and_then(|n| n.as_str()).unwrap_or("");
            if is_wanted_provider_name(name) {
                let label = if name.to_lowercase().contains("openrouter") {
                    "OpenRouter"
                } else {
                    "Z.ai coding plan"
                };
                wanted.insert(id.clone(), label.to_string());
            }
        }
    }
    if wanted.is_empty() {
        wanted.insert("builtin:zai-coding-plan".into(), "Z.ai coding plan".into());
        wanted.insert("builtin:zai-start-plan".into(), "Z.ai coding plan".into());
    }
    wanted
}

fn wanted_providers() -> BTreeMap<String, String> {
    let config = std::fs::read_to_string(config_path())
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .unwrap_or(Value::Null);
    wanted_providers_from(&config)
}

fn db_signature() -> DbSignature {
    let db = db_path();
    let base = db.to_string_lossy().into_owned();
    let files = [
        db.clone(),
        PathBuf::from(format!("{base}-wal")),
        PathBuf::from(format!("{base}-shm")),
        config_path(),
    ];
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
        db_path(),
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    connection.busy_timeout(Duration::from_secs(2))?;
    let mut statement = connection.prepare(QUERY)?;
    let rows = statement.query_map([], |row| {
        Ok(DbRow {
            provider_id: row.get::<_, Option<String>>(0)?.unwrap_or_default(),
            model: row.get::<_, Option<String>>(1)?.unwrap_or_default(),
            started_at: row.get::<_, Option<f64>>(2)?.unwrap_or(f64::NAN),
            input_total: row.get::<_, Option<f64>>(3)?.unwrap_or(0.0),
            output: row.get::<_, Option<f64>>(4)?.unwrap_or(0.0),
            reasoning: row.get::<_, Option<f64>>(5)?.unwrap_or(0.0),
            cache_read: row.get::<_, Option<f64>>(6)?.unwrap_or(0.0),
            cache_write: row.get::<_, Option<f64>>(7)?.unwrap_or(0.0),
            session: row.get::<_, Option<String>>(8)?.unwrap_or_default(),
            directory: row.get::<_, Option<String>>(9)?.unwrap_or_default(),
        })
    })?;
    rows.collect()
}

#[derive(Default)]
struct Bucket {
    date: String,
    hour: u32,
    minute: u32,
    model: String,
    project: String,
    session: String,
    msgs: u64,
    input: f64,
    output: f64,
    reasoning: f64,
    cache_read: f64,
    cache_write: f64,
    cost: f64,
    c_in: f64,
    c_out: f64,
    c_cr: f64,
    c_cw: f64,
    c_rs: f64,
    cache_savings: f64,
    priced_calls: u64,
    unpriced_calls: u64,
    pricing_source: String,
    /// Which zcode provider served these calls, for the model label.
    source: String,
}

impl Bucket {
    fn into_json(self, project_deleted: bool) -> Value {
        json!({
            "provider": "zcode",
            "date": self.date, "hour": self.hour, "minute": self.minute,
            "model": self.model, "project": self.project, "session": self.session,
            "source": self.source,
            "msgs": self.msgs,
            "input": self.input, "output": self.output,
            "cacheRead": self.cache_read, "cacheWrite": self.cache_write,
            "reasoning": self.reasoning,
            "cost": self.cost, "costMin": self.cost, "costMax": self.cost,
            "cIn": self.c_in, "cOut": self.c_out, "cCr": self.c_cr,
            "cCw": self.c_cw, "cRs": self.c_rs, "cTool": 0,
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

fn parse_rows<F: Fn(&str) -> bool>(
    rows: &[DbRow],
    wanted: &BTreeMap<String, String>,
    exists: F,
) -> Vec<Value> {
    let mut project_live: HashMap<String, bool> = HashMap::new();
    let mut buckets: BTreeMap<String, Bucket> = BTreeMap::new();
    let mut order: Vec<String> = Vec::new();
    for row in rows {
        let Some(source) = wanted.get(&row.provider_id) else { continue };
        if row.model.is_empty() {
            continue;
        }
        let Some(parts) = crate::local_parts_ms(row.started_at) else { continue };

        // zcode reports the cached prefix inside input_tokens, and reasoning
        // inside output_tokens (its totalTokens is input + output).
        let cache_read = row.cache_read.max(0.0);
        let cache_write = row.cache_write.max(0.0);
        let input = (row.input_total.max(0.0) - cache_read).max(0.0);
        let output = row.output.max(0.0);
        let reasoning = row.reasoning.max(0.0).min(output);
        if input + output + cache_read + cache_write == 0.0 {
            continue;
        }

        let project = super::codex_usage::project_of_cwd(&row.directory);
        let live = project_live.entry(project.clone()).or_insert(false);
        *live = *live || row.directory.is_empty() || exists(&row.directory);
        let session = if row.session.is_empty() { "unknown" } else { row.session.as_str() };
        let bk = format!(
            "{}|{}|{}|{}|{project}|{session}",
            parts.date, parts.hour, parts.minute, row.model
        );
        let bucket = buckets.entry(bk.clone()).or_insert_with(|| {
            order.push(bk.clone());
            Bucket {
                date: parts.date.clone(),
                hour: parts.hour,
                minute: parts.minute,
                model: row.model.clone(),
                project: project.clone(),
                session: session.to_string(),
                source: source.clone(),
                ..Default::default()
            }
        });
        bucket.msgs += 1;
        bucket.input += input;
        bucket.output += output;
        bucket.reasoning += reasoning;
        bucket.cache_read += cache_read;
        bucket.cache_write += cache_write;

        let c = cost_of(
            &row.model,
            &ZcodeUsage { input, output, cache_read, cache_write },
            reasoning,
        );
        if c.known {
            bucket.cost += c.total;
            bucket.c_in += c.input;
            bucket.c_out += c.output;
            bucket.c_cr += c.cache_read;
            bucket.c_cw += c.cache_write;
            bucket.c_rs += c.reasoning;
            bucket.cache_savings += c.cache_savings;
            bucket.priced_calls += 1;
            // A coding-plan request is not invoiced per token; the figure is
            // what the same traffic would have cost on OpenRouter.
            bucket.pricing_source = format!("{source} · OpenRouter catalog rates");
        } else {
            bucket.unpriced_calls += 1;
            bucket.pricing_source = format!("{source} · no published rate");
        }
    }

    let mut out = Vec::with_capacity(order.len());
    for bk in order {
        let Some(bucket) = buckets.remove(&bk) else { continue };
        let deleted = !project_live.get(&bucket.project).copied().unwrap_or(true);
        out.push(bucket.into_json(deleted));
    }
    out
}

pub fn aggregate() -> Arc<Aggregate> {
    let signature = db_signature();
    {
        let state = STATE.lock().unwrap();
        if state.last_signature == signature {
            if let Some(memo) = &state.memo {
                return memo.clone();
            }
        }
    }

    let present = db_path().exists();
    let rows = if present { read_rows().unwrap_or_default() } else { Vec::new() };
    let wanted = wanted_providers();
    let buckets = parse_rows(&rows, &wanted, |dir| Path::new(dir).exists());
    let aggregate = Arc::new(Aggregate { buckets, file_count: usize::from(present) });

    let mut state = STATE.lock().unwrap();
    state.last_signature = signature;
    state.memo = Some(aggregate.clone());
    aggregate
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> Value {
        json!({ "provider": {
            "builtin:zai-coding-plan": { "name": "Z.ai - Coding Plan" },
            "builtin:zai-start-plan": { "name": "Z.ai - Coding Plan" },
            "builtin:zai": { "name": "Z.ai - API Key" },
            "builtin:bigmodel-coding-plan": { "name": "BigModel - Coding Plan" },
            "f4ef6d1e-1808-4c6d-8383-019efcc24c0c": { "name": "openrouter" },
        }})
    }

    fn row(provider_id: &str, model: &str) -> DbRow {
        DbRow {
            provider_id: provider_id.to_string(),
            model: model.to_string(),
            started_at: 1_788_207_346_510.0,
            input_total: 31_173.0,
            output: 20_953.0,
            reasoning: 18_465.0,
            cache_read: 0.0,
            cache_write: 0.0,
            session: "sess_a".into(),
            directory: "C:\\Users\\canno\\Desktop\\dont touch claude".into(),
        }
    }

    #[test]
    fn imports_only_the_zai_coding_plan_and_openrouter() {
        let wanted = wanted_providers_from(&config());
        assert_eq!(wanted.get("builtin:zai-coding-plan").map(String::as_str), Some("Z.ai coding plan"));
        assert_eq!(wanted.get("builtin:zai-start-plan").map(String::as_str), Some("Z.ai coding plan"));
        assert_eq!(
            wanted.get("f4ef6d1e-1808-4c6d-8383-019efcc24c0c").map(String::as_str),
            Some("OpenRouter")
        );
        // Deliberately excluded: BigModel, and Z.ai's own API-key provider.
        assert!(!wanted.contains_key("builtin:bigmodel-coding-plan"));
        assert!(!wanted.contains_key("builtin:zai"));
    }

    #[test]
    fn unconfigured_installs_still_see_the_builtin_coding_plan() {
        let wanted = wanted_providers_from(&Value::Null);
        assert!(wanted.contains_key("builtin:zai-coding-plan"));
        assert!(wanted.contains_key("builtin:zai-start-plan"));
    }

    #[test]
    fn rows_from_other_providers_are_dropped() {
        let wanted = wanted_providers_from(&config());
        let rows = [row("builtin:bigmodel-coding-plan", "GLM-5.3"), row("6a46b57e", "some/model")];
        assert!(parse_rows(&rows, &wanted, |_| true).is_empty());
    }

    #[test]
    fn cached_input_is_split_out_and_reasoning_stays_inside_output() {
        let wanted = wanted_providers_from(&config());
        let mut r = row("builtin:zai-coding-plan", "GLM-5.3-Flash");
        r.input_total = 107_296.0;
        r.cache_read = 101_376.0;
        r.output = 197.0;
        r.reasoning = 106.0;
        let out = parse_rows(&[r], &wanted, |_| true);
        assert_eq!(out.len(), 1);
        let b = &out[0];
        assert_eq!(b["provider"], "zcode");
        // input_tokens included the cached prefix; only the fresh part is input.
        assert_eq!(b["input"], json!(5_920.0));
        assert_eq!(b["cacheRead"], json!(101_376.0));
        assert_eq!(b["output"], json!(197.0));
        assert_eq!(b["reasoning"], json!(106.0));
        assert!(b["reasoning"].as_f64().unwrap() < b["output"].as_f64().unwrap());
        assert_eq!(b["project"], "Desktop/dont touch claude");
        assert!(b["priced"].as_bool().unwrap());
        assert!(b["cost"].as_f64().unwrap() > 0.0);
        // Reasoning cost is a share of output cost, never added on top.
        let parts = b["cIn"].as_f64().unwrap()
            + b["cOut"].as_f64().unwrap()
            + b["cCr"].as_f64().unwrap()
            + b["cCw"].as_f64().unwrap();
        assert!((parts - b["cost"].as_f64().unwrap()).abs() < 1e-12);
        assert!(b["cRs"].as_f64().unwrap() <= b["cOut"].as_f64().unwrap());
    }

    #[test]
    fn openrouter_routing_variants_price_and_keep_their_own_model_label() {
        let wanted = wanted_providers_from(&config());
        let out = parse_rows(
            &[row("f4ef6d1e-1808-4c6d-8383-019efcc24c0c", "z-ai/glm-5.3-flash:makora")],
            &wanted,
            |_| true,
        );
        assert_eq!(out[0]["model"], "z-ai/glm-5.3-flash:makora");
        assert!(out[0]["priced"].as_bool().unwrap());
    }

    #[test]
    fn models_without_a_published_rate_are_reported_unpriced() {
        let wanted = wanted_providers_from(&config());
        let out = parse_rows(
            &[row("f4ef6d1e-1808-4c6d-8383-019efcc24c0c", "philbert440/Qwen3.8-27B-Uncensored-Cyber")],
            &wanted,
            |_| true,
        );
        assert!(!out[0]["priced"].as_bool().unwrap());
        assert_eq!(out[0]["cost"], json!(0.0));
        assert!(out[0]["input"].as_f64().unwrap() > 0.0, "tokens still count when the price does not");
    }
}
