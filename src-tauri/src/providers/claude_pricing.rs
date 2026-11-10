//! USD per million tokens. Resolution order, first hit wins:
//!   1. `pricing-overrides.json` in the app data dir (hand-edited, hot-reloaded)
//!   2. the live official table (refreshed daily, sooner when a model is missing)
//!   3. the bundled table below

use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::collections::HashSet;
use std::sync::{Mutex, OnceLock, RwLock};

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
}

const fn rates(input: f64, cache_w5m: f64, cache_w1h: f64, cache_read: f64, output: f64) -> RateSet {
    RateSet { input, cache_w5m, cache_w1h, cache_read, output }
}

// Order matters: the first matching rule wins, so point releases with their
// own rates (Fable 5.1's cheaper cache reads) sit above the family catch-all.
const PRICING_RULES: &[PriceRule] = &[
    PriceRule { test: r"(?:fable|mythos)-5-2", rates: rates(8.0, 10.0, 16.0, 0.2, 40.0), family: "fable" },
    PriceRule { test: r"(?:fable|mythos)-5-1", rates: rates(10.0, 12.5, 20.0, 0.25, 50.0), family: "fable" },
    PriceRule { test: r"(?:fable|mythos)-5", rates: rates(10.0, 12.5, 20.0, 1.0, 50.0), family: "fable" },
    // Opus 5.5 reads cache at 0.05x input rather than the usual 0.1x.
    PriceRule { test: r"^opus-5-5$", rates: rates(4.0, 5.0, 8.0, 0.2, 20.0), family: "opus" },
    PriceRule { test: r"^(?:opus-5|opus-4-[5-9])$", rates: rates(5.0, 6.25, 10.0, 0.5, 25.0), family: "opus" },
    PriceRule { test: r"opus", rates: rates(15.0, 18.75, 30.0, 1.5, 75.0), family: "opus" },
    // Sonnet 5 launched at $2 / $10 as an introductory rate; the official
    // table now lists that as the standing price.
    // Sonnet 5.5 reads cache at 0.05x input, like Opus 5.5.
    PriceRule { test: r"^sonnet-5-5$", rates: rates(2.0, 2.5, 4.0, 0.1, 10.0), family: "sonnet" },
    PriceRule { test: r"sonnet-5", rates: rates(2.0, 2.5, 4.0, 0.2, 10.0), family: "sonnet" },
    PriceRule { test: r"sonnet", rates: rates(3.0, 3.75, 6.0, 0.3, 15.0), family: "sonnet" },
    // Haiku 5.5's short-prompt rates; see bundled_long_rates for the rest.
    PriceRule { test: r"^haiku-5-5$", rates: rates(0.1, 0.125, 0.2, 0.01, 0.5), family: "haiku" },
    PriceRule { test: r"haiku-4", rates: rates(1.0, 1.25, 2.0, 0.1, 5.0), family: "haiku" },
    PriceRule { test: r"(?:3-5-haiku|haiku-3-5)", rates: rates(0.8, 1.0, 1.6, 0.08, 4.0), family: "haiku" },
    PriceRule { test: r"haiku", rates: rates(0.25, 0.3, 0.5, 0.03, 1.25), family: "haiku" },
];

/// One row of the live official table (also the on-disk cache shape).
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LivePrice {
    pub input: f64,
    pub cache_w5m: f64,
    pub cache_w1h: f64,
    pub cache_read: f64,
    pub output: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub family: Option<String>,
    /// Fast-mode input / output; the cache rates scale with input.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fast_input: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fast_output: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub long_context: Option<LongTier>,
}

/// Rates for a request whose prompt (input plus every cache read and write)
/// is over `threshold` tokens. The whole request pays them, cache hits too.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LongTier {
    pub threshold: f64,
    pub input: f64,
    pub cache_w5m: f64,
    pub cache_w1h: f64,
    pub cache_read: f64,
    pub output: f64,
}

