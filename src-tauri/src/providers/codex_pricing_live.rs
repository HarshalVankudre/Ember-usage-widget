//! Daily refresh of OpenAI's official published pricing doc.
//! The cache records whether a row is priced in context tiers, so the surcharge
//! comes from the official table instead of a bundled assumption. v5: retain
//! separate Standard and Fast/Priority rows, including specialized Codex rows.

use super::codex_pricing::{set_live_prices, FastPrice, LivePrice};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{OnceLock, RwLock};
use std::time::Duration;

pub const SOURCE_URL: &str = "https://developers.openai.com/api/docs/pricing.md";
pub const REFRESH: Duration = Duration::from_secs(24 * 3600);
pub const RETRY: Duration = Duration::from_secs(3600);
// 6: specialized rows split by context are folded into one model.
const CACHE_VERSION: u32 = 6;

#[derive(Clone, Copy, Default)]
struct LiveState {
    live: bool,
    fetched_at: f64,
    models: usize,
}

static STATE: RwLock<LiveState> = RwLock::new(LiveState { live: false, fetched_at: 0.0, models: 0 });
static CACHE_PATH: OnceLock<PathBuf> = OnceLock::new();

#[derive(Serialize, Deserialize)]
struct CacheFile {
    v: u32,
    #[serde(rename = "fetchedAt", default)]
    fetched_at: f64,
    prices: HashMap<String, LivePrice>,
}

/// "gpt-5.5 (<272K context length)" and "gpt-6-cyber (short context)" are
/// rows of gpt-5.5 and gpt-6-cyber; the note is not part of the model id.
fn clean_model_name(name: &str) -> String {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| {
        Regex::new(r"(?i)\s*\((?:<272k context length|short context|long context)\)\s*").unwrap()
    });
    re.replacen(&name.to_lowercase(), 1, "").trim().to_string()
}

/// "$1.25" -> 1.25; "-" (not offered) -> None.
fn dollars(cell: &str) -> Option<f64> {
    cell.trim().strip_prefix('$')?.replace(',', "").trim().parse().ok()
}

/// Read speed sections explicitly so Batch, Flex and Ultrafast can never
/// overwrite Standard or Fast. Column names also handle the specialized Codex
/// table, which prefixes its model column with a Category column.
pub fn build_map(markdown: &str) -> HashMap<String, LivePrice> {
    static TIER: OnceLock<Regex> = OnceLock::new();
    static ID: OnceLock<Regex> = OnceLock::new();
    let tier_re = TIER.get_or_init(|| Regex::new(r"(?i)<\s*272k context length").unwrap());
    let id_re = ID.get_or_init(|| Regex::new(r"^(?:gpt|chatgpt|chat-|codex|o\d)").unwrap());

    static LONG_ROW: OnceLock<Regex> = OnceLock::new();
    let long_row_re = LONG_ROW.get_or_init(|| Regex::new(r"(?i)\(long context\)").unwrap());

    let mut map: HashMap<String, LivePrice> = HashMap::new();
    let mut fast_rows = HashMap::new();
    // Specialized models list their long-context prices on a row of their own.
    let mut long_rows: Vec<(String, bool)> = Vec::new();
    let mut speed = "standard";
    let mut header: Option<Vec<String>> = None;
    for line in markdown.lines() {
        let line = line.trim();
        if !line.starts_with('|') {
            header = None;
            let label = line.trim_start_matches('#').trim().to_ascii_lowercase();
            match label.as_str() {
                "standard" | "standard pricing data" => speed = "standard",
                "fast" | "priority" | "fast pricing data" | "priority pricing data" => speed = "fast",
                "batch" | "flex" | "ultrafast" | "batch pricing data" | "flex pricing data" | "ultrafast pricing data" => speed = "skip",
                _ => {}
            }
            continue;
        }
        let cells: Vec<&str> = line.trim_matches('|').split('|').map(str::trim).collect();
        if cells[0].eq_ignore_ascii_case("model") || cells[0].eq_ignore_ascii_case("category") {
            header = Some(cells.iter().map(|c| c.to_lowercase()).collect());
            continue;
        }
        let Some(cols) = header.as_ref() else { continue };
        // Only the text-token tables put Input straight after Model. The rest
        // (fine-tuning "Training", realtime "Modality", transcription "Use
        // case") price something else, and fine-tuning reuses dated snapshot
        // ids like gpt-4.1-2025-04-14 at a different rate.
        let Some(model_col) = cols.iter().position(|c| c == "model") else { continue };
        let text_table = matches!(cols.get(model_col + 1).map(String::as_str), Some("input" | "short context input"));
        if speed == "skip" || !text_table || cells.len() != cols.len() {
            continue;
        }
        let col = |names: &[&str]| {
            names
                .iter()
                .find_map(|n| cols.iter().position(|c| c == n))
                .and_then(|i| dollars(cells[i]))
        };
        let name = cells[model_col];
        let id = clean_model_name(name);
        if !id_re.is_match(&id) {
            continue;
        }
        if long_row_re.is_match(name) {
            // Priced: the model is tiered. "-": long context is not offered.
            let priced = col(&["input"]).is_some() && col(&["output"]).is_some();
            long_rows.push((id, priced && speed == "standard"));
            continue;
        }
        let (Some(input), Some(output)) = (
            col(&["short context input", "input"]),
            col(&["short context output", "output"]),
        ) else {
            continue;
        };
        // A published long-context price (or the older "(<272K context
        // length)" label) is the only statement that a model is tiered, so it
        // is recorded rather than inferred from the family.
        let long_context = col(&["long context input"]).is_some();
        let cached = col(&["short context cached input", "cached input"]).unwrap_or(input);
        let write = col(&["short context 30m write", "30m write"]);
        if speed == "fast" {
            fast_rows.entry(id).or_insert(FastPrice {
                input, cached, write, output, long_context,
                short_context_only: !long_context && (tier_re.is_match(name) || cols.iter().any(|c| c == "short context input")),
            });
            continue;
        }
        map.entry(id).or_insert(LivePrice {
            input,
            cached,
            write,
            output,
            long_context: Some(long_context || tier_re.is_match(name)),
            fast: None,
        });
    }
    for (id, priced) in long_rows {
        if let Some(price) = map.get_mut(&id) {
            if priced {
                price.long_context = Some(true);
            }
        }
    }
    for (id, rates) in fast_rows {
        if let Some(price) = map.get_mut(&id) {
            price.fast = Some(rates);
        }
    }
    map
}

