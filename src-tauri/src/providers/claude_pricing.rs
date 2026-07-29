//! USD per million tokens. The bundled table mirrors Anthropic's standard API
//! table and is superseded by the daily official-doc refresh when available.

use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{OnceLock, RwLock};

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct RateSet {
    pub input: f64,
    pub cache_w5m: f64,
    pub cache_w1h: f64,
    pub cache_read: f64,
    pub output: f64,
}

struct PriceRule {
    test: &'static str,
    rates: RateSet,
    family: &'static str,
    intro_until: Option<&'static str>,
    intro: Option<RateSet>,
}

const fn rates(input: f64, cache_w5m: f64, cache_w1h: f64, cache_read: f64, output: f64) -> RateSet {
    RateSet { input, cache_w5m, cache_w1h, cache_read, output }
}

const PRICING_RULES: &[PriceRule] = &[
    PriceRule { test: r"(?:fable-5|mythos-5)", rates: rates(10.0, 12.5, 20.0, 1.0, 50.0), family: "fable", intro_until: None, intro: None },
    PriceRule { test: r"(?:opus-5|opus-4-[5-9])", rates: rates(5.0, 6.25, 10.0, 0.5, 25.0), family: "opus", intro_until: None, intro: None },
    PriceRule { test: r"opus", rates: rates(15.0, 18.75, 30.0, 1.5, 75.0), family: "opus", intro_until: None, intro: None },
    PriceRule {
        test: r"sonnet-5",
        rates: rates(3.0, 3.75, 6.0, 0.3, 15.0),
        family: "sonnet",
        intro_until: Some("2026-09-01"),
        intro: Some(rates(2.0, 2.5, 4.0, 0.2, 10.0)),
    },
    PriceRule { test: r"sonnet", rates: rates(3.0, 3.75, 6.0, 0.3, 15.0), family: "sonnet", intro_until: None, intro: None },
    PriceRule { test: r"haiku-4", rates: rates(1.0, 1.25, 2.0, 0.1, 5.0), family: "haiku", intro_until: None, intro: None },
    PriceRule { test: r"(?:3-5-haiku|haiku-3-5)", rates: rates(0.8, 1.0, 1.6, 0.08, 4.0), family: "haiku", intro_until: None, intro: None },
    PriceRule { test: r"haiku", rates: rates(0.25, 0.3, 0.5, 0.03, 1.25), family: "haiku", intro_until: None, intro: None },
];

/// One row of the live official table (also the on-disk cache shape).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LivePrice {
    pub input: f64,
    pub cache_w5m: f64,
    pub cache_w1h: f64,
    pub cache_read: f64,
    pub output: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub family: Option<String>,
}

static LIVE_PRICES: RwLock<Option<HashMap<String, LivePrice>>> = RwLock::new(None);

pub fn set_live_prices(map: HashMap<String, LivePrice>) {
    if !map.is_empty() {
        *LIVE_PRICES.write().unwrap() = Some(map);
    }
}

fn compiled_rules() -> &'static Vec<(Regex, &'static PriceRule)> {
    static RULES: OnceLock<Vec<(Regex, &'static PriceRule)>> = OnceLock::new();
    RULES.get_or_init(|| {
        PRICING_RULES
            .iter()
            .map(|rule| (Regex::new(rule.test).unwrap(), rule))
            .collect()
    })
}

pub fn canonical_model(model: &str) -> String {
    static STRIP_DATE: OnceLock<Regex> = OnceLock::new();
    static LEGACY: OnceLock<Regex> = OnceLock::new();
    static MODERN: OnceLock<Regex> = OnceLock::new();
    let strip_date = STRIP_DATE.get_or_init(|| Regex::new(r"-\d{8}$").unwrap());
    let legacy = LEGACY.get_or_init(|| {
        Regex::new(r"^(\d+)-(\d+)-(fable|mythos|opus|sonnet|haiku)(?:-|$)").unwrap()
    });
    let modern = MODERN.get_or_init(|| {
        Regex::new(r"(fable|mythos|opus|sonnet|haiku)[-.]?(\d+)(?:[-.]?(\d+))?").unwrap()
    });

    let lower = model.to_lowercase();
    let base = lower.strip_prefix("claude-").unwrap_or(&lower);
    let m = strip_date.replace(base, "").into_owned();
    if let Some(hit) = legacy.captures(&m) {
        return format!("{}-{}-{}", &hit[3], &hit[1], &hit[2]);
    }
    match modern.captures(&m) {
        Some(hit) => match hit.get(3) {
            Some(minor) => format!("{}-{}-{}", &hit[1], &hit[2], minor.as_str()),
            None => format!("{}-{}", &hit[1], &hit[2]),
        },
        None => m,
    }
}

fn bundled_rule_for(model: &str) -> Option<&'static PriceRule> {
    compiled_rules()
        .iter()
        .find(|(re, _)| re.is_match(model))
        .map(|(_, rule)| *rule)
}

