//! Codex rollout parsing. A rollout file is a stream of records; three kinds
//! matter: session_meta (cwd/project + session id), turn_context (current
//! model), and event_msg/token_count (per-call usage + rate-limit snapshots).

use super::codex_pricing::{cost_of, CodexUsage};
use super::model_attribution::is_openai_model;
use super::turn_clock::{abandoned_turn, TurnClock};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

// v5: account limits exclude model-specific quotas such as Codex Spark. Live
// files are reparsed once when upgrading so a cached Spark tail cannot mask an
// earlier account-wide reading in the same rollout.
// v6: turn time appended; older rollouts are reparsed once to backfill it.
// v7: per-call service tier appended; backfill Fast/Priority from live logs.
// v8: the tier is read from thread_settings_applied, where current rollouts
// record it, and a logged zero cache write is no longer taken as measured.
const CACHE_VERSION: u32 = 8;
const LEGACY_ENTRY_LENGTH: usize = 11;
const V5_ENTRY_LENGTH: usize = 12;
const V6_ENTRY_LENGTH: usize = 13;

/// entry: [dedupKey, date, hour, model, input, output, cached, reasoning,
///         cacheWrite, cacheWriteKnown, totalInput, minute, turnMs, serviceTier]
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Entry(
    pub String,      // dedup key
    pub String,      // date
    pub u32,         // hour
    pub String,      // model
    pub f64,         // ordinary input
    pub f64,         // output
    pub f64,         // cached input
    pub f64,         // reasoning (subset of output — informational)
    pub f64,         // measured cache write
    pub bool,        // cache write known
    pub f64,         // total input
    pub Option<u32>, // minute
    pub f64,         // turn ms: work time of the turn this call ended, else 0
    pub String,      // service tier for this call, never inferred from today's config
);

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LimitsSnap {
    pub ts: f64,
    pub rate_limits: Value,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileRec {
    pub mtime_ms: f64,
    pub size: u64,
    pub entries: Vec<Entry>,
    #[serde(default = "unknown_project")]
    pub project: String,
    #[serde(default)]
    pub limits: Option<LimitsSnap>,
    /// The turn still running when the file was read: (entry, ms so far).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub open_turn: Option<(usize, f64)>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub gone: bool,
}

fn unknown_project() -> String {
    "unknown".to_string()
}

#[derive(Serialize, Deserialize)]
struct CacheFile {
    v: u32,
    files: BTreeMap<String, FileRec>,
}

/// Serialize-only twin of [`CacheFile`] that borrows the map instead of owning
/// a clone of it. Must stay field-compatible with `CacheFile`.
#[derive(Serialize)]
struct CacheFileRef<'a> {
    v: u32,
    files: &'a BTreeMap<String, FileRec>,
}

#[derive(Clone, Debug)]
pub struct Bucket {
    pub date: String,
    pub hour: u32,
    pub minute: Option<u32>,
    pub model: String,
    pub project: String,
    pub session: String,
    pub input: f64,
    pub output: f64,
    pub cached: f64,
    pub reasoning: f64,
    pub cache_write: f64,
    pub total_input: f64,
    pub msgs: u64,
    /// Work time of the finished turns that ended in this bucket.
    pub active_ms: f64,
    pub cost: f64,
    pub cost_min: f64,
    pub cost_max: f64,
    pub c_in: f64,
    pub c_out: f64,
    pub c_cached: f64,
    pub c_reasoning: f64,
    pub c_write: f64,
    pub cache_savings: f64,
    pub priced_calls: u64,
    pub unpriced_calls: u64,
    pub estimated: bool,
    pub long_context_calls: u64,
    pub pricing_source: String,
    pub priced: bool,
    pub project_deleted: bool,
}

#[derive(Clone)]
pub struct Aggregate {
    pub buckets: Vec<Bucket>,
    pub file_count: usize,
    pub limits: Option<LimitsSnap>,
}

#[derive(Default)]
struct State {
    cache_path: Option<PathBuf>,
    file_cache: BTreeMap<String, FileRec>,
    cache_needs_reparse: bool,
    memo: Option<Arc<Aggregate>>,
    /// When an open turn in a quiet log will count as abandoned.
    memo_expires_ms: f64,
}

static STATE: Mutex<State> = Mutex::new(State {
    cache_path: None,
    file_cache: BTreeMap::new(),
    cache_needs_reparse: false,
    memo: None,
    memo_expires_ms: f64::INFINITY,
});

