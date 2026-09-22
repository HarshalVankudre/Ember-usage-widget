//! Daily refresh of Anthropic's official published pricing table.

use super::claude_pricing::{set_live_prices, LivePrice};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{OnceLock, RwLock};
use std::time::Duration;

pub const SOURCE_URL: &str = "https://platform.claude.com/docs/en/about-claude/pricing.md";
pub const REFRESH: Duration = Duration::from_secs(24 * 3600);
pub const RETRY: Duration = Duration::from_secs(3600);
/// How often the refresh loop wakes to check for an early refresh.
pub const TICK: Duration = Duration::from_secs(10 * 60);
const EARLY_MIN_GAP: Duration = Duration::from_secs(30 * 60);
// 2: rows carry fast-mode rates, and Opus 5.5 must not wait out a v1 cache.
const CACHE_VERSION: u32 = 2;

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

fn dollars(cell: &str) -> Option<f64> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r"\$([\d.]+)").unwrap());
    re.captures(cell)?.get(1)?.as_str().parse().ok()
}

pub fn build_map(markdown: &str) -> HashMap<String, LivePrice> {
    static ROW: OnceLock<Regex> = OnceLock::new();
    static NAME: OnceLock<Regex> = OnceLock::new();
    static STANDARD: OnceLock<Regex> = OnceLock::new();
    static INTRO: OnceLock<Regex> = OnceLock::new();
    let row_re = ROW.get_or_init(|| Regex::new(r"(?i)^\|\s*Claude\s+").unwrap());
    let name_re = NAME.get_or_init(|| {
        Regex::new(r"(?i)Claude\s+(Fable|Mythos|Opus|Sonnet|Haiku)\s+(\d+(?:\.\d+)?)").unwrap()
    });
    // A row qualified by a date ("through August 31", "starting September 1")
    // is a dated variant, keyed apart so it never masquerades as the standing
    // price. An unqualified row is the price, whatever the model.
    let standard_re = STANDARD.get_or_init(|| Regex::new(r"(?i)\bstarting\b").unwrap());
    let intro_re = INTRO.get_or_init(|| Regex::new(r"(?i)\bthrough\b").unwrap());

    let mut map = HashMap::new();
    let mut fast = Vec::new();
    let mut section = "";
    for line in markdown.lines() {
        if line.starts_with('#') {
            section = line.trim_start_matches('#').trim();
            continue;
        }
        if !row_re.is_match(line) {
            continue;
        }
        let parts: Vec<&str> = line.split('|').collect();
        if parts.len() < 2 {
            continue;
        }
        let cells: Vec<&str> = parts[1..parts.len() - 1].iter().map(|c| c.trim()).collect();
        // "| Claude Opus 5 / Claude Opus 4.8 | $10 / MTok | $50 / MTok |"
        if section.eq_ignore_ascii_case("Fast mode pricing") && cells.len() == 3 {
            if let (Some(input), Some(output)) = (dollars(cells[1]), dollars(cells[2])) {
                for hit in name_re.captures_iter(cells[0]) {
                    let key = format!("{}-{}", hit[1].to_lowercase(), hit[2].replacen('.', "-", 1));
                    fast.push((key, input, output));
                }
            }
            continue;
        }
        if cells.len() != 6 {
            continue;
        }
        let Some(hit) = name_re.captures(cells[0]) else { continue };
        let family = hit[1].to_lowercase();
        let version = hit[2].replacen('.', "-", 1);
        let mut key = format!("{family}-{version}");
        if standard_re.is_match(cells[0]) {
            key.push_str("@standard");
        } else if intro_re.is_match(cells[0]) {
            key.push_str("@intro");
        }
        if map.contains_key(&key) {
            continue;
        }
        let vals: Vec<Option<f64>> = cells[1..6].iter().map(|c| dollars(c)).collect();
        let [Some(input), Some(cache_w5m), Some(cache_w1h), Some(cache_read), Some(output)] = vals[..] else {
            continue;
        };
        map.insert(key, LivePrice {
            input, cache_w5m, cache_w1h, cache_read, output,
            family: Some(family), fast_input: None, fast_output: None,
        });
    }
    for (key, input, output) in fast {
        if let Some(row) = map.get_mut(&key) {
            row.fast_input = Some(input);
            row.fast_output = Some(output);
        }
    }
    map
}

