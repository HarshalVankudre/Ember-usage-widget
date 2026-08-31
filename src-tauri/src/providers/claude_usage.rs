//! Claude Code (and ClaudeX) transcript parsing with a durable file cache.
//! Parsed records survive log deletion — files that vanish keep their entries
//! flagged `gone`, so usage history outlives the session logs themselves.

use super::claude_pricing::{cost_of as claude_cost_of, ClaudeUsage};
use super::claudex_paths;
use super::codex_pricing::{cost_of as codex_cost_of, CodexUsage};
use super::model_attribution::is_openai_model;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

const CACHE_VERSION: u32 = 5; // v5: reasoning (thinking) tokens appended to cached entries
const LEGACY_ENTRY_LENGTH: usize = 13;
const V4_ENTRY_LENGTH: usize = 14;

/// entry: [dedupKey, date, hour, model, input, output, cacheRead, cacheW5m,
///         cacheW1h, speed, inferenceGeo, webSearches, serviceTier, minute]
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Entry(
    pub String,      // dedup key
    pub String,      // date
    pub u32,         // hour
    pub String,      // model
    pub f64,         // input
    pub f64,         // output
    pub f64,         // cache read
    pub f64,         // cache write 5m
    pub f64,         // cache write 1h
    pub String,      // speed
    pub String,      // inference geo
    pub f64,         // web searches
    pub String,      // service tier
    pub Option<u32>, // minute
    pub f64,         // reasoning (thinking subset of output — informational)
);

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileRec {
    pub mtime_ms: f64,
    pub size: u64,
    pub entries: Vec<Entry>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub gone: bool,
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
    pub cache_read: f64,
    pub cache_w5m: f64,
    pub cache_w1h: f64,
    pub reasoning: f64,
    pub web_searches: f64,
    pub msgs: u64,
    pub cost: f64,
    pub cost_min: f64,
    pub cost_max: f64,
    pub c_in: f64,
    pub c_out: f64,
    pub c_cr: f64,
    pub c_cw: f64,
    pub c_reasoning: f64,
    pub c_tool: f64,
    pub cache_savings: f64,
    pub priced_calls: u64,
    pub unpriced_calls: u64,
    pub estimated: bool,
    pub fast_calls: u64,
    pub us_region_calls: u64,
    pub long_context_calls: u64,
    pub pricing_source: String,
    pub priced: bool,
    pub project_deleted: bool,
}

#[derive(Clone)]
pub struct Aggregate {
    pub buckets: Vec<Bucket>,
    pub file_count: usize,
}

#[derive(Default)]
struct State {
    cache_path: Option<PathBuf>,
    file_cache: BTreeMap<String, FileRec>,
    cache_needs_reparse: bool,
    memo: Option<Arc<Aggregate>>,
}

static STATE: Mutex<State> = Mutex::new(State {
    cache_path: None,
    file_cache: BTreeMap::new(),
    cache_needs_reparse: false,
    memo: None,
});

pub fn claude_projects_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".claude")
        .join("projects")
}

pub fn projects_dirs() -> Vec<PathBuf> {
    vec![claude_projects_dir(), claudex_paths::projects_dir()]
}

/// Prices can change without any log changing; drop the memo so the next pass
/// rebuilds instead of serving costs from the old rate table.
pub fn invalidate() {
    STATE.lock().unwrap().memo = None;
}