/// Every Codex home on this machine. The CLI, the IDE extension and the Codex
/// desktop app all write to `~/.codex`; anything that runs Codex with its own
/// home keeps rollouts Ember would otherwise never see.
fn codex_homes() -> Vec<PathBuf> {
    let mut homes = vec![dirs::home_dir().unwrap_or_else(|| PathBuf::from(".")).join(".codex")];
    // CODEX_HOME relocates the whole home.
    if let Some(custom) = std::env::var_os("CODEX_HOME").filter(|v| !v.is_empty()) {
        homes.push(PathBuf::from(custom));
    }
    // Orca runs Codex in panes against a runtime home of its own. Sessions it
    // also mirrors into ~/.codex share a dedup key, so they are counted once.
    if let Some(roaming) = dirs::config_dir() {
        homes.push(roaming.join("orca").join("codex-runtime-home").join("home"));
    }
    let mut unique: Vec<PathBuf> = Vec::new();
    for home in homes {
        if !unique.contains(&home) {
            unique.push(home);
        }
    }
    unique
}

pub fn session_dirs() -> Vec<PathBuf> {
    codex_homes()
        .into_iter()
        .flat_map(|home| [home.join("sessions"), home.join("archived_sessions")])
        .collect()
}

pub fn invalidate() {
    STATE.lock().unwrap().memo = None;
}

/// Current rollouts put the shared ChatGPT allowance and model-specific
/// allowances in the same `rate_limits` field. Only the `codex` identity is
/// the account meter shown by Ember; e.g. `codex_bengalfox` is the separate
/// GPT-5.3-Codex-Spark quota. Older rollouts had no identity, so keep accepting
/// unnamed payloads for backwards compatibility.
pub fn is_account_rate_limits(rate_limits: &Value) -> bool {
    match rate_limits.get("limit_id").and_then(|v| v.as_str()) {
        Some(id) => id == "codex",
        None => rate_limits
            .get("limit_name")
            .and_then(|v| v.as_str())
            .is_none_or(str::is_empty),
    }
}

fn upgrade_old_files(files: BTreeMap<String, Value>) -> BTreeMap<String, FileRec> {
    let mut upgraded = BTreeMap::new();
    for (file, mut rec) in files {
        if let Some(entries) = rec.get_mut("entries").and_then(|e| e.as_array_mut()) {
            for entry in entries.iter_mut() {
                if let Some(arr) = entry.as_array_mut() {
                    if arr.len() == LEGACY_ENTRY_LENGTH {
                        arr.push(Value::Null);
                    }
                    if arr.len() == V5_ENTRY_LENGTH {
                        arr.push(serde_json::json!(0.0));
                    }
                    if arr.len() == V6_ENTRY_LENGTH {
                        arr.push(serde_json::json!("standard"));
                    }
                    // Rollouts log `cache_write_input_tokens: 0` on every call,
                    // including calls whose prompt the next call then reads
                    // from cache. A zero is "not reported", not "no write".
                    if arr.len() > 9 && arr[8].as_f64().unwrap_or(0.0) <= 0.0 {
                        arr[9] = serde_json::json!(false);
                    }
                }
            }
        }
        if let Ok(parsed) = serde_json::from_value::<FileRec>(rec) {
            upgraded.insert(file, parsed);
        }
    }
    upgraded
}

fn strip_model_specific_limits(files: &mut BTreeMap<String, FileRec>) {
    for rec in files.values_mut() {
        if rec
            .limits
            .as_ref()
            .is_some_and(|limits| !is_account_rate_limits(&limits.rate_limits))
        {
            rec.limits = None;
        }
    }
}

pub fn init(user_data: &Path) {
    let mut state = STATE.lock().unwrap();
    state.cache_path = Some(user_data.join("codex-usage-cache.json"));
    state.cache_needs_reparse = false;
    state.memo = None;
    state.file_cache = BTreeMap::new();
    let Some(path) = state.cache_path.clone() else { return };
    if let Some(files) = read_current_cache(&path) {
        state.file_cache = files;
        return;
    }
    // Older versions, and anything the fast path could not read, fall through
    // to the migration arms below.
    let Ok(raw) = std::fs::read_to_string(&path) else { return };
    let Ok(parsed) = serde_json::from_str::<Value>(&raw) else { return };
    match parsed.get("v").and_then(|v| v.as_u64()) {
        Some(v) if v == CACHE_VERSION as u64 => {
            if let Some(files) = parsed.get("files") {
                if let Ok(files) = serde_json::from_value::<BTreeMap<String, FileRec>>(files.clone()) {
                    state.file_cache = files;
                }
            }
        }
        Some(3..=7) => {
            if let Some(files) = parsed.get("files") {
                if let Ok(files) = serde_json::from_value::<BTreeMap<String, Value>>(files.clone()) {
                    let mut files = upgrade_old_files(files);
                    strip_model_specific_limits(&mut files);
                    state.file_cache = files;
                    state.cache_needs_reparse = true;
                }
            }
        }
        _ => {}
    }
}