#[derive(Clone, Debug)]
pub struct ResolvedPrice {
    pub rates: RateSet,
    pub family: String,
    pub source: &'static str,
}

pub fn price_for(model: &str, usage_date: Option<&str>) -> Option<ResolvedPrice> {
    let canonical = canonical_model(model);
    let date = usage_date
        .map(str::to_string)
        .unwrap_or_else(|| chrono::Utc::now().format("%Y-%m-%d").to_string());
    let bundled = bundled_rule_for(&canonical);

    let live_guard = LIVE_PRICES.read().unwrap();
    let live = live_guard.as_ref().and_then(|prices| {
        if canonical == "sonnet-5" {
            let key = if date.as_str() < "2026-09-01" { "sonnet-5@intro" } else { "sonnet-5@standard" };
            prices.get(key)
        } else {
            prices.get(&canonical)
        }
    });

    if let Some(live) = live {
        let family = bundled
            .map(|b| b.family.to_string())
            .or_else(|| live.family.clone())
            .unwrap_or_else(|| "other".to_string());
        return Some(ResolvedPrice {
            rates: rates(live.input, live.cache_w5m, live.cache_w1h, live.cache_read, live.output),
            family,
            source: "Anthropic pricing (live)",
        });
    }
    drop(live_guard);

    let bundled = bundled?;
    let use_intro = matches!(bundled.intro_until, Some(until) if date.as_str() < until);
    Some(ResolvedPrice {
        rates: if use_intro { bundled.intro.unwrap() } else { bundled.rates },
        family: bundled.family.to_string(),
        source: "Anthropic pricing (bundled)",
    })
}

fn supports_us_geo(model: &str) -> bool {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| {
        Regex::new(r"^(?:fable-5|mythos-5|opus-5|opus-4-[6-9]|sonnet-5|sonnet-4-[6-9])$").unwrap()
    });
    re.is_match(&canonical_model(model))
}

fn fast_rates(model: &str) -> Option<(f64, f64)> {
    match canonical_model(model).as_str() {
        "opus-5" | "opus-4-8" => Some((10.0, 50.0)),
        "opus-4-7" => Some((30.0, 150.0)),
        _ => None,
    }
}

#[derive(Clone, Copy, Debug, Default)]
pub struct ClaudeUsage<'a> {
    pub date: Option<&'a str>,
    pub input: f64,
    pub output: f64,
    pub cache_read: f64,
    pub cache_w5m: f64,
    pub cache_w1h: f64,
    pub speed: &'a str,
    pub inference_geo: &'a str,
    pub web_searches: f64,
}

#[derive(Clone, Debug, Default)]
pub struct ClaudeCost {
    pub total: f64,
    pub cost_min: f64,
    pub cost_max: f64,
    pub input: f64,
    pub output: f64,
    pub cache_read: f64,
    pub cache_write: f64,
    pub tool_fee: f64,
    pub cache_savings: f64,
    pub known: bool,
    pub estimated: bool,
    pub fast: bool,
    pub us_region: bool,
    pub source: String,
}