fn upgrade_old_files(files: BTreeMap<String, serde_json::Value>) -> BTreeMap<String, FileRec> {
    let mut upgraded = BTreeMap::new();
    for (file, mut rec) in files {
        if let Some(entries) = rec.get_mut("entries").and_then(|e| e.as_array_mut()) {
            for entry in entries.iter_mut() {
                if let Some(arr) = entry.as_array_mut() {
                    if arr.len() == LEGACY_ENTRY_LENGTH {
                        arr.push(serde_json::Value::Null);
                    }
                    if arr.len() == V4_ENTRY_LENGTH {
                        arr.push(serde_json::json!(0.0));
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

pub fn init(user_data: &Path) {
    let mut state = STATE.lock().unwrap();
    state.cache_path = Some(user_data.join("claude-usage-cache.json"));
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
    let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&raw) else { return };
    match parsed.get("v").and_then(|v| v.as_u64()) {
        Some(v) if v == CACHE_VERSION as u64 => {
            if let Some(files) = parsed.get("files") {
                if let Ok(files) = serde_json::from_value::<BTreeMap<String, FileRec>>(files.clone()) {
                    state.file_cache = files;
                }
            }
        }
        Some(3) | Some(4) => {
            if let Some(files) = parsed.get("files") {
                if let Ok(files) =
                    serde_json::from_value::<BTreeMap<String, serde_json::Value>>(files.clone())
                {
                    state.file_cache = upgrade_old_files(files);
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

fn projects_root_of<'a>(file: &str, roots: &'a [String]) -> &'a str {
    roots
        .iter()
        .find(|dir| {
            file == dir.as_str() || file.starts_with(&format!("{dir}{}", std::path::MAIN_SEPARATOR))
        })
        .map(String::as_str)
        .unwrap_or(&roots[0])
}

fn project_of(file: &str, roots: &[String]) -> String {
    static USERS_RE: OnceLock<regex::Regex> = OnceLock::new();
    let users_re = USERS_RE.get_or_init(|| regex::Regex::new(r"^C--Users-[^-]+-?").unwrap());
    let root = projects_root_of(file, roots);
    let rel = file.strip_prefix(root).unwrap_or(file);
    let rel = rel.trim_start_matches(std::path::MAIN_SEPARATOR);
    let slug = rel.split(std::path::MAIN_SEPARATOR).next().unwrap_or("unknown");
    // "C--Users-you-Desktop-my-app" -> "Desktop/my/app" style readable name
    let name = users_re.replace(slug, "").replace('-', "/");
    if name.is_empty() { "~ (home)".to_string() } else { name }
}

fn session_of(file: &str, roots: &[String]) -> String {
    let root = projects_root_of(file, roots);
    let rel = file.strip_prefix(root).unwrap_or(file);
    let rel = rel.trim_start_matches(std::path::MAIN_SEPARATOR);
    let parts: Vec<&str> = rel.split(std::path::MAIN_SEPARATOR).collect();
    // <project>/<session>.jsonl  OR  <project>/<session>/subagents/.../*.jsonl
    if parts.len() == 2 {
        parts[1].trim_end_matches(".jsonl").to_string()
    } else {
        parts.get(1).unwrap_or(&"").to_string()
    }
}

fn num(v: Option<&serde_json::Value>) -> f64 {
    v.and_then(|v| v.as_f64()).unwrap_or(0.0)
}

fn str_field(v: Option<&serde_json::Value>) -> Option<&str> {
    v.and_then(|v| v.as_str()).filter(|s| !s.is_empty())
}

pub fn parse_content(text: &str, source: &str) -> Vec<Entry> {
    let mut entries = Vec::new();
    for line in text.split('\n') {
        if line.is_empty() || !line.contains("\"usage\"") {
            continue;
        }
        let Ok(obj) = serde_json::from_str::<serde_json::Value>(line) else { continue };
        let msg = obj.get("message");
        let usage = msg.and_then(|m| m.get("usage"));
        let (Some(msg), Some(u)) = (msg, usage) else { continue };
        let Some(model) = msg.get("model").and_then(|m| m.as_str()) else { continue };
        if model == "<synthetic>" {
            continue;
        }
        let timestamp = obj.get("timestamp").and_then(|t| t.as_str()).unwrap_or("");
        let Some(parts) = crate::local_parts(timestamp) else { continue };
        let cc = u.get("cache_creation");
        let cw5 = cc.and_then(|c| c.get("ephemeral_5m_input_tokens")).filter(|v| !v.is_null());
        let cw1 = cc.and_then(|c| c.get("ephemeral_1h_input_tokens")).filter(|v| !v.is_null());
        // Older logs only have the combined figure; treat it as 5m-TTL writes.
        let has_split = cw5.is_some() || cw1.is_some();
        let write5 = if has_split {
            cw5.and_then(|v| v.as_f64()).unwrap_or(0.0)
        } else {
            num(u.get("cache_creation_input_tokens"))
        };
        let write1 = if has_split { cw1.and_then(|v| v.as_f64()).unwrap_or(0.0) } else { 0.0 };
        let tools = u.get("server_tool_use");
        let web_searches = tools
            .and_then(|t| {
                t.get("web_search_requests")
                    .and_then(|v| v.as_f64())
                    .filter(|v| *v != 0.0)
                    .or_else(|| t.get("web_searches").and_then(|v| v.as_f64()))
            })
            .unwrap_or(0.0)
            .max(0.0);
        let speed = str_field(u.get("speed"));
        let geo = str_field(u.get("inference_geo"));
        // Anthropic reports thinking as a breakdown of output_tokens, not as
        // an extra charge; older logs omit the field entirely.
        let reasoning = num(
            u.get("output_tokens_details")
                .and_then(|d| d.get("thinking_tokens")),
        )
        .max(0.0);
        let key = match msg.get("id").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) {
            Some(id) => format!("{id}:{}", obj.get("requestId").and_then(|v| v.as_str()).unwrap_or("")),
            None => match obj.get("uuid").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) {
                Some(uuid) => uuid.to_string(),
                None => [
                    source,
                    timestamp,
                    model,
                    &crate::js_num(num(u.get("input_tokens"))),
                    &crate::js_num(num(u.get("output_tokens"))),
                    &crate::js_num(num(u.get("cache_read_input_tokens"))),
                    &crate::js_num(write5),
                    &crate::js_num(write1),
                    speed.unwrap_or(""),
                    geo.unwrap_or(""),
                    &crate::js_num(web_searches),
                ]
                .join(":"),
            },
        };
        entries.push(Entry(
            key,
            parts.date,
            parts.hour,
            model.to_string(),
            num(u.get("input_tokens")),
            num(u.get("output_tokens")),
            num(u.get("cache_read_input_tokens")),
            write5,
            write1,
            speed.unwrap_or("standard").to_string(),
            geo.unwrap_or("not_available").to_string(),
            web_searches,
            str_field(u.get("service_tier")).unwrap_or("standard").to_string(),
            Some(parts.minute),
            reasoning,
        ));
    }
    entries
}

pub fn aggregate() -> Arc<Aggregate> {
    let (mut file_cache, cache_path, force_reparse) = {
        let state = STATE.lock().unwrap();
        (state.file_cache.clone(), state.cache_path.clone(), state.cache_needs_reparse)
    };

    let roots: Vec<String> = projects_dirs()
        .iter()
        .map(|p| p.to_string_lossy().into_owned())
        .collect();
    let mut files = Vec::new();
    for dir in projects_dirs() {
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
                    // a previously deleted file came back (restore from backup)
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
        let source = if projects_root_of(&key, &roots) == roots[1] { "claudex" } else { "claude" };
        let parsed = std::fs::read_to_string(file).ok().map(|text| parse_content(&text, source));
        match parsed {
            Some(entries) => {
                live_cache.insert(key, FileRec { mtime_ms, size, entries, gone: false });
            }
            None => match prev {
                // preserve cached history at legacy precision if a file is unreadable
                Some(prev) => {
                    let mut rec = prev.clone();
                    rec.gone = false;
                    rec.mtime_ms = mtime_ms;
                    rec.size = size;
                    live_cache.insert(key, rec);
                }
                None => {
                    live_cache.insert(key, FileRec { mtime_ms, size, entries: Vec::new(), gone: false });
                }
            },
        }
        cache_dirty = true;
    }

    // Files that vanished from disk (deleted project folders, pruned logs) keep
    // their parsed records forever — usage history survives log deletion. They
    // are flagged `gone` so the UI can group their projects separately.
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
            // Nothing was reparsed, added or removed, so the records are
            // byte-identical to the pass that produced the memo.
            return memo.clone();
        }
    }

    // Global dedup (resumed sessions copy older messages into new files),
    // then bucket by date|hour|minute|model|project|session.
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut buckets: BTreeMap<String, Bucket> = BTreeMap::new();
    let mut order: Vec<String> = Vec::new();
    let mut project_live: HashMap<String, bool> = HashMap::new();
    for (file, rec) in &file_cache {
        let project = project_of(file, &roots);
        let live = project_live.entry(project.clone()).or_insert(false);
        *live = *live || !rec.gone;
        if rec.entries.is_empty() {
            continue;
        }
        let session = session_of(file, &roots);
        for entry in &rec.entries {
            let Entry(key, date, hour, model, inp, out, cr, cw5, cw1, speed, geo, web_searches, service_tier, minute, reasoning) = entry;
            if seen.contains(key) {
                continue;
            }
            seen.insert(key.clone());
            let minute_str = minute.map(|m| m.to_string()).unwrap_or_else(|| "null".into());
            let bk = format!("{date}|{hour}|{minute_str}|{model}|{project}|{session}");
            let bucket = buckets.entry(bk.clone()).or_insert_with(|| {
                order.push(bk.clone());
                Bucket {
                    date: date.clone(),
                    hour: *hour,
                    minute: *minute,
                    model: model.clone(),
                    project: project.clone(),
                    session: session.clone(),
                    input: 0.0, output: 0.0, cache_read: 0.0, cache_w5m: 0.0, cache_w1h: 0.0,
                    reasoning: 0.0,
                    web_searches: 0.0, msgs: 0,
                    cost: 0.0, cost_min: 0.0, cost_max: 0.0,
                    c_in: 0.0, c_out: 0.0, c_cr: 0.0, c_cw: 0.0, c_reasoning: 0.0, c_tool: 0.0, cache_savings: 0.0,
                    priced_calls: 0, unpriced_calls: 0, estimated: false,
                    fast_calls: 0, us_region_calls: 0, long_context_calls: 0,
                    pricing_source: String::new(),
                    priced: false,
                    project_deleted: false,
                }
            });
            bucket.input += inp;
            bucket.output += out;
            bucket.cache_read += cr;
            bucket.cache_w5m += cw5;
            bucket.cache_w1h += cw1;
            bucket.reasoning += reasoning;
            bucket.web_searches += web_searches;
            bucket.msgs += 1;

            let gateway = is_openai_model(model);
            if gateway {
                let c = codex_cost_of(model, &CodexUsage {
                    input: *inp,
                    output: *out,
                    cached: *cr,
                    cache_write: cw5 + cw1,
                    cache_write_known: true,
                    total_input: inp + cr + cw5 + cw1,
                    reasoning: *reasoning,
                });
                bucket.cost += c.total;
                bucket.cost_min += c.cost_min;
                bucket.cost_max += c.cost_max;
                bucket.c_in += c.input;
                bucket.c_out += c.output;
                bucket.c_cr += c.cached;
                bucket.c_cw += c.cache_write;
                bucket.c_reasoning += c.reasoning;
                bucket.cache_savings += c.cache_savings;
                bucket.estimated = bucket.estimated || c.estimated;
                bucket.long_context_calls += if c.long_context { 1 } else { 0 };
                if !c.source.is_empty() {
                    bucket.pricing_source = c.source.clone();
                }
                if c.known { bucket.priced_calls += 1 } else { bucket.unpriced_calls += 1 }
            } else {
                let c = claude_cost_of(model, &ClaudeUsage {
                    date: Some(date),
                    input: *inp,
                    output: *out,
                    cache_read: *cr,
                    cache_w5m: *cw5,
                    cache_w1h: *cw1,
                    speed,
                    inference_geo: geo,
                    web_searches: *web_searches,
                });
                let _ = service_tier; // recorded in the cache; not a rate input
                bucket.cost += c.total;
                bucket.cost_min += c.cost_min;
                bucket.cost_max += c.cost_max;
                bucket.c_in += c.input;
                bucket.c_out += c.output;
                bucket.c_cr += c.cache_read;
                bucket.c_cw += c.cache_write;
                // Thinking is billed inside output at the same rate, so carve the
                // share out of the output cost instead of adding to the total.
                if *out > 0.0 {
                    bucket.c_reasoning += c.output * (*reasoning / *out);
                }
                bucket.c_tool += c.tool_fee;
                bucket.cache_savings += c.cache_savings;
                bucket.estimated = bucket.estimated || c.estimated;
                bucket.fast_calls += if c.fast { 1 } else { 0 };
                bucket.us_region_calls += if c.us_region { 1 } else { 0 };
                if !c.source.is_empty() {
                    bucket.pricing_source = c.source.clone();
                }
                if c.known { bucket.priced_calls += 1 } else { bucket.unpriced_calls += 1 }
            }
        }
    }

    let mut list = Vec::with_capacity(order.len());
    for bk in order {
        let mut b = buckets.remove(&bk).unwrap();
        b.priced = b.priced_calls > 0 && b.unpriced_calls == 0;
        b.project_deleted = !project_live.get(&b.project).copied().unwrap_or(false);
        list.push(b);
    }

    let memo = Arc::new(Aggregate { buckets: list, file_count: files.len() });
    STATE.lock().unwrap().memo = Some(memo.clone());
    memo
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_claude_cache_ttls_and_request_level_pricing_modifiers() {
        let line = serde_json::json!({
            "timestamp": "2026-07-01T10:42:00+05:30",
            "requestId": "request-1",
            "message": { "id": "message-1", "model": "claude-opus-4-8", "usage": {
                "input_tokens": 10, "output_tokens": 5, "cache_read_input_tokens": 20,
                "cache_creation": { "ephemeral_5m_input_tokens": 30, "ephemeral_1h_input_tokens": 40 },
                "speed": "fast", "inference_geo": "us", "service_tier": "standard",
                "server_tool_use": { "web_search_requests": 1 }
            }}
        })
        .to_string();
        let entries = parse_content(&line, "claude");
        let e = &entries[0];
        assert_eq!(e.0, "message-1:request-1");
        assert_eq!((e.4, e.5, e.6, e.7, e.8), (10.0, 5.0, 20.0, 30.0, 40.0));
        assert_eq!((e.9.as_str(), e.10.as_str(), e.11, e.12.as_str()), ("fast", "us", 1.0, "standard"));
        assert!(e.13.is_some());
    }

    #[test]
    fn fallback_dedup_keys_are_deterministic_across_reparses() {
        let line = serde_json::json!({
            "timestamp": "2026-07-01T10:00:00Z",
            "message": { "model": "claude-sonnet-5", "usage": { "input_tokens": 10, "output_tokens": 5 } }
        })
        .to_string();
        let a = parse_content(&line, "claude")[0].0.clone();
        let b = parse_content(&line, "claude")[0].0.clone();
        let c = parse_content(&line, "claudex")[0].0.clone();
        assert_eq!(a, b);
        assert_ne!(a, c);
    }

    #[test]
    fn combined_legacy_cache_creation_counts_as_5m_writes() {
        let line = serde_json::json!({
            "timestamp": "2026-07-01T10:00:00Z",
            "message": { "id": "m1", "model": "claude-sonnet-5", "usage": {
                "input_tokens": 1, "output_tokens": 1,
                "cache_creation_input_tokens": 77
            }}
        })
        .to_string();
        let e = &parse_content(&line, "claude")[0];
        assert_eq!((e.7, e.8), (77.0, 0.0));
    }

    #[test]
    fn thinking_tokens_are_read_as_a_subset_of_output() {
        let lines = [
            serde_json::json!({
                "timestamp": "2026-07-01T10:00:00Z",
                "message": { "id": "m1", "model": "claude-opus-5", "usage": {
                    "input_tokens": 10, "output_tokens": 15086,
                    "output_tokens_details": { "thinking_tokens": 7415 }
                }}
            })
            .to_string(),
            // Older logs, and models with thinking off, carry no breakdown.
            serde_json::json!({
                "timestamp": "2026-07-01T10:00:00Z",
                "message": { "id": "m2", "model": "claude-opus-5", "usage": {
                    "input_tokens": 10, "output_tokens": 20, "output_tokens_details": null
                }}
            })
            .to_string(),
        ]
        .join("
");
        let entries = parse_content(&lines, "claude");
        assert_eq!(entries[0].14, 7415.0);
        assert!(entries[0].14 < entries[0].5, "thinking is part of output, never on top of it");
        assert_eq!(entries[1].14, 0.0);
    }

    #[test]
    fn synthetic_and_unusable_lines_are_skipped() {
        let lines = [
            serde_json::json!({"timestamp": "2026-07-01T10:00:00Z", "message": {"model": "<synthetic>", "usage": {"input_tokens": 5}}}).to_string(),
            "not json but mentions \"usage\"".to_string(),
            serde_json::json!({"timestamp": "bogus", "message": {"model": "claude-sonnet-5", "usage": {"input_tokens": 5}}}).to_string(),
        ]
        .join("\n");
        assert!(parse_content(&lines, "claude").is_empty());
    }
}