/// Load a cache that is already at the current version, straight from the file
/// into the typed map.
///
/// The migration path below goes via `serde_json::Value` and then clones the
/// `files` subtree out of it, which costs several times the file's size in
/// transient allocation — on a cache of tens of megabytes that peak, retained
/// by the allocator, was most of the process's resident footprint. Any older
/// file fails the version check here and takes that path instead, which is
/// affordable because it runs once per upgrade.
fn read_current_cache(path: &Path) -> Option<BTreeMap<String, FileRec>> {
    let file = std::fs::File::open(path).ok()?;
    let parsed: CacheFile = serde_json::from_reader(std::io::BufReader::new(file)).ok()?;
    (parsed.v == CACHE_VERSION).then_some(parsed.files)
}

fn save_cache(path: &Path, files: &BTreeMap<String, FileRec>) {
    // Borrowed, and streamed: the old form cloned the whole map and then built
    // the entire JSON document as one String, so a save briefly held three
    // copies of a cache that is tens of megabytes.
    let snapshot = CacheFileRef { v: CACHE_VERSION, files };
    let _ = crate::persist::write_atomic_with(path, |w| {
        serde_json::to_writer(w, &snapshot).map_err(std::io::Error::from)
    });
}

fn list_jsonl_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(kind) = entry.file_type() else { continue };
        if kind.is_dir() {
            list_jsonl_files(&path, out);
        } else if kind.is_file() && path.extension().is_some_and(|e| e == "jsonl") {
            out.push(path);
        }
    }
}

/// "C:\Users\you\Desktop\my-app" -> "Desktop/my-app"
pub fn project_of_cwd(cwd: &str) -> String {
    if cwd.is_empty() {
        return "unknown".to_string();
    }
    let norm = cwd.replace('/', "\\");
    let norm = regex::Regex::new(r"^[A-Za-z]:\\")
        .unwrap()
        .replace(&norm, "")
        .into_owned();
    let mut parts: Vec<&str> = norm.split('\\').filter(|p| !p.is_empty()).collect();
    if parts.first().is_some_and(|p| p.eq_ignore_ascii_case("users")) && parts.len() >= 2 {
        parts.drain(0..2);
    }
    if parts.is_empty() { "~ (home)".to_string() } else { parts.join("/") }
}

fn session_of(file: &str) -> String {
    Path::new(file)
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "unknown".to_string())
}

fn num(v: Option<&Value>) -> f64 {
    v.and_then(|v| v.as_f64()).unwrap_or(0.0)
}

pub struct ParsedFile {
    pub entries: Vec<Entry>,
    pub project: String,
    pub limits: Option<LimitsSnap>,
    pub open_turn: Option<(usize, f64)>,
}