/// Thinking tokens are already included in output.
pub fn cost_of(model: &str, usage: &ClaudeUsage) -> ClaudeCost {
    let Some(resolved) = price_for(model, usage.date) else {
        return ClaudeCost {
            source: "No official price".to_string(),
            ..Default::default()
        };
    };
    let mut p = resolved.rates;

    let speed = usage.speed.to_lowercase();
    let mut fast = false;
    if speed == "fast" {
        if let Some((input, output)) = fast_rates(model) {
            p = rates(input, input * 1.25, input * 2.0, input * 0.1, output);
            fast = true;
        }
        // Opus 4.6 reports fast in some logs but is explicitly billed standard.
    }

    let geo = usage.inference_geo.to_lowercase();
    let geo_multiplier = if geo == "us" && supports_us_geo(model) { 1.1 } else { 1.0 };
    const M: f64 = 1e6;
    let nn = |v: f64| v.max(0.0);
    let input = (nn(usage.input) / M) * p.input * geo_multiplier;
    let output = (nn(usage.output) / M) * p.output * geo_multiplier;
    let cache_read = (nn(usage.cache_read) / M) * p.cache_read * geo_multiplier;
    let cache_write = (nn(usage.cache_w5m) / M) * p.cache_w5m * geo_multiplier
        + (nn(usage.cache_w1h) / M) * p.cache_w1h * geo_multiplier;
    let web_searches = nn(usage.web_searches);
    let tool_fee = web_searches * 0.01; // $10 / 1,000 searches
    let total = input + output + cache_read + cache_write + tool_fee;
    let cache_savings = (nn(usage.cache_read) / M) * (p.input - p.cache_read).max(0.0) * geo_multiplier;
    ClaudeCost {
        total,
        cost_min: total,
        cost_max: total,
        input,
        output,
        cache_read,
        cache_write,
        tool_fee,
        cache_savings,
        known: true,
        estimated: false,
        fast,
        us_region: geo_multiplier > 1.0,
        source: resolved.source.to_string(),
    }
}

pub fn family_of(model: &str) -> String {
    price_for(model, None)
        .map(|p| p.family)
        .unwrap_or_else(|| "other".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn close(actual: f64, expected: f64) {
        assert!((actual - expected).abs() <= 1e-9, "{actual} != {expected}");
    }

    #[test]
    fn canonicalizes_model_ids() {
        assert_eq!(canonical_model("claude-opus-4-8-20250915"), "opus-4-8");
        assert_eq!(canonical_model("claude-3-5-haiku-20241022"), "haiku-3-5");
        assert_eq!(canonical_model("claude-sonnet-5"), "sonnet-5");
        assert_eq!(canonical_model("claude-fable-5"), "fable-5");
        assert_eq!(canonical_model("Claude-Opus-4.8"), "opus-4-8");
    }

    #[test]
    fn prices_claude_introductory_fast_regional_and_server_tool_usage() {
        let intro = cost_of("claude-sonnet-5", &ClaudeUsage {
            date: Some("2026-08-31"), input: 1_000_000.0, output: 1_000_000.0,
            ..Default::default()
        });
        close(intro.total, 12.0);
        let standard = cost_of("claude-sonnet-5", &ClaudeUsage {
            date: Some("2026-09-01"), input: 1_000_000.0, output: 1_000_000.0,
            ..Default::default()
        });
        close(standard.total, 18.0);

        let fast_us = cost_of("claude-opus-4-8", &ClaudeUsage {
            input: 1_000_000.0, output: 1_000_000.0, cache_read: 100_000.0,
            speed: "fast", inference_geo: "us", web_searches: 2.0,
            ..Default::default()
        });
        close(fast_us.total, 66.13);
        assert!(fast_us.fast);
        assert!(fast_us.us_region);
    }

    #[test]
    fn prices_opus_5_exactly_like_opus_4_8() {
        let opus48 = price_for("claude-opus-4-8", None).unwrap();
        let opus5 = price_for("claude-opus-5", None).unwrap();
        assert_eq!(opus5.rates, opus48.rates);

        let usage = ClaudeUsage {
            input: 1_000_000.0, output: 1_000_000.0, cache_read: 100_000.0,
            speed: "fast", inference_geo: "us", web_searches: 2.0,
            ..Default::default()
        };
        let c5 = cost_of("claude-opus-5", &usage);
        let c48 = cost_of("claude-opus-4-8", &usage);
        close(c5.total, c48.total);
        assert!(c5.fast);
        assert!(c5.us_region);
    }

    #[test]
    fn unknown_models_stay_unpriced() {
        let c = cost_of("mistral-large", &ClaudeUsage { input: 1e6, ..Default::default() });
        assert!(!c.known);
        assert_eq!(c.total, 0.0);
        assert_eq!(c.source, "No official price");
    }

    #[test]
    fn fable_and_mythos_share_the_top_tier() {
        let fable = price_for("claude-fable-5", None).unwrap();
        let mythos = price_for("claude-mythos-5-20260101", None).unwrap();
        assert_eq!(fable.rates, mythos.rates);
        assert_eq!(fable.rates.input, 10.0);
        assert_eq!(fable.rates.output, 50.0);
        assert_eq!(fable.family, "fable");
    }
}
