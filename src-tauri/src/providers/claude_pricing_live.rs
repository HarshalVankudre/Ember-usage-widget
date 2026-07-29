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
const CACHE_VERSION: u32 = 1;

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
    let row_re = ROW.get_or_init(|| Regex::new(r"(?i)^\|\s*Claude\s+").unwrap());
    let name_re = NAME.get_or_init(|| {
        Regex::new(r"(?i)Claude\s+(Fable|Mythos|Opus|Sonnet|Haiku)\s+(\d+(?:\.\d+)?)").unwrap()
    });
    let standard_re = STANDARD.get_or_init(|| Regex::new(r"(?i)starting september").unwrap());

    let mut map = HashMap::new();
    for line in markdown.lines() {
        if !row_re.is_match(line) {
            continue;
        }
        let parts: Vec<&str> = line.split('|').collect();
        if parts.len() < 2 {
            continue;
        }
        let cells: Vec<&str> = parts[1..parts.len() - 1].iter().map(|c| c.trim()).collect();
        if cells.len() != 6 {
            continue;
        }
        let Some(hit) = name_re.captures(cells[0]) else { continue };
        let family = hit[1].to_lowercase();
        let version = hit[2].replacen('.', "-", 1);
        let mut key = format!("{family}-{version}");
        if key == "sonnet-5" {
            key.push_str(if standard_re.is_match(cells[0]) { "@standard" } else { "@intro" });
        }
        if map.contains_key(&key) {
            continue;
        }
        let vals: Vec<Option<f64>> = cells[1..6].iter().map(|c| dollars(c)).collect();
        let [Some(input), Some(cache_w5m), Some(cache_w1h), Some(cache_read), Some(output)] = vals[..] else {
            continue;
        };
        map.insert(key, LivePrice { input, cache_w5m, cache_w1h, cache_read, output, family: Some(family) });
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
                    let _ = std::fs::write(path, body);
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
             | Claude Sonnet 5 [through August 31, 2026](x) | $2 / MTok | $2.50 / MTok | $4 / MTok | $0.20 / MTok | $10 / MTok |\n\
             | Claude Sonnet 5 starting September 1, 2026 | $3 / MTok | $3.75 / MTok | $6 / MTok | $0.30 / MTok | $15 / MTok |",
        );
        assert_eq!(map["opus-4-8"].output, 25.0);
        assert_eq!(map["sonnet-5@intro"].input, 2.0);
        assert_eq!(map["sonnet-5@standard"].output, 15.0);
    }
}