static LIVE_PRICES: RwLock<Option<HashMap<String, LivePrice>>> = RwLock::new(None);
static OVERRIDES: RwLock<Option<HashMap<String, LivePrice>>> = RwLock::new(None);
/// Claude models seen without an exact live row. A new release shows up here
/// first, so the refresh loop fetches the official table early instead of
/// waiting out the day. Each id triggers at most one early fetch; retired
/// models the page no longer lists would otherwise refetch forever.
#[derive(Default)]
struct Misses {
    pending: HashSet<String>,
    checked: HashSet<String>,
}
static MISSES: OnceLock<Mutex<Misses>> = OnceLock::new();

fn misses() -> &'static Mutex<Misses> {
    MISSES.get_or_init(Default::default)
}

pub fn set_live_prices(map: HashMap<String, LivePrice>) {
    if !map.is_empty() {
        *LIVE_PRICES.write().unwrap() = Some(map);
    }
}

/// Keys may be any model id spelling; an empty map clears the overrides.
pub fn set_overrides(map: HashMap<String, LivePrice>) {
    let map = map.into_iter().map(|(k, v)| (canonical_model(&k), v)).collect::<HashMap<_, _>>();
    *OVERRIDES.write().unwrap() = if map.is_empty() { None } else { Some(map) };
}

/// True when a model has gone unpriced by the live table since the last call.
pub fn take_live_miss() -> bool {
    let mut m = misses().lock().unwrap();
    let pending = std::mem::take(&mut m.pending);
    let any = !pending.is_empty();
    m.checked.extend(pending);
    any
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
    pub fast: Option<(f64, f64)>,
    /// (prompt-token threshold, rates above it)
    pub long: Option<(f64, RateSet)>,
}

fn from_row(row: &LivePrice, bundled: Option<&PriceRule>, canonical: &str, source: &'static str) -> ResolvedPrice {
    let family = bundled
        .map(|b| b.family.to_string())
        .or_else(|| row.family.clone())
        .unwrap_or_else(|| "other".to_string());
    let fast = match (row.fast_input, row.fast_output) {
        (Some(i), Some(o)) => Some((i, o)),
        _ => bundled_fast_rates(canonical),
    };
    let long = match row.long_context {
        Some(t) => Some((t.threshold, rates(t.input, t.cache_w5m, t.cache_w1h, t.cache_read, t.output))),
        None => bundled_long_rates(canonical),
    };
    ResolvedPrice {
        rates: rates(row.input, row.cache_w5m, row.cache_w1h, row.cache_read, row.output),
        family,
        source,
        fast,
        long,
    }
}

pub fn price_for(model: &str, usage_date: Option<&str>) -> Option<ResolvedPrice> {
    let canonical = canonical_model(model);
    let _ = usage_date; // every current row is date-independent
    let bundled = bundled_rule_for(&canonical);

    if let Some(row) = OVERRIDES.read().unwrap().as_ref().and_then(|m| m.get(&canonical)) {
        return Some(from_row(row, bundled, &canonical, "Price override (pricing-overrides.json)"));
    }

    let live_guard = LIVE_PRICES.read().unwrap();
    // Only an exact row counts. A dated variant left over from an older table
    // ("sonnet-5@standard") must not outlive the page that published it.
    if let Some(prices) = live_guard.as_ref() {
        if let Some(row) = prices.get(&canonical) {
            return Some(from_row(row, bundled, &canonical, "Anthropic pricing (live)"));
        }
        if claude_family(&canonical) {
            let mut m = misses().lock().unwrap();
            if !m.checked.contains(&canonical) {
                m.pending.insert(canonical.clone());
            }
        }
    }
    drop(live_guard);

    let bundled = bundled?;
    Some(ResolvedPrice {
        rates: bundled.rates,
        family: bundled.family.to_string(),
        source: "Anthropic pricing (bundled)",
        fast: bundled_fast_rates(&canonical),
        long: bundled_long_rates(&canonical),
    })
}

fn claude_family(canonical: &str) -> bool {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^(?:fable|mythos|opus|sonnet|haiku)-\d").unwrap())
        .is_match(canonical)
}