fn apply(prices: HashMap<String, LivePrice>, fetched_at: f64) -> bool {
    let models = prices.len();
    if models == 0 || !prices.values().any(|p| p.fast.is_some()) {
        return false;
    }
    set_live_prices(prices);
    *STATE.write().unwrap() = LiveState { live: true, fetched_at, models };
    true
}

pub fn status() -> serde_json::Value {
    let s = *STATE.read().unwrap();
    json!({
        "live": s.live,
        "fetchedAt": s.fetched_at,
        "models": s.models,
        "provider": "OpenAI",
        "source": if s.live { "Official pricing · live" } else { "Official pricing · bundled" },
        "url": SOURCE_URL,
    })
}

pub fn is_fresh() -> bool {
    let s = *STATE.read().unwrap();
    s.live && crate::now_ms() - s.fetched_at < REFRESH.as_millis() as f64
}

pub fn init(user_data: &std::path::Path) {
    let cache_path = user_data.join("openai-pricing.json");
    let _ = CACHE_PATH.set(cache_path.clone());
    if let Ok(raw) = std::fs::read_to_string(&cache_path) {
        if let Ok(parsed) = serde_json::from_str::<CacheFile>(&raw) {
            if parsed.v == CACHE_VERSION {
                apply(parsed.prices, parsed.fetched_at);
            }
        }
    }
}