fn apply(prices: HashMap<String, LivePrice>, fetched_at: f64) -> bool {
    let models = prices.len();
    if models == 0 {
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
        "provider": "Anthropic",
        "source": if s.live { "Official pricing · live" } else { "Official pricing · bundled" },
        "url": SOURCE_URL,
    })
}

/// Last refresh attempt, successful or not, so early refreshes stay rare.
static LAST_ATTEMPT: RwLock<f64> = RwLock::new(0.0);

/// A model the live table does not price has turned up (a release newer than
/// the cached table), and the last attempt was long enough ago to try again.
pub fn wants_early_refresh() -> bool {
    let since = crate::now_ms() - *LAST_ATTEMPT.read().unwrap();
    since >= EARLY_MIN_GAP.as_millis() as f64 && super::claude_pricing::take_live_miss()
}

pub fn is_fresh() -> bool {
    let s = *STATE.read().unwrap();
    s.live && crate::now_ms() - s.fetched_at < REFRESH.as_millis() as f64
}

pub fn init(user_data: &std::path::Path) {
    let cache_path = user_data.join("anthropic-pricing.json");
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
    *LAST_ATTEMPT.write().unwrap() = crate::now_ms();
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
                eprintln!("Anthropic pricing refresh failed: empty model price table");
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
            eprintln!("Anthropic pricing refresh failed: {err}");
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_anthropic_official_model_price_table_rows() {
        let map = build_map(
            "| Model | Base Input Tokens | 5m Cache Writes | 1h Cache Writes | Cache Hits & Refreshes | Output Tokens |\n\
             | Claude Opus 4.8 | $5 / MTok | $6.25 / MTok | $10 / MTok | $0.50 / MTok | $25 / MTok |\n\
             | Claude Fable 5.1 | $10 / MTok | $12.50 / MTok | $20 / MTok | $0.25 / MTok<sup>1</sup> | $50 / MTok |\n\
             | Claude Mythos 5.1 ([limited availability](x)) | $10 / MTok | $12.50 / MTok | $20 / MTok | $0.25 / MTok<sup>1</sup> | $50 / MTok |\n\
             | Claude Sonnet 5 | $2 / MTok | $2.50 / MTok | $4 / MTok | $0.20 / MTok | $10 / MTok |\n\
             | Claude Sonnet 4 ([retired, except on Bedrock](x)) | $3 / MTok | $3.75 / MTok | $6 / MTok | $0.30 / MTok | $15 / MTok |\n\
             | Claude Sonnet 5 [through August 31, 2026](x) | $2 / MTok | $2.50 / MTok | $4 / MTok | $0.20 / MTok | $10 / MTok |\n\
             | Claude Sonnet 5 starting September 1, 2026 | $3 / MTok | $3.75 / MTok | $6 / MTok | $0.30 / MTok | $15 / MTok |\n\
             | Claude Opus 5.5 | $4 / MTok | $5 / MTok | $8 / MTok | $0.20 / MTok<sup>2</sup> | $20 / MTok |\n\
             | Claude Opus 5 | $5 / MTok | $6.25 / MTok | $10 / MTok | $0.50 / MTok | $25 / MTok |\n\
             ### Fast mode pricing\n\
             | Model | Input | Output |\n\
             | Claude Opus 5.5 | $8 / MTok | $40 / MTok |\n\
             | Claude Opus 5 / Claude Opus 4.8 | $10 / MTok | $50 / MTok |\n\
             ### Batch processing\n\
             | Claude Opus 5.5 | $2 / MTok | $10 / MTok |",
        );
        assert_eq!(map["opus-5-5"].input, 4.0);
        assert_eq!(map["opus-5-5"].cache_read, 0.2);
        assert_eq!(map["opus-5-5"].fast_input, Some(8.0));
        assert_eq!(map["opus-5-5"].fast_output, Some(40.0));
        assert_eq!(map["opus-5"].fast_input, Some(10.0));
        assert_eq!(map["opus-4-8"].fast_output, Some(50.0));
        assert_eq!(map["sonnet-5"].fast_input, None);
        assert_eq!(map["opus-4-8"].output, 25.0);
        assert_eq!(map["fable-5-1"].cache_read, 0.25);
        assert_eq!(map["mythos-5-1"].cache_read, 0.25);
        assert_eq!(map["sonnet-5"].input, 2.0);
        assert_eq!(map["sonnet-4"].input, 3.0);
        assert_eq!(map["sonnet-5@intro"].input, 2.0);
        assert_eq!(map["sonnet-5@standard"].output, 15.0);
    }
}