fn supports_us_geo(model: &str) -> bool {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| {
        Regex::new(r"^(?:fable-5(?:-\d+)?|mythos-5(?:-\d+)?|opus-5(?:-\d+)?|opus-4-[6-9]|sonnet-5(?:-\d+)?|sonnet-4-[6-9]|haiku-5(?:-\d+)?)$").unwrap()
    });
    re.is_match(&canonical_model(model))
}

fn bundled_fast_rates(canonical: &str) -> Option<(f64, f64)> {
    match canonical {
        "fable-5-2" | "mythos-5-2" => Some((16.0, 80.0)),
        "opus-5-5" => Some((8.0, 40.0)),
        "opus-5" | "opus-4-8" => Some((10.0, 50.0)),
        // Retired fast modes, kept for the logs written while they ran: six
        // times standard. usage.speed reports the speed actually served, so a
        // call logged as fast was billed as fast.
        "opus-4-7" | "opus-4-6" => Some((30.0, 150.0)),
        _ => None,
    }
}

/// Haiku 5.5 is the one model priced by prompt length; the rest carry the
/// full context window at standard rates.
fn bundled_long_rates(canonical: &str) -> Option<(f64, RateSet)> {
    match canonical {
        "haiku-5-5" => Some((100_000.0, rates(0.5, 0.625, 1.0, 0.05, 2.5))),
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
    /// "batch" halves every token rate; anything else is standard.
    pub service_tier: &'a str,
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
    pub long_context: bool,
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
    let nn = |v: f64| v.max(0.0);

    // Each request is priced on its own prompt length, cache hits included.
    let prompt = nn(usage.input) + nn(usage.cache_read) + nn(usage.cache_w5m) + nn(usage.cache_w1h);
    let mut long_context = false;
    if let Some((threshold, long)) = resolved.long {
        if prompt > threshold {
            p = long;
            long_context = true;
        }
    }

    let speed = usage.speed.to_lowercase();
    let mut fast = false;
    if speed == "fast" {
        if let Some((input, output)) = resolved.fast {
            // Cache multipliers stack on the fast input rate, so they keep
            // each model's own ratios (Opus 5.5 reads at 0.05x, not 0.1x).
            let k = if p.input > 0.0 { input / p.input } else { 1.0 };
            p = rates(input, p.cache_w5m * k, p.cache_w1h * k, p.cache_read * k, output);
            fast = true;
        }
    }

    let geo = usage.inference_geo.to_lowercase();
    let us_region = geo == "us" && supports_us_geo(model);
    // The Batch API bills every token category at half price, and the
    // discount stacks with the caching and data-residency multipliers. Fast
    // mode is not offered with it.
    let batch = !fast && usage.service_tier.eq_ignore_ascii_case("batch");
    let geo_multiplier = if us_region { 1.1 } else { 1.0 } * if batch { 0.5 } else { 1.0 };
    const M: f64 = 1e6;
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
        us_region,
        long_context,
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

    /// Today's official page, row by row, against the table shipped in the
    /// binary — the prices Ember uses before (or without) a live refresh.
    #[test]
    fn bundled_prices_match_every_row_of_the_official_page() {
        let map = super::super::claude_pricing_live::build_map(include_str!("fixtures/anthropic-pricing-2026-11-10.md"));
        assert!(map.len() >= 21, "only {} rows parsed", map.len());
        for (model, live) in &map {
            let rule = bundled_rule_for(model).unwrap_or_else(|| panic!("no bundled price for {model}"));
            assert_eq!(
                rule.rates,
                rates(live.input, live.cache_w5m, live.cache_w1h, live.cache_read, live.output),
                "{model}"
            );
            if let (Some(input), Some(output)) = (live.fast_input, live.fast_output) {
                assert_eq!(bundled_fast_rates(model), Some((input, output)), "{model} fast");
            }
            let long = live.long_context.map(|t| (t.threshold, rates(t.input, t.cache_w5m, t.cache_w1h, t.cache_read, t.output)));
            assert_eq!(bundled_long_rates(model), long, "{model} long-prompt tier");
        }
        for model in ["fable-5-2", "mythos-5-2", "fable-5-1", "fable-5", "opus-5-5", "opus-5", "opus-4-8",
            "opus-4-5", "opus-4-1", "sonnet-5-5", "sonnet-5", "sonnet-4-6", "haiku-5-5", "haiku-4-5"] {
            assert!(map.contains_key(model), "{model} missing from the parsed page");
        }
        // Every fast-mode row on the page, and nothing the page does not list.
        let fast: Vec<&str> = {
            let mut v: Vec<&str> = map.iter().filter(|(_, p)| p.fast_input.is_some()).map(|(k, _)| k.as_str()).collect();
            v.sort();
            v
        };
        assert_eq!(fast, ["fable-5-2", "mythos-5-2", "opus-4-8", "opus-5", "opus-5-5"]);
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
    fn prices_claude_fast_regional_and_server_tool_usage() {
        let sonnet = cost_of("claude-sonnet-5", &ClaudeUsage {
            date: Some("2026-09-02"), input: 1_000_000.0, output: 1_000_000.0,
            ..Default::default()
        });
        close(sonnet.total, 12.0);

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
    fn opus_5_5_has_its_own_row_and_fast_rates() {
        assert_eq!(canonical_model("claude-opus-5-5"), "opus-5-5");
        let p = price_for("claude-opus-5-5", None).unwrap();
        assert_eq!(p.rates, rates(4.0, 5.0, 8.0, 0.2, 20.0));
        assert_eq!(p.family, "opus");
        let c = cost_of("claude-opus-5-5", &ClaudeUsage {
            input: 1_000_000.0, output: 1_000_000.0, cache_read: 1_000_000.0,
            speed: "fast", inference_geo: "us",
            ..Default::default()
        });
        assert!(c.fast);
        assert!(c.us_region);
        close(c.total, (8.0 + 40.0 + 0.4) * 1.1);
    }

    #[test]
    fn sonnet_5_5_reads_cache_at_a_twentieth() {
        assert_eq!(canonical_model("claude-sonnet-5-5"), "sonnet-5-5");
        let p = price_for("claude-sonnet-5-5", None).unwrap();
        assert_eq!(p.rates, rates(2.0, 2.5, 4.0, 0.1, 10.0));
        assert_eq!(p.family, "sonnet");
        assert_eq!(price_for("claude-sonnet-5", None).unwrap().rates.cache_read, 0.2);
    }

    #[test]
    fn haiku_5_5_reprices_the_whole_request_past_100k_prompt_tokens() {
        let p = price_for("claude-haiku-5-5", None).unwrap();
        assert_eq!(p.rates, rates(0.1, 0.125, 0.2, 0.01, 0.5));
        assert_eq!(p.family, "haiku");

        let at = cost_of("claude-haiku-5-5", &ClaudeUsage {
            input: 10_000.0, cache_read: 90_000.0, output: 1_000_000.0,
            ..Default::default()
        });
        assert!(!at.long_context);
        close(at.total, 0.001 + 0.0009 + 0.5);

        // Cache hits count toward the prompt length and pay the higher rate too.
        let over = cost_of("claude-haiku-5-5", &ClaudeUsage {
            input: 10_001.0, cache_read: 90_000.0, output: 1_000_000.0, inference_geo: "us",
            ..Default::default()
        });
        assert!(over.long_context);
        assert!(over.us_region);
        close(over.total, (10_001.0 * 0.5 / 1e6 + 0.0045 + 2.5) * 1.1);
    }

    #[test]
    fn batch_requests_pay_half_on_every_token_category() {
        let usage = ClaudeUsage {
            input: 1_000_000.0, output: 1_000_000.0, cache_read: 1_000_000.0,
            cache_w5m: 1_000_000.0, cache_w1h: 1_000_000.0, web_searches: 3.0,
            ..Default::default()
        };
        let standard = cost_of("claude-opus-5-5", &usage);
        let batch = cost_of("claude-opus-5-5", &ClaudeUsage { service_tier: "batch", ..usage });
        close(standard.total, 4.0 + 20.0 + 0.2 + 5.0 + 8.0 + 0.03);
        // $2 / $10 per the official batch table; searches are not discounted.
        close(batch.total, (4.0 + 20.0 + 0.2 + 5.0 + 8.0) / 2.0 + 0.03);
        close(batch.input, 2.0);
        close(batch.output, 10.0);
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

    #[test]
    fn fable_5_2_cuts_tier_rates_and_adds_fast_mode() {
        assert_eq!(canonical_model("claude-fable-5-2"), "fable-5-2");
        let fable52 = price_for("claude-fable-5-2", None).unwrap();
        let mythos52 = price_for("claude-mythos-5-2", None).unwrap();
        assert_eq!(fable52.rates, mythos52.rates);
        assert_eq!(fable52.rates, rates(8.0, 10.0, 16.0, 0.2, 40.0));
        assert_eq!(fable52.fast, Some((16.0, 80.0)));
        assert_eq!(mythos52.fast, Some((16.0, 80.0)));
        assert_eq!(fable52.family, "fable");
        let c = cost_of("claude-fable-5-2", &ClaudeUsage {
            input: 1_000_000.0, output: 1_000_000.0, cache_read: 1_000_000.0,
            cache_w5m: 1_000_000.0, cache_w1h: 1_000_000.0,
            ..Default::default()
        });
        close(c.total, 74.2);
        close(c.cache_savings, 7.8);

        let fast_us = cost_of("claude-fable-5-2", &ClaudeUsage {
            input: 1_000_000.0, output: 1_000_000.0, cache_read: 1_000_000.0,
            speed: "fast", inference_geo: "us",
            ..Default::default()
        });
        assert!(fast_us.fast);
        assert!(fast_us.us_region);
        close(fast_us.total, (16.0 + 80.0 + 0.4) * 1.1);
    }

    #[test]
    fn fable_5_1_keeps_the_tier_rates_but_reads_cache_at_a_quarter() {
        assert_eq!(canonical_model("claude-fable-5-1"), "fable-5-1");
        let fable51 = price_for("claude-fable-5-1", None).unwrap();
        let mythos51 = price_for("claude-mythos-5-1", None).unwrap();
        assert_eq!(fable51.rates, mythos51.rates);
        assert_eq!(fable51.rates, rates(10.0, 12.5, 20.0, 0.25, 50.0));
        assert_eq!(fable51.family, "fable");
        let c = cost_of("claude-fable-5-1", &ClaudeUsage {
            input: 1_000_000.0, output: 1_000_000.0, cache_read: 1_000_000.0,
            cache_w5m: 1_000_000.0, cache_w1h: 1_000_000.0,
            ..Default::default()
        });
        close(c.total, 92.75);
        close(c.cache_savings, 9.75);
    }

    #[test]
    fn a_live_row_is_only_used_when_it_matches_exactly() {
        set_live_prices(HashMap::from([(
            "sonnet-5@standard".to_string(),
            LivePrice { input: 3.0, cache_w5m: 3.75, cache_w1h: 6.0, cache_read: 0.3, output: 15.0, ..Default::default() },
        )]));
        let p = price_for("claude-sonnet-5", Some("2026-09-02")).unwrap();
        assert_eq!(p.rates.input, 2.0);
        assert_eq!(p.source, "Anthropic pricing (bundled)");
        set_live_prices(HashMap::from([(
            "sonnet-5".to_string(),
            LivePrice { input: 2.0, cache_w5m: 2.5, cache_w1h: 4.0, cache_read: 0.2, output: 10.0, ..Default::default() },
        )]));
        assert_eq!(price_for("claude-sonnet-5", None).unwrap().source, "Anthropic pricing (live)");
    }

    #[test]
    fn an_override_beats_live_and_bundled() {
        set_overrides(HashMap::from([(
            "claude-haiku-4-5".to_string(),
            LivePrice { input: 9.0, cache_w5m: 9.0, cache_w1h: 9.0, cache_read: 9.0, output: 9.0, ..Default::default() },
        )]));
        let p = price_for("claude-haiku-4-5-20251001", None).unwrap();
        assert_eq!(p.rates.input, 9.0);
        assert_eq!(p.family, "haiku");
        set_overrides(HashMap::new());
        assert_eq!(price_for("claude-haiku-4-5", None).unwrap().rates.input, 1.0);
    }
}