pub async fn refresh(client: &reqwest::Client) -> bool {
    let result = async {
        let res = client
            .get(SOURCE_URL)
            .header("accept", "text/markdown")
            .timeout(Duration::from_secs(30))
            .send()
            .await?;
        if !res.status().is_success() {
            return Err(format!("HTTP {}", res.status().as_u16()).into());
        }
        let text = res.text().await?;
        Ok::<String, Box<dyn std::error::Error + Send + Sync>>(text)
    }
    .await;

    match result {
        Ok(text) => {
            let prices = build_map(&text);
            let fetched_at = crate::now_ms();
            if !apply(prices.clone(), fetched_at) {
                eprintln!("OpenAI pricing refresh failed: empty standard price table");
                return false;
            }
            if let Some(path) = CACHE_PATH.get() {
                let cache = CacheFile { v: CACHE_VERSION, fetched_at, prices };
                if let Ok(body) = serde_json::to_string(&cache) {
                    let _ = crate::persist::write_atomic(path, body);
                }
            }
            true
        }
        Err(err) => {
            eprintln!("OpenAI pricing refresh failed: {err}");
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn official_snapshot_keeps_fast_separate_and_prices_specialized_codex() {
        let map = build_map(include_str!("fixtures/openai-pricing-2026-11-01.md"));
        let sol = &map["gpt-6.1-sol"];
        assert_eq!((sol.input, sol.cached, sol.write, sol.output), (2.0, 0.1, Some(2.5), 10.0));
        let fast = sol.fast.as_ref().unwrap();
        assert_eq!((fast.input, fast.cached, fast.write, fast.output), (4.0, 0.2, Some(5.0), 20.0));
        assert!(fast.long_context);
        assert!(!fast.short_context_only);
        assert_eq!(map["gpt-5.5"].fast.as_ref().unwrap().input, 12.5);
        assert!(map["gpt-5.5"].fast.as_ref().unwrap().short_context_only);
        assert!(!map["gpt-5.5"].fast.as_ref().unwrap().long_context);
        assert_eq!(map["gpt-5-mini"].fast.as_ref().unwrap().input, 0.45);
        assert_eq!(map["gpt-4o"].fast.as_ref().unwrap().cached, 2.125);
        assert_eq!(map["gpt-5.3-codex"].input, 1.75);
        assert_eq!(map["gpt-5.3-codex"].fast.as_ref().unwrap().output, 28.0);
        assert!(map["gpt-5-pro"].fast.is_none());
        assert_eq!(map.values().filter(|p| p.fast.is_some()).count(), 24);
    }

    #[test]
    fn specialized_rows_split_by_context_belong_to_one_model() {
        let map = build_map(include_str!("fixtures/openai-pricing-2026-11-10.md"));
        assert!(!map.keys().any(|k| k.contains('(')), "a context note leaked into a model id");
        let cyber = &map["gpt-6-cyber"];
        assert_eq!((cyber.input, cyber.cached, cyber.write, cyber.output), (20.0, 2.0, Some(25.0), 100.0));
        assert_eq!(cyber.long_context, Some(true));
        assert_eq!(map["gpt-5.6-cyber"].long_context, Some(false));
        assert_eq!(map["gpt-5.5-cyber-preview"].input, 12.5);
        assert_eq!(map["gpt-rosalind-research"].output, 25.0);
        assert_eq!(map["gpt-6-astra-law"].cached, 1.0);
        // Batch, Flex and Ultrafast never overwrite Standard.
        assert_eq!(map["gpt-6-astra"].input, 10.0);
        assert_eq!(map["gpt-6-astra"].fast.as_ref().unwrap().input, 20.0);
        assert_eq!(map["gpt-5.3-codex"].fast.as_ref().unwrap().input, 3.5);
    }

    const HEAD: &str = "| Model | Short context input | Short context output | Short context cached input | Short context 30m write | Short context 12h write | Long context input | Long context output | Long context cached input | Long context 30m write | Long context 12h write |\n\
                        | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |\n";

    #[test]
    fn parses_first_official_openai_standard_price_rows() {
        let doc = format!(
            "### Standard pricing data\n\n{HEAD}\
             | gpt-6.1-sol | $2.00 | $10.00 | $0.10 | $2.50 | $5.00 | $4.00 | $15.00 | $0.20 | $5.00 | $10.00 |\n\
             | gpt-5.5 (<272K context length) | $5.00 | $30.00 | $0.50 | - | - | $10.00 | $45.00 | $1.00 | - | - |\n\
             | gpt-5.5-pro (<272K context length) | $30.00 | $180.00 | - | - | - | $60.00 | $270.00 | - | - | - |\n\
             \n\
             | Model | Input | Output | Cached input |\n\
             | --- | --- | --- | --- |\n\
             | gpt-5.4-mini | $0.75 | $4.50 | $0.075 |\n\
             | gpt-5-pro | $15.00 | $120.00 | - |\n\
             \n\
             ### Batch pricing data\n\n{HEAD}\
             | gpt-6.1-sol | $1.00 | $5.00 | $0.05 | $1.25 | $2.50 | $2.00 | $7.50 | $0.10 | $2.50 | $5.00 |\n\
             \n\
             ### Standard pricing data\n\n{HEAD}\
             | gpt-5.6-cyber | $12.50 | $75.00 | $1.25 | $15.625 | $31.25 | - | - | - | - | - |\n\
             \n\
             | Model | Modality | Input | Output / cost | Cached input |\n\
             | --- | --- | --- | --- | --- |\n\
             | gpt-realtime-2.1 | Audio | $32.00 | $64.00 | $0.40 |\n\
             \n\
             | Model | Training | Input | Output | Cached input |\n\
             | --- | --- | --- | --- | --- |\n\
             | gpt-4.1-2025-04-14 | $25.00 | $3.00 | $12.00 | $0.75 |\n"
        );
        let map = build_map(&doc);
        let sol = &map["gpt-6.1-sol"];
        assert_eq!((sol.input, sol.cached, sol.write, sol.output), (2.0, 0.1, Some(2.5), 10.0));
        assert_eq!(sol.long_context, Some(true));
        let g55 = &map["gpt-5.5"];
        assert_eq!((g55.input, g55.cached, g55.write, g55.output), (5.0, 0.5, None, 30.0));
        assert_eq!(g55.long_context, Some(true));
        assert_eq!(map["gpt-5.5-pro"].cached, 30.0);
        let mini = &map["gpt-5.4-mini"];
        assert_eq!((mini.input, mini.cached, mini.output), (0.75, 0.075, 4.5));
        assert_eq!(mini.long_context, Some(false));
        assert_eq!(map["gpt-5-pro"].cached, 15.0);
        let cyber = &map["gpt-5.6-cyber"];
        assert_eq!((cyber.write, cyber.long_context), (Some(15.625), Some(false)));
        assert!(!map.contains_key("gpt-realtime-2.1"));
        assert!(!map.contains_key("gpt-4.1-2025-04-14"));
    }
}