pub fn parse_content(text: &str) -> ParsedFile {
    let mut entries: Vec<Entry> = Vec::new();
    let mut turn = TurnClock::default();
    let mut model = "unknown".to_string();
    let mut service_tier = "standard".to_string();
    // Current rollouts state the tier in thread_settings_applied and leave it
    // out of turn_context; older ones put it in turn_context.
    let mut tier_from_settings = false;
    let mut project = "unknown".to_string();
    let mut session_id: Option<String> = None;
    let mut limits: Option<LimitsSnap> = None;
    for line in text.split('\n') {
        if line.is_empty() {
            continue;
        }
        let is_meta = line.contains("\"session_meta\"");
        let is_turn = line.contains("\"turn_context\"");
        let is_count = line.contains("\"token_count\"");
        let is_settings = line.contains("\"thread_settings_applied\"");
        let is_task = line.contains("\"task_started\"")
            || line.contains("\"task_complete\"")
            || line.contains("\"turn_aborted\"");
        if !is_meta && !is_turn && !is_count && !is_task && !is_settings {
            continue;
        }
        let Ok(obj) = serde_json::from_str::<Value>(line) else { continue };
        let Some(p) = obj.get("payload") else { continue };
        let obj_type = obj.get("type").and_then(|t| t.as_str()).unwrap_or("");
        if obj_type == "session_meta" {
            if let Some(cwd) = p.get("cwd").and_then(|c| c.as_str()).filter(|c| !c.is_empty()) {
                project = project_of_cwd(cwd);
            }
            if let Some(id) = p
                .get("id")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .or_else(|| p.get("session_id").and_then(|v| v.as_str()).filter(|s| !s.is_empty()))
            {
                session_id = Some(id.to_string());
            }
            continue;
        }
        if obj_type == "turn_context" {
            if let Some(m) = p.get("model").and_then(|m| m.as_str()).filter(|m| !m.is_empty()) {
                model = m.to_string();
            }
            // Each context describes a new request. In a rollout that states
            // the tier here, a missing/null tier means standard, including
            // when Fast was enabled on an earlier turn. In one that states it
            // in thread_settings_applied, the key is simply absent and the
            // settings in force carry over.
            if p.get("service_tier").is_some() || !tier_from_settings {
                service_tier = p.get("service_tier").and_then(Value::as_str)
                    .filter(|s| !s.is_empty()).unwrap_or("standard").to_string();
            }
            continue;
        }
        if obj_type != "event_msg" {
            continue;
        }
        let timestamp = obj.get("timestamp").and_then(|t| t.as_str()).unwrap_or("");
        let event = p.get("type").and_then(|t| t.as_str());
        if event == Some("thread_settings_applied") {
            // Written whenever the thread's settings change, and after the
            // first turn_context. It holds until the next one.
            if let Some(settings) = p.get("thread_settings").filter(|v| v.is_object()) {
                tier_from_settings = true;
                service_tier = settings.get("service_tier").and_then(Value::as_str)
                    .filter(|s| !s.is_empty()).unwrap_or("standard").to_string();
            }
            continue;
        }
        if matches!(event, Some("task_started" | "task_complete" | "turn_aborted")) {
            let Some(at) = crate::parse_ts_ms(timestamp) else { continue };
            let closed = if event == Some("task_started") { turn.prompt(at) } else { turn.finish(at) };
            if let Some((index, ms)) = closed {
                entries[index].12 = ms;
            }
            continue;
        }
        if event != Some("token_count") {
            continue;
        }

        if let Some(rl) = p.get("rate_limits").filter(|rl| is_account_rate_limits(rl)) {
            let has_data = rl.get("primary").is_some_and(crate::js_truthy)
                || rl.get("secondary").is_some_and(crate::js_truthy)
                || rl.get("plan_type").is_some_and(crate::js_truthy);
            if has_data {
                if let Some(ts) = crate::parse_ts_ms(timestamp) {
                    if limits.as_ref().is_none_or(|l| ts >= l.ts) {
                        limits = Some(LimitsSnap { ts, rate_limits: rl.clone() });
                    }
                }
            }
        }

        let info = p.get("info");
        let Some(u) = info.and_then(|i| i.get("last_token_usage")).filter(|u| !u.is_null()) else {
            continue;
        };
        let Some(parts) = crate::local_parts(timestamp) else { continue };
        // token_count events carry no id, and a resume/fork replays the parent's
        // history into a new file with RE-STAMPED timestamps — only the session
        // id and the running totals survive the copy. Key on those so replayed
        // calls dedup across files (timestamp fallback if session_meta is absent).
        let total = info.and_then(|i| i.get("total_token_usage"));
        let has_cumulative = total.and_then(|t| t.get("total_tokens")).and_then(|v| v.as_f64()).unwrap_or(0.0) > 0.0;
        let cumulative = [
            crate::js_num(num(total.and_then(|t| t.get("input_tokens")))),
            crate::js_num(num(total.and_then(|t| t.get("cached_input_tokens")))),
            crate::js_num(num(total.and_then(|t| t.get("output_tokens")))),
            crate::js_num(num(total.and_then(|t| t.get("reasoning_output_tokens")))),
            crate::js_num(num(total.and_then(|t| t.get("total_tokens")))),
        ]
        .join(":");
        let last = [
            crate::js_num(num(u.get("input_tokens"))),
            crate::js_num(num(u.get("cached_input_tokens"))),
            crate::js_num(num(u.get("output_tokens"))),
            crate::js_num(num(u.get("reasoning_output_tokens"))),
            crate::js_num(num(u.get("total_tokens"))),
        ]
        .join(":");
        let key = format!(
            "{}|{}|{}",
            session_id.as_deref().unwrap_or("no-session"),
            if has_cumulative { cumulative } else { timestamp.to_string() },
            last
        );
        let total_input = num(u.get("input_tokens")).max(0.0);
        let cached = num(u.get("cached_input_tokens")).max(0.0).min(total_input);
        let details = u
            .get("input_tokens_details")
            .filter(|v| !v.is_null())
            .or_else(|| u.get("input_token_details"))
            .cloned()
            .unwrap_or(Value::Null);
        let raw_write = [
            u.get("cache_write_tokens"),
            u.get("cache_write_input_tokens"),
            details.get("cache_write_tokens"),
            details.get("cache_write_input_tokens"),
        ]
        .into_iter()
        .flatten()
        .find(|v| !v.is_null());
        // Only a positive count is a measurement. Rollouts write a literal 0
        // here on every call, even when the next call reads this call's prompt
        // back from cache, which a billed write must have put there.
        let cache_write_known = raw_write.is_some_and(|v| v.as_f64().is_some_and(|n| n > 0.0));
        let cache_write = if cache_write_known {
            raw_write
                .and_then(|v| v.as_f64())
                .unwrap_or(0.0)
                .max(0.0)
                .min((total_input - cached).max(0.0))
        } else {
            0.0
        };
        let input = (total_input - cached - cache_write).max(0.0);
        // A returned tier wins over the requested tier: Fast can fall back to
        // Standard, in which case OpenAI charges the returned Standard rate.
        let call_tier = [u.get("service_tier"), info.and_then(|i| i.get("service_tier")), p.get("service_tier")]
            .into_iter().flatten().filter_map(Value::as_str).find(|s| !s.is_empty())
            .unwrap_or(&service_tier);
        entries.push(Entry(
            key,
            parts.date,
            parts.hour,
            model.clone(),
            input,
            num(u.get("output_tokens")),
            cached,
            num(u.get("reasoning_output_tokens")),
            cache_write,
            cache_write_known,
            total_input,
            Some(parts.minute),
            0.0,
            call_tier.to_string(),
        ));
        if let Some(at) = crate::parse_ts_ms(timestamp) {
            turn.call(entries.len() - 1, at);
        }
    }
    // stamp the project on each entry via the cache record instead of per-entry
    let open_turn = turn.pending();
    ParsedFile { entries, project, limits, open_turn }
}

