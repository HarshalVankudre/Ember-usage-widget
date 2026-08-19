//! Daily refresh of OpenAI's official published pricing doc.
//! v3 cache records whether a row is priced in context tiers, so the surcharge
//! comes from the official table instead of a bundled assumption.

use super::codex_pricing::{set_live_prices, LivePrice};
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
const CACHE_VERSION: u32 = 3;

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

fn clean_model_name(name: &str) -> String {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r"(?i)\s*\(<272k context length\)\s*").unwrap());
    re.replacen(&name.to_lowercase(), 1, "").trim().to_string()
}

/// The official MDX contains several arrays (standard, batch, flex). Standard
/// appears first, so first occurrence wins. A row is either
/// [model,input,cached,output] or [model,input,cached,cacheWrite,output].
pub fn build_map(markdown: &str) -> HashMap<String, LivePrice> {
    static ROW: OnceLock<Regex> = OnceLock::new();
    static TIER: OnceLock<Regex> = OnceLock::new();
    static ID: OnceLock<Regex> = OnceLock::new();
    let row_re = ROW.get_or_init(|| Regex::new(r#"(\["[^"]+"\s*,[^\]]+\])"#).unwrap());
    let tier_re = TIER.get_or_init(|| Regex::new(r"(?i)<\s*272k context length").unwrap());
    let id_re = ID.get_or_init(|| Regex::new(r"^(?:gpt|chatgpt|chat-|codex|o\d)").unwrap());

    let numeric = |v: Option<&serde_json::Value>| v.and_then(|v| v.as_f64());

    let mut map = HashMap::new();
    for line in markdown.lines() {
        let Some(hit) = row_re.captures(line) else { continue };
        let Ok(row) = serde_json::from_str::<Vec<serde_json::Value>>(&hit[1]) else { continue };
        if row.len() != 4 && row.len() != 5 {
            continue;
        }
        let Some(name) = row[0].as_str() else { continue };
        // OpenAI labels the context-tiered rows "(<272K context length)". That
        // marker is the only statement that a model carries a long-context
        // surcharge, so it is recorded rather than inferred from the family.
        let long_context = tier_re.is_match(name);
        let id = clean_model_name(name);
        if !id_re.is_match(&id) || map.contains_key(&id) {
            continue;
        }
        let input = numeric(row.get(1));
        let cached = numeric(row.get(2));
        let write = if row.len() == 5 { numeric(row.get(3)) } else { None };
        let output = numeric(row.last());
        let (Some(input), Some(output)) = (input, output) else { continue };
        map.insert(id, LivePrice {
            input,
            cached: cached.unwrap_or(input),
            write,
            output,
            long_context: Some(long_context),
        });
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
    fn parses_first_official_openai_standard_price_rows() {
        let map = build_map(
            "    [\"gpt-5.6-sol\", 5, 0.5, 6.25, 30],\n\
                 [\"gpt-5.5 (<272K context length)\", 5, 0.5, \"-\", 30],\n\
                 [\"chatgpt-4o-latest\", 5, \"-\", 15],\n\
                 [\"gpt-5.6-sol\", 2.5, 0.25, 15],",
        );
        let sol = &map["gpt-5.6-sol"];
        assert_eq!((sol.input, sol.cached, sol.write, sol.output), (5.0, 0.5, Some(6.25), 30.0));
        assert_eq!(sol.long_context, Some(false));
        let g55 = &map["gpt-5.5"];
        assert_eq!((g55.input, g55.cached, g55.write, g55.output), (5.0, 0.5, None, 30.0));
        assert_eq!(g55.long_context, Some(true));
        assert_eq!(map["chatgpt-4o-latest"].cached, 5.0);
    }
}