pub fn aggregate() -> Arc<Aggregate> {
    let (mut file_cache, cache_path, force_reparse) = {
        let state = STATE.lock().unwrap();
        (state.file_cache.clone(), state.cache_path.clone(), state.cache_needs_reparse)
    };

    let mut files = Vec::new();
    for dir in session_dirs() {
        list_jsonl_files(&dir, &mut files);
    }

    let mut live_cache: BTreeMap<String, FileRec> = BTreeMap::new();
    let mut cache_dirty = force_reparse;

    for file in &files {
        let key = file.to_string_lossy().into_owned();
        let Ok(st) = std::fs::metadata(file) else { continue };
        let mtime_ms = st
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs_f64() * 1000.0)
            .unwrap_or(0.0);
        let size = st.len();
        let prev = file_cache.get(&key);
        if let Some(prev) = prev {
            if !force_reparse && prev.mtime_ms == mtime_ms && prev.size == size {
                if prev.gone {
                    let mut rec = prev.clone();
                    rec.gone = false;
                    live_cache.insert(key, rec);
                    cache_dirty = true;
                } else {
                    live_cache.insert(key, prev.clone());
                }
                continue;
            }
        }
        let parsed = std::fs::read_to_string(file).ok().map(|text| parse_content(&text));
        match parsed {
            Some(p) => {
                live_cache.insert(key, FileRec {
                    mtime_ms, size,
                    entries: p.entries,
                    project: p.project,
                    limits: p.limits,
                    open_turn: p.open_turn,
                    gone: false,
                });
            }
            None => match prev {
                Some(prev) => {
                    let mut rec = prev.clone();
                    rec.gone = false;
                    rec.mtime_ms = mtime_ms;
                    rec.size = size;
                    live_cache.insert(key, rec);
                }
                None => {
                    live_cache.insert(key, FileRec {
                        mtime_ms, size,
                        entries: Vec::new(),
                        project: "unknown".to_string(),
                        limits: None,
                        open_turn: None,
                        gone: false,
                    });
                }
            },
        }
        cache_dirty = true;
    }

    for (file, rec) in &file_cache {
        if live_cache.contains_key(file) {
            continue;
        }
        if rec.gone {
            live_cache.insert(file.clone(), rec.clone());
        } else {
            let mut gone = rec.clone();
            gone.gone = true;
            live_cache.insert(file.clone(), gone);
            cache_dirty = true;
        }
    }

    file_cache = live_cache;
    {
        let mut state = STATE.lock().unwrap();
        state.file_cache = file_cache.clone();
        state.cache_needs_reparse = false;
        if cache_dirty {
            if let Some(path) = &cache_path {
                save_cache(path, &file_cache);
            }
        } else if let Some(memo) = &state.memo {
            if crate::now_ms() < state.memo_expires_ms {
                return memo.clone();
            }
        }
    }

    // Global dedup, then bucket by date|hour|minute|model|project|session.
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut buckets: BTreeMap<String, Bucket> = BTreeMap::new();
    let mut order: Vec<String> = Vec::new();
    let mut project_live: HashMap<String, bool> = HashMap::new();
    let mut newest_limits: Option<LimitsSnap> = None;
    // Turn time rides on the call that ended the turn; a replayed copy of that
    // call hands it to the bucket that kept the first copy, once.
    let now = crate::now_ms();
    let mut memo_expires_ms = f64::INFINITY;
    let abandoned: HashMap<&str, (usize, f64)> = file_cache
        .iter()
        .filter_map(|(file, rec)| {
            let turn = abandoned_turn(rec.open_turn, rec.mtime_ms, now);
            if turn.is_none() && rec.open_turn.is_some() {
                memo_expires_ms = memo_expires_ms.min(rec.mtime_ms + super::turn_clock::ABANDONED_AFTER_MS);
            }
            turn.map(|t| (file.as_str(), t))
        })
        .collect();
    let timed_keys: std::collections::HashSet<&str> = file_cache
        .iter()
        .flat_map(|(file, rec)| {
            let quiet = abandoned.get(file.as_str()).map(|(i, _)| *i);
            rec.entries.iter().enumerate().filter(move |(i, e)| e.12 > 0.0 || quiet == Some(*i))
        })
        .map(|(_, e)| e.0.as_str())
        .collect();
    let mut timed_bucket: HashMap<String, String> = HashMap::new();
    let mut timed_done: std::collections::HashSet<String> = std::collections::HashSet::new();
    for (file, rec) in &file_cache {
        if let Some(limits) = &rec.limits {
            if newest_limits.as_ref().is_none_or(|n| limits.ts >= n.ts) {
                newest_limits = Some(limits.clone());
            }
        }
        let live = project_live.entry(rec.project.clone()).or_insert(false);
        *live = *live || !rec.gone;
        if rec.entries.is_empty() {
            continue;
        }
        let session = session_of(file);
        let quiet = abandoned.get(file.as_str()).copied();
        for (index, entry) in rec.entries.iter().enumerate() {
            let Entry(key, date, hour, model, inp, out, cached, reasoning, cache_write, cache_write_known, total_input, minute, turn_ms, service_tier) = entry;
            let turn_ms = &match quiet {
                Some((i, ms)) if i == index => ms,
                _ => *turn_ms,
            };
            // Do not let an early replay event with no turn_context poison the
            // dedup key and hide the later copy that has a real model attached.
            if !is_openai_model(model) {
                continue;
            }
            if seen.contains(key) {
                if *turn_ms > 0.0 && !timed_done.contains(key) {
                    if let Some(b) = timed_bucket.get(key).and_then(|bk| buckets.get_mut(bk)) {
                        b.active_ms += turn_ms;
                        timed_done.insert(key.clone());
                    }
                }
                continue;
            }
            seen.insert(key.clone());
            let minute_str = minute.map(|m| m.to_string()).unwrap_or_else(|| "null".into());
            let bk = format!("{date}|{hour}|{minute_str}|{model}|{}|{session}", rec.project);
            if timed_keys.contains(key.as_str()) {
                timed_bucket.insert(key.clone(), bk.clone());
            }
            let bucket = buckets.entry(bk.clone()).or_insert_with(|| {
                order.push(bk.clone());
                Bucket {
                    date: date.clone(),
                    hour: *hour,
                    minute: *minute,
                    model: model.clone(),
                    project: rec.project.clone(),
                    session: session.clone(),
                    input: 0.0, output: 0.0, cached: 0.0, reasoning: 0.0, cache_write: 0.0,
                    total_input: 0.0, msgs: 0, active_ms: 0.0,
                    cost: 0.0, cost_min: 0.0, cost_max: 0.0,
                    c_in: 0.0, c_out: 0.0, c_cached: 0.0, c_reasoning: 0.0, c_write: 0.0,
                    cache_savings: 0.0,
                    priced_calls: 0, unpriced_calls: 0, estimated: false, long_context_calls: 0,
                    pricing_source: String::new(),
                    priced: false,
                    project_deleted: false,
                }
            });
            if *turn_ms > 0.0 {
                bucket.active_ms += turn_ms;
                timed_done.insert(key.clone());
            }
            bucket.input += inp;
            bucket.output += out;
            bucket.cached += cached;
            bucket.reasoning += reasoning;
            bucket.cache_write += cache_write;
            bucket.total_input += total_input;
            bucket.msgs += 1;

            let c = cost_of(model, &CodexUsage {
                input: *inp,
                output: *out,
                cached: *cached,
                reasoning: *reasoning,
                cache_write: *cache_write,
                cache_write_known: *cache_write_known,
                total_input: *total_input,
                service_tier,
                date: Some(date),
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
    }

    let mut list = Vec::with_capacity(order.len());
    for bk in order {
        let mut b = buckets.remove(&bk).unwrap();
        b.priced = b.priced_calls > 0 && b.unpriced_calls == 0;
        b.project_deleted = !project_live.get(&b.project).copied().unwrap_or(false);
        list.push(b);
    }

    let memo = Arc::new(Aggregate { buckets: list, file_count: files.len(), limits: newest_limits });
    {
        let mut state = STATE.lock().unwrap();
        state.memo = Some(memo.clone());
        state.memo_expires_ms = memo_expires_ms;
    }
    memo
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn count(ts: &str, total: u64) -> serde_json::Value {
        json!({
            "type": "event_msg", "timestamp": ts,
            "payload": { "type": "token_count", "info": {
                "total_token_usage": { "total_tokens": total },
                "last_token_usage": { "input_tokens": 10, "output_tokens": 1, "total_tokens": 11 }
            }}
        })
    }

    fn task(ts: &str, kind: &str) -> serde_json::Value {
        json!({ "type": "event_msg", "timestamp": ts, "payload": { "type": kind, "turn_id": "t1" } })
    }

    #[test]
    fn a_completed_task_is_timed_on_its_last_call() {
        let lines = [
            json!({ "type": "session_meta", "payload": { "id": "s", "cwd": "C:\\Users\\dev\\work" } }),
            json!({ "type": "turn_context", "payload": { "model": "gpt-5.6-sol" } }),
            task("2026-09-29T10:00:00Z", "task_started"),
            count("2026-09-29T10:00:20Z", 11),
            count("2026-09-29T10:05:00Z", 22),
            task("2026-09-29T10:05:10Z", "task_complete"),
        ]
        .map(|v| v.to_string())
        .join("\n");
        let entries = parse_content(&lines).entries;
        assert_eq!(entries[0].12, 0.0);
        assert_eq!(entries[1].12, 310_000.0);
    }

    #[test]
    fn a_running_task_books_no_time() {
        let lines = [
            json!({ "type": "turn_context", "payload": { "model": "gpt-5.6-sol" } }),
            task("2026-09-29T10:00:00Z", "task_started"),
            count("2026-09-29T10:00:20Z", 11),
        ]
        .map(|v| v.to_string())
        .join("\n");
        assert_eq!(parse_content(&lines).entries[0].12, 0.0);
    }

    #[test]
    fn parses_cached_input_as_a_subset_without_double_counting() {
        let lines = [
            json!({ "type": "session_meta", "payload": { "id": "session-1", "cwd": "C:\\Users\\dev\\work" } }),
            json!({ "type": "turn_context", "payload": { "model": "gpt-5.6-sol" } }),
            json!({
                "type": "event_msg", "timestamp": "2026-07-01T10:37:00Z",
                "payload": { "type": "token_count", "info": {
                    "total_token_usage": { "input_tokens": 100, "cached_input_tokens": 40, "output_tokens": 20, "total_tokens": 120 },
                    "last_token_usage": { "input_tokens": 100, "cached_input_tokens": 40, "output_tokens": 20, "reasoning_output_tokens": 5, "total_tokens": 120 }
                }}
            }),
        ]
        .map(|v| v.to_string())
        .join("\n");
        let parsed = parse_content(&lines);
        assert_eq!(parsed.project, "work"); // "C:\Users\dev" prefix stripped
        let e = &parsed.entries[0];
        assert_eq!(e.4, 60.0); // ordinary input
        assert_eq!(e.6, 40.0); // cache read
        assert_eq!(e.8, 0.0); // no measured write count
        assert!(!e.9);
        assert_eq!(e.10, 100.0);
        assert!(e.11.is_some()); // local minute, appended for cache compatibility
    }

    #[test]
    fn uses_measured_cache_write_details_when_a_future_log_exposes_them() {
        let lines = [
            json!({ "type": "session_meta", "payload": { "id": "session-2" } }),
            json!({ "type": "turn_context", "payload": { "model": "gpt-5.6-sol" } }),
            json!({
                "type": "event_msg", "timestamp": "2026-07-01T10:00:00Z",
                "payload": { "type": "token_count", "info": {
                    "total_token_usage": { "total_tokens": 130 },
                    "last_token_usage": {
                        "input_tokens": 110, "cached_input_tokens": 40, "output_tokens": 20, "total_tokens": 130,
                        "input_tokens_details": { "cache_write_tokens": 10 }
                    }
                }}
            }),
        ]
        .map(|v| v.to_string())
        .join("\n");
        let e = &parse_content(&lines).entries[0];
        assert_eq!(e.4, 60.0);
        assert_eq!(e.6, 40.0);
        assert_eq!(e.8, 10.0);
        assert!(e.9);
        assert_eq!(e.10, 110.0);
    }

    #[test]
    fn the_service_tier_comes_from_thread_settings_and_holds_across_turns() {
        // Order seen in the field: turn_context first, then the settings.
        let settings = |tier: &str| json!({ "type": "event_msg", "timestamp": "2026-11-02T19:51:29Z",
            "payload": { "type": "thread_settings_applied", "thread_settings": { "model": "gpt-6-astra", "service_tier": tier } } });
        let context = || json!({ "type": "turn_context", "payload": { "model": "gpt-6-astra" } });
        let lines = [
            json!({ "type": "session_meta", "payload": { "id": "s" } }),
            task("2026-11-02T19:51:00Z", "task_started"),
            context(),
            settings("priority"),
            count("2026-11-02T19:52:00Z", 11),
            // The next turn repeats no settings: the tier in force carries over.
            task("2026-11-02T19:53:00Z", "task_started"),
            context(),
            count("2026-11-02T19:54:00Z", 22),
            settings("default"),
            task("2026-11-02T19:55:00Z", "task_started"),
            context(),
            count("2026-11-02T19:56:00Z", 33),
        ]
        .map(|v| v.to_string())
        .join("\n");
        let tiers: Vec<String> = parse_content(&lines).entries.iter().map(|e| e.13.clone()).collect();
        assert_eq!(tiers, ["priority", "priority", "default"]);
    }

    #[test]
    fn an_older_rollout_still_takes_the_tier_from_turn_context() {
        let lines = [
            json!({ "type": "turn_context", "payload": { "model": "gpt-5.6-sol", "service_tier": "priority" } }),
            count("2026-09-29T10:00:20Z", 11),
            json!({ "type": "turn_context", "payload": { "model": "gpt-5.6-sol" } }),
            count("2026-09-29T10:01:20Z", 22),
        ]
        .map(|v| v.to_string())
        .join("\n");
        let tiers: Vec<String> = parse_content(&lines).entries.iter().map(|e| e.13.clone()).collect();
        assert_eq!(tiers, ["priority", "standard"]);
    }

    #[test]
    fn a_logged_zero_cache_write_is_not_a_measurement() {
        let lines = [
            json!({ "type": "turn_context", "payload": { "model": "gpt-6.1-sol" } }),
            json!({
                "type": "event_msg", "timestamp": "2026-11-02T19:52:00Z",
                "payload": { "type": "token_count", "info": {
                    "total_token_usage": { "total_tokens": 18812 },
                    "last_token_usage": { "input_tokens": 18666, "cached_input_tokens": 0,
                        "cache_write_input_tokens": 0, "output_tokens": 146, "total_tokens": 18812 }
                }}
            }),
        ]
        .map(|v| v.to_string())
        .join("\n");
        let e = &parse_content(&lines).entries[0];
        assert_eq!((e.4, e.8), (18666.0, 0.0));
        assert!(!e.9, "a zero leaves the write share unknown, so the cost carries a range");

        let old = BTreeMap::from([("gone.jsonl".to_string(), json!({
            "mtimeMs": 0, "size": 0, "project": "p", "gone": true,
            "entries": [
                ["k1", "2026-11-02", 19, "gpt-6.1-sol", 18666.0, 146.0, 0.0, 0.0, 0.0, true, 18666.0, 52, 0.0, "standard"],
                ["k2", "2026-11-02", 19, "gpt-6.1-sol", 8666.0, 146.0, 0.0, 0.0, 10000.0, true, 18666.0, 52, 0.0, "standard"],
            ]
        }))]);
        let upgraded = upgrade_old_files(old);
        let entries = &upgraded["gone.jsonl"].entries;
        assert!(!entries[0].9);
        assert!(entries[1].9, "a positive count stays measured");
    }

    #[test]
    fn keeps_the_newest_rate_limit_snapshot() {
        let lines = [
            json!({
                "type": "event_msg", "timestamp": "2026-07-01T10:00:00Z",
                "payload": { "type": "token_count", "rate_limits": { "primary": { "used_percent": 10 } } }
            }),
            json!({
                "type": "event_msg", "timestamp": "2026-07-01T11:00:00Z",
                "payload": { "type": "token_count", "rate_limits": { "primary": { "used_percent": 30 } } }
            }),
        ]
        .map(|v| v.to_string())
        .join("\n");
        let parsed = parse_content(&lines);
        let limits = parsed.limits.unwrap();
        assert_eq!(limits.rate_limits["primary"]["used_percent"], json!(30));
    }

    /// Not a unit test: prints per-model totals for the real rollouts so they
    /// can be recounted independently. Run with
    /// `EMBER_VERIFY_DIR=<copy of the app data dir> cargo test real_codex_totals -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn real_codex_totals() {
        let dir = std::env::var("EMBER_VERIFY_DIR").expect("EMBER_VERIFY_DIR");
        init(Path::new(&dir));
        let agg = aggregate();
        let mut by_model: BTreeMap<String, [f64; 8]> = BTreeMap::new();
        for b in &agg.buckets {
            let m = by_model.entry(b.model.clone()).or_insert([0.0; 8]);
            for (slot, v) in [b.msgs as f64, b.input, b.output, b.cached, b.cache_write, b.reasoning, b.cost_min, b.cost].into_iter().enumerate() {
                m[slot] += v;
            }
        }
        for (model, m) in by_model {
            println!("CODEX	{model}	{}	{}	{}	{}	{}	{}	{:.6}	{:.6}", m[0], m[1], m[2], m[3], m[4], m[5], m[6], m[7]);
        }
    }

    #[test]
    fn projects_normalize_like_native_rollouts() {
        assert_eq!(project_of_cwd("C:\\Users\\you\\Desktop\\my-app"), "Desktop/my-app");
        assert_eq!(project_of_cwd("C:\\Users\\you"), "~ (home)");
        assert_eq!(project_of_cwd(""), "unknown");
        assert_eq!(project_of_cwd("/home/dev/tool"), "home/dev/tool");
    }
}
