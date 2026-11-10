//! A published price belongs to one model id, optionally with a dated snapshot
//! suffix. Anything else after the name — "-pro", "-fast", "-spark" — is a
//! different product with its own rate, and OpenAI publishes no row for the
//! Codex-only variants. Matching them loosely would hand a base-model price to
//! a model that never had one, so the suffix is pinned and unlisted variants
//! fall through to Unpriced.

use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{OnceLock, RwLock};

pub const LONG_CONTEXT_THRESHOLD: f64 = 272_000.0;

struct PriceRule {
    /// Pattern body; anchored as ^body(?:-\d{4}-\d{2}-\d{2})?$ unless `raw`.
    pattern: &'static str,
    raw: bool,
    unpriced: bool,
    input: f64,
    cached: f64,
    write: Option<f64>,
    output: f64,
    /// Marks the models OpenAI prices in context tiers — the ones its table
    /// labels "(<272K context length)". Never assumed from a family.
    long_context: bool,
    family: &'static str,
}

const fn rule(pattern: &'static str, input: f64, cached: f64, output: f64, family: &'static str) -> PriceRule {
    PriceRule { pattern, raw: false, unpriced: false, input, cached, write: None, output, long_context: false, family }
}

const fn tiered(pattern: &'static str, input: f64, cached: f64, output: f64, family: &'static str) -> PriceRule {
    PriceRule { pattern, raw: false, unpriced: false, input, cached, write: None, output, long_context: true, family }
}

const fn with_write(pattern: &'static str, input: f64, cached: f64, write: f64, output: f64, family: &'static str) -> PriceRule {
    PriceRule { pattern, raw: false, unpriced: false, input, cached, write: Some(write), output, long_context: false, family }
}

const fn tiered_with_write(pattern: &'static str, input: f64, cached: f64, write: f64, output: f64, family: &'static str) -> PriceRule {
    PriceRule { pattern, raw: false, unpriced: false, input, cached, write: Some(write), output, long_context: true, family }
}

const PRICING_RULES: &[PriceRule] = &[
    PriceRule { pattern: r"^gpt-5\.3-codex-spark(?:-|$)", raw: true, unpriced: true, input: 0.0, cached: 0.0, write: None, output: 0.0, long_context: false, family: "codex" },
    rule(r"chatgpt-4o-latest", 5.0, 5.0, 15.0, "gpt4"),
    rule(r"chat-latest", 5.0, 0.5, 30.0, "gpt5"),

    // `write` is the 30-minute cache write, the default retention. The 12-hour
    // tier is opt-in and Codex logs never say which one a request used.
    tiered_with_write(r"gpt-6-astra", 10.0, 1.0, 12.5, 50.0, "gpt5"),
    tiered_with_write(r"gpt-6\.1-sol", 2.0, 0.1, 2.5, 10.0, "gpt5"),
    tiered_with_write(r"gpt-6\.1-terra", 1.0, 0.05, 1.25, 5.0, "gpt5"),
    tiered_with_write(r"gpt-6-sol", 2.0, 0.2, 2.5, 10.0, "gpt5"),
    tiered_with_write(r"gpt-6-luna", 0.1, 0.01, 0.125, 0.5, "gpt5"),
    // Specialized (trusted-access) models. A row is tiered only when the page
    // prices its long context; "-" there means long context is not offered.
    tiered_with_write(r"gpt-6-cyber", 20.0, 2.0, 25.0, 100.0, "gpt5"),
    tiered_with_write(r"gpt-6-rosalind", 15.0, 1.5, 18.75, 75.0, "gpt5"),
    rule(r"gpt-rosalind-(?:research|discovery)", 5.0, 0.5, 25.0, "gpt5"),
    rule(r"gpt-6-astra-law", 10.0, 1.0, 50.0, "gpt5"),
    rule(r"gpt-5-search-api", 1.25, 0.125, 10.0, "gpt5"),
    with_write(r"gpt-5\.6-cyber", 12.5, 1.25, 15.625, 75.0, "gpt5"),
    tiered_with_write(r"gpt-5\.6-terra", 2.0, 0.2, 2.5, 12.0, "gpt5"),
    tiered_with_write(r"gpt-5\.6-luna", 0.2, 0.02, 0.25, 1.2, "gpt5"),
    // Promotional until November 30, 2026; the live table tracks whatever
    // replaces it.
    tiered_with_write(r"gpt-5\.6(?:-sol)?", 4.0, 0.4, 5.0, 20.0, "gpt5"),
    rule(r"gpt-5\.5-cyber(?:-preview)?", 12.5, 1.25, 75.0, "gpt5"),
    tiered(r"gpt-5\.5-pro", 30.0, 30.0, 180.0, "pro"),
    tiered(r"gpt-5\.5", 5.0, 0.5, 30.0, "gpt5"),
    tiered(r"gpt-5\.4-pro", 30.0, 30.0, 180.0, "pro"),
    rule(r"gpt-5\.4-mini", 0.75, 0.075, 4.5, "mini"),
    rule(r"gpt-5\.4-nano", 0.2, 0.02, 1.25, "nano"),
    tiered(r"gpt-5\.4", 2.5, 0.25, 15.0, "gpt5"),
    rule(r"gpt-5\.2-pro", 21.0, 21.0, 168.0, "pro"),
    rule(r"gpt-5\.2", 1.75, 0.175, 14.0, "gpt5"),
    rule(r"gpt-5(?:\.1)?-pro", 15.0, 15.0, 120.0, "pro"),
    rule(r"gpt-5(?:\.1)?-mini", 0.25, 0.025, 2.0, "mini"),
    rule(r"gpt-5(?:\.1)?-nano", 0.05, 0.005, 0.4, "nano"),
    rule(r"gpt-5(?:\.1)?", 1.25, 0.125, 10.0, "gpt5"),
    rule(r"codex-mini(?:-latest)?", 1.5, 0.375, 6.0, "mini"),
    rule(r"gpt-5\.3-codex", 1.75, 0.175, 14.0, "codex"),

    rule(r"gpt-4\.1-nano", 0.1, 0.025, 0.4, "nano"),
    rule(r"gpt-4\.1-mini", 0.4, 0.1, 1.6, "mini"),
    rule(r"gpt-4\.1", 2.0, 0.5, 8.0, "gpt4"),
    rule(r"gpt-4o-mini", 0.15, 0.075, 0.6, "mini"),
    PriceRule { pattern: r"^gpt-4o-2024-05-13$", raw: true, unpriced: false, input: 5.0, cached: 5.0, write: None, output: 15.0, long_context: false, family: "gpt4" },
    rule(r"gpt-4o", 2.5, 1.25, 10.0, "gpt4"),

    rule(r"o1-pro", 150.0, 150.0, 600.0, "pro"),
    rule(r"o1-mini", 1.1, 0.55, 4.4, "o"),
    rule(r"o1-preview", 15.0, 7.5, 60.0, "o"),
    rule(r"o1", 15.0, 7.5, 60.0, "o"),
    rule(r"o3-pro", 20.0, 20.0, 80.0, "pro"),
    rule(r"o3-mini", 1.1, 0.55, 4.4, "o"),
    rule(r"o3", 2.0, 0.5, 8.0, "o"),
    rule(r"o4-mini", 1.1, 0.275, 4.4, "o"),
];

// Published Fast/Priority rates, USD per million tokens. These are per-model
// prices, not a common multiplier (e.g. GPT-5.5 is 2.5x, GPT-5-mini is 1.8x).
// Verified against https://developers.openai.com/api/docs/pricing on 2026-11-01.
const FAST_PRICING_RULES: &[PriceRule] = &[
    tiered_with_write(r"gpt-6-astra", 20.0, 2.0, 25.0, 100.0, "gpt5"),
    tiered_with_write(r"gpt-6\.1-sol", 4.0, 0.2, 5.0, 20.0, "gpt5"),
    tiered_with_write(r"gpt-6\.1-terra", 2.0, 0.1, 2.5, 10.0, "gpt5"),
    tiered_with_write(r"gpt-6-sol", 4.0, 0.4, 5.0, 20.0, "gpt5"),
    tiered_with_write(r"gpt-6-luna", 0.2, 0.02, 0.25, 1.0, "gpt5"),
    tiered_with_write(r"gpt-5\.6(?:-sol)?", 8.0, 0.8, 10.0, 40.0, "gpt5"),
    tiered_with_write(r"gpt-5\.6-terra", 4.0, 0.4, 5.0, 24.0, "gpt5"),
    tiered_with_write(r"gpt-5\.6-luna", 0.4, 0.04, 0.5, 2.4, "gpt5"),
    // Fast has no published long-context rate for GPT-5.5 or GPT-5.4.
    rule(r"gpt-5\.5", 12.5, 1.25, 75.0, "gpt5"),
    rule(r"gpt-5\.4", 5.0, 0.5, 30.0, "gpt5"),
    rule(r"gpt-5\.4-mini", 1.5, 0.15, 9.0, "mini"),
    rule(r"gpt-5\.3-codex", 3.5, 0.35, 28.0, "codex"),
    rule(r"gpt-5\.2", 3.5, 0.35, 28.0, "gpt5"),
    rule(r"gpt-5(?:\.1)?", 2.5, 0.25, 20.0, "gpt5"),
    rule(r"gpt-5-mini", 0.45, 0.045, 3.6, "mini"),
    rule(r"gpt-4\.1", 3.5, 0.875, 14.0, "gpt4"),
    rule(r"gpt-4\.1-mini", 0.7, 0.175, 2.8, "mini"),
    rule(r"gpt-4\.1-nano", 0.2, 0.05, 0.8, "nano"),
    rule(r"gpt-4o-2024-05-13", 8.75, 8.75, 26.25, "gpt4"),
    rule(r"gpt-4o", 4.25, 2.125, 17.0, "gpt4"),
    rule(r"gpt-4o-mini", 0.25, 0.125, 1.0, "mini"),
    rule(r"o3", 3.5, 0.875, 14.0, "o"),
    rule(r"o4-mini", 2.0, 0.5, 8.0, "o"),
];

/// A price a model carried between two local dates (inclusive; "" = open).
/// The official page only states today's price, so a call is priced by the row
/// in force on the day it was made, ahead of the live and bundled tables.
struct DatedRule {
    pattern: &'static str,
    from: &'static str,
    to: &'static str,
    input: f64,
    cached: f64,
    write: f64,
    output: f64,
}

// GPT-5.6 Luna and Terra launched at $1/$6 and $2.50/$15 and were cut on
// July 30, 2026 (openai.com/index/advancing-the-price-performance-frontier-
// with-gpt-5-6). GPT-5.6 Sol launched at $5/$30 and has been $4/$20 since
// August 21, 2026 (OpenAI's developer-community announcement of that date),
// a promotion that ends when list pricing returns on November 30, 2026.
// Cached input is 0.1x and the 30-minute write 1.25x input throughout.
const DATED_PRICING_RULES: &[DatedRule] = &[
    DatedRule { pattern: r"gpt-5\.6-luna", from: "", to: "2026-07-29", input: 1.0, cached: 0.1, write: 1.25, output: 6.0 },
    DatedRule { pattern: r"gpt-5\.6-terra", from: "", to: "2026-07-29", input: 2.5, cached: 0.25, write: 3.125, output: 15.0 },
    DatedRule { pattern: r"gpt-5\.6(?:-sol)?", from: "", to: "2026-08-20", input: 5.0, cached: 0.5, write: 6.25, output: 30.0 },
    // Pinned so the promotion's own days keep its price once the live table
    // moves on.
    DatedRule { pattern: r"gpt-5\.6(?:-sol)?", from: "2026-08-21", to: "2026-11-29", input: 4.0, cached: 0.4, write: 5.0, output: 20.0 },
];

fn dated_rule_for(model: &str, date: &str) -> Option<&'static DatedRule> {
    static RULES: OnceLock<Vec<(Regex, &DatedRule)>> = OnceLock::new();
    let rules = RULES.get_or_init(|| DATED_PRICING_RULES.iter().map(|r| {
        (Regex::new(&format!(r"^{}(?:-\d{{4}}-\d{{2}}-\d{{2}})?$", r.pattern)).unwrap(), r)
    }).collect());
    // ISO dates order as text.
    rules
        .iter()
        .find(|(re, r)| (r.from.is_empty() || date >= r.from) && (r.to.is_empty() || date <= r.to) && re.is_match(model))
        .map(|(_, r)| *r)
}

// Published Ultrafast rates: two models, each six times its Standard row.
const ULTRAFAST_PRICING_RULES: &[PriceRule] = &[
    tiered_with_write(r"gpt-6-astra", 60.0, 6.0, 75.0, 300.0, "gpt5"),
    tiered_with_write(r"gpt-6\.1-sol", 12.0, 0.6, 15.0, 60.0, "gpt5"),
];

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FastPrice {
    pub input: f64,
    pub cached: f64,
    pub write: Option<f64>,
    pub output: f64,
    pub long_context: bool,
    pub short_context_only: bool,
}

/// One live row from OpenAI's official pricing doc (also the cache shape).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LivePrice {
    pub input: f64,
    pub cached: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub write: Option<f64>,
    pub output: f64,
    #[serde(default)]
    pub long_context: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fast: Option<FastPrice>,
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
            .map(|r| {
                let pattern = if r.raw {
                    r.pattern.to_string()
                } else {
                    format!(r"^{}(?:-\d{{4}}-\d{{2}}-\d{{2}})?$", r.pattern)
                };
                (Regex::new(&pattern).unwrap(), r)
            })
            .collect()
    })
}

fn bundled_rule_for(model: &str) -> Option<&'static PriceRule> {
    compiled_rules()
        .iter()
        .find(|(re, _)| re.is_match(model))
        .map(|(_, r)| *r)
}

#[derive(Clone, Debug)]
pub struct ResolvedPrice {
    pub unpriced: bool,
    pub input: f64,
    pub cached: f64,
    pub write: Option<f64>,
    pub output: f64,
    pub long_context: bool,
    pub short_context_only: bool,
    pub family: String,
    pub source: &'static str,
}

pub fn price_for(model: &str) -> Option<ResolvedPrice> {
    price_for_tier(model, "standard")
}

pub fn price_for_tier(model: &str, service_tier: &str) -> Option<ResolvedPrice> {
    price_on(model, service_tier, None)
}

/// The price in force on `date` (a local YYYY-MM-DD); today's when `None`.
pub fn price_on(model: &str, service_tier: &str, date: Option<&str>) -> Option<ResolvedPrice> {
    let live_guard = LIVE_PRICES.read().unwrap();
    resolve_price_on(model, service_tier, date, live_guard.as_ref())
}

#[cfg(test)]
fn resolve_price(model: &str, service_tier: &str, live_prices: Option<&HashMap<String, LivePrice>>) -> Option<ResolvedPrice> {
    resolve_price_on(model, service_tier, None, live_prices)
}

fn resolve_price_on(model: &str, service_tier: &str, date: Option<&str>, live_prices: Option<&HashMap<String, LivePrice>>) -> Option<ResolvedPrice> {
    let fast = match service_tier.trim().to_ascii_lowercase().as_str() {
        "fast" | "priority" => true,
        "" | "standard" | "default" | "auto" => false,
        // Flex and Batch are published as exactly half of every Standard rate
        // (input, cached input, cache writes and output, both context tiers).
        "flex" | "batch" => {
            let mut p = resolve_price_on(model, "standard", date, live_prices)?;
            if !p.unpriced {
                p.input *= 0.5;
                p.cached *= 0.5;
                p.write = p.write.map(|w| w * 0.5);
                p.output *= 0.5;
                p.source = "OpenAI Flex/Batch pricing (half of Standard)";
            }
            return Some(p);
        }
        "ultrafast" => {
            static RULES: OnceLock<Vec<(Regex, &PriceRule)>> = OnceLock::new();
            let rules = RULES.get_or_init(|| ULTRAFAST_PRICING_RULES.iter().map(|r| {
                (Regex::new(&format!(r"^{}(?:-\d{{4}}-\d{{2}}-\d{{2}})?$", r.pattern)).unwrap(), r)
            }).collect());
            let r = rules.iter().find(|(re, _)| re.is_match(&model.to_lowercase()))?.1;
            return Some(ResolvedPrice {
                unpriced: false,
                input: r.input, cached: r.cached, write: r.write, output: r.output,
                long_context: r.long_context, short_context_only: false,
                family: r.family.to_string(), source: "OpenAI Ultrafast pricing (bundled)",
            });
        }
        _ => return None,
    };
    let m = model.to_lowercase();
    let bundled = bundled_rule_for(&m);

    if let Some(dated) = date.and_then(|d| dated_rule_for(&m, d)) {
        // Fast has been twice Standard on these models since it replaced
        // Priority processing on July 30, 2026, and the Sol promotion kept
        // that ratio.
        let k = if fast { 2.0 } else { 1.0 };
        return Some(ResolvedPrice {
            unpriced: false,
            input: dated.input * k,
            cached: dated.cached * k,
            write: Some(dated.write * k),
            output: dated.output * k,
            long_context: true,
            short_context_only: false,
            family: bundled.map(|b| b.family).unwrap_or("gpt5").to_string(),
            source: "OpenAI pricing (rate on the day of use)",
        });
    }

    static DATE_SUFFIX: OnceLock<Regex> = OnceLock::new();
    let date_suffix = DATE_SUFFIX.get_or_init(|| Regex::new(r"-\d{4}-\d{2}-\d{2}$").unwrap());
    let live = live_prices.and_then(|prices| {
        prices
            .get(&m)
            .or_else(|| prices.get(date_suffix.replace(&m, "").as_ref()))
    });

    if let Some(live) = live {
        if fast {
            if let Some(rates) = &live.fast {
                return Some(ResolvedPrice {
                    unpriced: false,
                    input: rates.input, cached: rates.cached, write: rates.write,
                    output: rates.output, long_context: rates.long_context,
                    short_context_only: rates.short_context_only,
                    family: bundled.map(|b| b.family).unwrap_or("other").to_string(),
                    source: "OpenAI Fast pricing (live)",
                });
            }
            // A refreshed official table is authoritative about availability.
            return None;
        }
        let family = bundled
            .map(|b| b.family.to_string())
            .unwrap_or_else(|| "other".to_string());
        // The official table decides whether a model is tiered by context. The
        // bundled guess only stands in when the table has not been read yet.
        let long_context = live
            .long_context
            .unwrap_or_else(|| bundled.map(|b| b.long_context).unwrap_or(false));
        return Some(ResolvedPrice {
            unpriced: false,
            input: live.input,
            cached: live.cached,
            write: live.write,
            output: live.output,
            long_context,
            short_context_only: false,
            family,
            source: "OpenAI pricing (live)",
        });
    }
    if fast {
        static FAST_RULES: OnceLock<Vec<(Regex, &PriceRule)>> = OnceLock::new();
        let rules = FAST_RULES.get_or_init(|| FAST_PRICING_RULES.iter().map(|r| {
            (Regex::new(&format!(r"^{}(?:-\d{{4}}-\d{{2}}-\d{{2}})?$", r.pattern)).unwrap(), r)
        }).collect());
        let r = rules.iter().find(|(re, _)| re.is_match(&m))?.1;
        return Some(ResolvedPrice {
            unpriced: false,
            input: r.input, cached: r.cached, write: r.write, output: r.output,
            long_context: r.long_context,
            short_context_only: bundled.is_some_and(|b| b.long_context) && !r.long_context,
            family: r.family.to_string(), source: "OpenAI Fast pricing (bundled)",
        });
    }
    let bundled = bundled?;
    Some(ResolvedPrice {
        unpriced: bundled.unpriced,
        input: bundled.input,
        cached: bundled.cached,
        write: bundled.write,
        output: bundled.output,
        long_context: bundled.long_context,
        short_context_only: false,
        family: bundled.family.to_string(),
        source: "OpenAI pricing (bundled)",
    })
}

#[derive(Clone, Copy, Debug, Default)]
pub struct CodexUsage<'a> {
    pub input: f64,
    pub output: f64,
    pub cached: f64,
    pub reasoning: f64,
    pub cache_write: f64,
    pub cache_write_known: bool,
    /// 0 means "derive from the parts", matching the JS `Number(...) ||` chain.
    pub total_input: f64,
    /// The recorded request tier; empty means legacy logs with standard pricing.
    pub service_tier: &'a str,
    /// Local date of the call, so it is priced at the rate in force that day.
    pub date: Option<&'a str>,
}

#[derive(Clone, Debug, Default)]
pub struct CodexCost {
    pub total: f64,
    pub cost_min: f64,
    pub cost_max: f64,
    pub input: f64,
    pub output: f64,
    pub cached: f64,
    pub reasoning: f64,
    pub cache_write: f64,
    pub cache_savings: f64,
    pub known: bool,
    pub estimated: bool,
    pub long_context: bool,
    pub source: String,
}

/// Unified OpenAI usage semantics:
/// input = ordinary, non-cached input; cached = cache reads; cache_write =
/// measured cache-write tokens when available. Current Codex token_count logs
/// omit writes, so those calls carry a transparent min/max range and use the
/// conservative upper estimate (all new input was written to cache).
pub fn cost_of(model: &str, usage: &CodexUsage) -> CodexCost {
    let p = match price_on(model, usage.service_tier, usage.date) {
        None => return CodexCost { source: "No official price".to_string(), ..Default::default() },
        Some(p) if p.unpriced => return CodexCost { source: p.source.to_string(), ..Default::default() },
        Some(p) => p,
    };

    const M: f64 = 1e6;
    let input_tokens = usage.input.max(0.0);
    let output_tokens = usage.output.max(0.0);
    let cached_tokens = usage.cached.max(0.0);
    let write_tokens = usage.cache_write.max(0.0);
    let write_known = usage.cache_write_known;
    let total_input = if usage.total_input > 0.0 {
        usage.total_input
    } else {
        input_tokens + cached_tokens + write_tokens
    };
    if p.short_context_only && total_input > LONG_CONTEXT_THRESHOLD {
        return CodexCost { source: "No official Fast long-context price".to_string(), ..Default::default() };
    }

    // OpenAI applies this per request to the whole request, not only the slice
    // beyond the threshold. Current Codex contexts are capped below the tier;
    // historical logs can still contain pre-cap requests above it.
    let long_context = p.long_context && total_input > LONG_CONTEXT_THRESHOLD;
    let input_multiplier = if long_context { 2.0 } else { 1.0 };
    let output_multiplier = if long_context { 1.5 } else { 1.0 };
    let input_rate = p.input * input_multiplier;
    let cached_rate = p.cached * input_multiplier;
    let write_rate = p.write.unwrap_or(p.input) * input_multiplier;
    let output_rate = p.output * output_multiplier;

    let input = (input_tokens / M) * input_rate;
    let output = (output_tokens / M) * output_rate;
    let cached = (cached_tokens / M) * cached_rate;
    let reasoning = (usage.reasoning.max(0.0) / M) * output_rate;
    let measured_write = (write_tokens / M) * write_rate;
    let base = input + output + cached + measured_write;

    let mut cache_write = measured_write;
    let cost_min = base;
    let mut cost_max = base;
    let mut estimated = false;
    if p.write.is_some() && !write_known {
        // Input already carries the normal input charge; only add the uncertain
        // premium required to bring a possible write up to the write rate.
        let possible_premium = (input_tokens / M) * (write_rate - input_rate).max(0.0);
        cache_write = possible_premium;
        cost_max += possible_premium;
        estimated = possible_premium > 0.0;
    }

    let total = cost_max;
    let cache_savings = (cached_tokens / M) * (input_rate - cached_rate).max(0.0);
    CodexCost {
        total,
        cost_min,
        cost_max,
        input,
        output,
        cached,
        reasoning,
        cache_write,
        cache_savings,
        known: true,
        estimated,
        long_context,
        source: p.source.to_string(),
    }
}

pub fn family_of(model: &str) -> String {
    price_for(model)
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
    fn bundled_fast_prices_match_every_published_fast_row() {
        let map = super::super::codex_pricing_live::build_map(include_str!("fixtures/openai-pricing-2026-11-01.md"));
        for (model, live) in &map {
            let Some(fast) = &live.fast else { continue };
            for tier in ["fast", "priority"] {
                for id in [model.clone(), format!("{model}-2026-11-01")] {
                    let p = resolve_price(&id, tier, None).unwrap_or_else(|| panic!("Missing {tier} price for {id}"));
                    assert_eq!((p.input, p.cached, p.write, p.output), (fast.input, fast.cached, fast.write, fast.output), "{id}");
                    assert_eq!(p.long_context, fast.long_context, "{id}");
                    assert_eq!(p.short_context_only, fast.short_context_only, "{id}");
                }
            }
        }
    }

    /// Today's official page, row by row, against the table shipped in the
    /// binary — the prices Ember uses before (or without) a live refresh.
    #[test]
    fn bundled_prices_match_every_row_of_the_official_page() {
        let map = super::super::codex_pricing_live::build_map(include_str!("fixtures/openai-pricing-2026-11-10.md"));
        assert!(map.len() >= 35, "only {} rows parsed", map.len());
        for (model, live) in &map {
            let p = resolve_price(model, "standard", None).unwrap_or_else(|| panic!("no bundled price for {model}"));
            assert_eq!((p.input, p.cached, p.write, p.output), (live.input, live.cached, live.write, live.output), "{model}");
            assert_eq!(Some(p.long_context), live.long_context, "{model} context tier");
            if let Some(fast) = &live.fast {
                let f = resolve_price(model, "priority", None).unwrap_or_else(|| panic!("no bundled Fast price for {model}"));
                assert_eq!((f.input, f.cached, f.write, f.output), (fast.input, fast.cached, fast.write, fast.output), "{model} fast");
                assert_eq!((f.long_context, f.short_context_only), (fast.long_context, fast.short_context_only), "{model} fast tier");
            }
        }
        for model in ["gpt-6-astra", "gpt-6.1-sol", "gpt-6.1-terra", "gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol",
            "gpt-6-cyber", "gpt-6-rosalind", "gpt-5.5-cyber-preview", "gpt-6-astra-law", "gpt-5.3-codex"] {
            assert!(map.contains_key(model), "{model} missing from the parsed page");
        }
        // Long context is priced for gpt-6-cyber and not offered for gpt-5.6-cyber.
        assert_eq!(map["gpt-6-cyber"].long_context, Some(true));
        assert_eq!(map["gpt-5.6-cyber"].long_context, Some(false));
    }

    #[test]
    fn a_call_is_priced_at_the_rate_in_force_on_its_day() {
        let on = |model: &str, tier: &str, date: &str| {
            let p = resolve_price_on(model, tier, Some(date), None).unwrap();
            (p.input, p.cached, p.write, p.output)
        };
        // Sol: $5/$30 at launch, $4/$20 from August 21, 2026.
        assert_eq!(on("gpt-5.6-sol", "standard", "2026-08-20"), (5.0, 0.5, Some(6.25), 30.0));
        assert_eq!(on("gpt-5.6-sol", "standard", "2026-08-21"), (4.0, 0.4, Some(5.0), 20.0));
        assert_eq!(on("gpt-5.6-sol", "priority", "2026-08-10"), (10.0, 1.0, Some(12.5), 60.0));
        assert_eq!(on("gpt-5.6-sol", "flex", "2026-08-10"), (2.5, 0.25, Some(3.125), 15.0));
        // Luna and Terra: cut on July 30, 2026.
        assert_eq!(on("gpt-5.6-luna", "standard", "2026-07-29"), (1.0, 0.1, Some(1.25), 6.0));
        assert_eq!(on("gpt-5.6-luna", "standard", "2026-07-30"), (0.2, 0.02, Some(0.25), 1.2));
        assert_eq!(on("gpt-5.6-terra", "standard", "2026-07-29"), (2.5, 0.25, Some(3.125), 15.0));
        assert_eq!(on("gpt-5.6-terra", "standard", "2026-07-30"), (2.0, 0.2, Some(2.5), 12.0));
        // Models whose price never moved are unaffected by the date.
        assert_eq!(on("gpt-6-astra", "standard", "2026-08-01"), (10.0, 1.0, Some(12.5), 50.0));

        // The promotion's days keep the promotional price after the live
        // table has gone back to list.
        let mut live = super::super::codex_pricing_live::build_map(include_str!("fixtures/openai-pricing-2026-11-10.md"));
        let sol = live.get_mut("gpt-5.6-sol").unwrap();
        (sol.input, sol.cached, sol.write, sol.output) = (5.0, 0.5, Some(6.25), 30.0);
        assert_eq!(resolve_price_on("gpt-5.6-sol", "standard", Some("2026-11-10"), Some(&live)).unwrap().input, 4.0);
        assert_eq!(resolve_price_on("gpt-5.6-sol", "standard", Some("2026-12-01"), Some(&live)).unwrap().input, 5.0);

        // Long context still reprices the whole request: 2x input, 1.5x output.
        let c = cost_of("gpt-5.6-sol", &CodexUsage {
            input: 300_000.0, output: 10_000.0, cache_write: 1.0, cache_write_known: true,
            total_input: 300_001.0, date: Some("2026-08-01"), ..Default::default()
        });
        close(c.total, 300_000.0 * 10.0 / 1e6 + 10_000.0 * 45.0 / 1e6 + 12.5 / 1e6);
        assert!(c.long_context);
    }

    #[test]
    fn flex_batch_and_ultrafast_use_their_published_rates() {
        // Flex/Batch rows on the official page: half of Standard throughout.
        for tier in ["flex", "batch"] {
            let p = resolve_price("gpt-6-astra", tier, None).unwrap();
            assert_eq!((p.input, p.cached, p.write, p.output), (5.0, 0.5, Some(6.25), 25.0));
            assert!(p.long_context);
            let sol = resolve_price("gpt-6.1-sol", tier, None).unwrap();
            assert_eq!((sol.input, sol.cached, sol.write, sol.output), (1.0, 0.05, Some(1.25), 5.0));
        }
        let ultra = resolve_price("gpt-6-astra", "ultrafast", None).unwrap();
        assert_eq!((ultra.input, ultra.cached, ultra.write, ultra.output), (60.0, 6.0, Some(75.0), 300.0));
        let ultra = resolve_price("gpt-6.1-sol", "ultrafast", None).unwrap();
        assert_eq!((ultra.input, ultra.cached, ultra.write, ultra.output), (12.0, 0.6, Some(15.0), 60.0));
        assert!(resolve_price("gpt-6-luna", "ultrafast", None).is_none());
        assert!(!cost_of("gpt-5.3-codex-spark", &CodexUsage { input: 1.0, service_tier: "flex", ..Default::default() }).known);
        // Long context on Flex: $10 in / $37.50 out for gpt-6-astra.
        let long = cost_of("gpt-6-astra", &CodexUsage {
            input: 300_000.0, output: 10_000.0, cache_write: 1.0, cache_write_known: true,
            total_input: 300_001.0, service_tier: "flex", ..Default::default()
        });
        close(long.total, 300_000.0 * 10.0 / 1e6 + 10_000.0 * 37.5 / 1e6 + 12.5 / 1e6);
    }

    #[test]
    fn fast_costs_include_cached_input_writes_and_long_context() {
        let usage = CodexUsage {
            input: 100_000.0, cached: 200_000.0, output: 10_000.0,
            reasoning: 5_000.0, service_tier: "fast", ..Default::default()
        };
        let c = cost_of("gpt-6.1-sol", &usage);
        // Long input $8/M, read $0.4/M, output $30/M; unknown writes
        // add at most $2/M on new input. Reasoning is already inside output.
        close(c.cost_min, 1.18);
        close(c.cost_max, 1.38);
        close(c.reasoning, 0.15);
        close(c.cache_savings, 1.52);
        assert!(c.known && c.estimated && c.long_context);
        let measured = cost_of("gpt-6.1-sol", &CodexUsage {
            input: 80_000.0, cache_write: 20_000.0, cache_write_known: true,
            service_tier: "priority", ..Default::default()
        });
        close(measured.total, 0.42);
        assert!(!measured.estimated);
    }

    #[test]
    fn fast_is_selected_per_call_and_unsupported_fast_stays_unpriced() {
        let usage = CodexUsage { input: 100_000.0, cache_write_known: true, ..Default::default() };
        close(cost_of("gpt-5.5", &usage).total, 0.5);
        close(cost_of("gpt-5.5", &CodexUsage { service_tier: "priority", ..usage }).total, 1.25);
        close(cost_of("gpt-5.5", &CodexUsage { service_tier: "default", ..usage }).total, 0.5);
        for model in ["gpt-5.5-pro", "gpt-5-nano", "gpt-5.6-sol-fast", "gpt-5.3-codex-spark"] {
            assert!(!cost_of(model, &CodexUsage { service_tier: "fast", ..usage }).known, "{model}");
        }
        assert!(!cost_of("gpt-5.5", &CodexUsage { input: 272_001.0, service_tier: "fast", ..usage }).known);
        assert!(cost_of("gpt-5.5", &CodexUsage { input: 272_000.0, service_tier: "fast", ..usage }).known);
    }

    #[test]
    fn live_fast_rates_override_bundled_rates_without_changing_standard() {
        let mut map = super::super::codex_pricing_live::build_map(include_str!("fixtures/openai-pricing-2026-11-01.md"));
        map.get_mut("gpt-6.1-sol").unwrap().fast.as_mut().unwrap().input = 4.25;
        let live = resolve_price("gpt-6.1-sol-2026-11-01", "priority", Some(&map)).unwrap();
        close(live.input, 4.25);
        assert_eq!(live.source, "OpenAI Fast pricing (live)");
        close(resolve_price("gpt-6.1-sol", "default", Some(&map)).unwrap().input, 2.0);
        map.get_mut("gpt-6.1-sol").unwrap().fast = None;
        assert!(resolve_price("gpt-6.1-sol", "fast", Some(&map)).is_none());
        // Offline cache round trips preserve the tier and availability flags.
        let round_trip: HashMap<String, LivePrice> = serde_json::from_str(&serde_json::to_string(&map).unwrap()).unwrap();
        assert!(round_trip["gpt-5.5"].fast.as_ref().unwrap().short_context_only);
    }

    #[test]
    fn uses_specific_openai_rates_before_broad_family_matches() {
        assert_eq!(price_for("gpt-5.6-terra").unwrap().input, 2.0);
        assert_eq!(price_for("gpt-5.6-luna").unwrap().output, 1.2);
        assert_eq!(price_for("gpt-5.6-cyber").unwrap().input, 12.5);
        assert_eq!(price_for("gpt-6-sol").unwrap().cached, 0.2);
        assert_eq!(price_for("gpt-6.1-sol").unwrap().cached, 0.1);
        assert_eq!(price_for("chatgpt-4o-latest").unwrap().input, 5.0);
        assert_eq!(price_for("gpt-4.1-nano").unwrap().input, 0.1);
    }

    #[test]
    fn does_not_invent_a_public_api_price_for_codex_spark() {
        let c = cost_of("gpt-5.3-codex-spark", &CodexUsage { input: 1_000.0, output: 100.0, ..Default::default() });
        assert!(!c.known);
        assert_eq!(c.total, 0.0);
    }

    #[test]
    fn applies_long_context_surcharge_only_to_tiered_models() {
        let at_cap = cost_of("gpt-5.4", &CodexUsage {
            input: 272_000.0, output: 10_000.0, cache_write_known: true, total_input: 272_000.0,
            ..Default::default()
        });
        close(at_cap.total, 0.83);
        assert!(!at_cap.long_context);

        let above = cost_of("gpt-5.4", &CodexUsage {
            input: 272_001.0, output: 10_000.0, cache_write_known: true, total_input: 272_001.0,
            ..Default::default()
        });
        close(above.total, 1.585005);
        assert!(above.long_context);
    }

    #[test]
    fn flat_priced_models_stay_flat_however_large_the_request() {
        let huge = cost_of("gpt-5.6-cyber", &CodexUsage {
            input: 272_001.0, output: 10_000.0, cache_write_known: true, total_input: 272_001.0,
            ..Default::default()
        });
        close(huge.total, 4.1500125);
        assert!(!huge.long_context);
    }

    #[test]
    fn codex_only_variants_stay_unpriced_but_dated_snapshots_price() {
        for model in ["gpt-5.6-sol-pro", "gpt-5.6-sol-fast", "gpt-5.6-terra-fast", "gpt-5.4-mini-fast"] {
            let c = cost_of(model, &CodexUsage { input: 1_000_000.0, output: 100_000.0, ..Default::default() });
            assert!(!c.known, "{model} should have no official price");
            assert_eq!(c.total, 0.0);
        }
        assert_eq!(price_for("gpt-5.6-sol-2026-01-15").unwrap().input, 4.0);
        assert_eq!(price_for("gpt-4o-mini-2024-07-18").unwrap().input, 0.15);
    }

    #[test]
    fn missing_openai_cache_writes_become_an_explicit_bounded_estimate() {
        let unknown = cost_of("gpt-5.6-sol", &CodexUsage { input: 100_000.0, ..Default::default() });
        close(unknown.cost_min, 0.4);
        close(unknown.cost_max, 0.5);
        close(unknown.total, 0.5);
        assert!(unknown.estimated);

        let measured = cost_of("gpt-5.6-sol", &CodexUsage {
            input: 80_000.0, cache_write: 20_000.0, cache_write_known: true,
            ..Default::default()
        });
        close(measured.total, 0.42);
        assert!(!measured.estimated);
    }

    #[test]
    fn gpt_6_1_sol_is_tiered_with_a_cheap_cache_read() {
        let p = price_for("gpt-6.1-sol").unwrap();
        assert_eq!((p.input, p.cached, p.write, p.output, p.long_context), (2.0, 0.1, Some(2.5), 10.0, true));
        let long = cost_of("gpt-6.1-sol", &CodexUsage {
            input: 272_001.0, output: 10_000.0, cache_write_known: true, total_input: 272_001.0,
            ..Default::default()
        });
        close(long.total, 272_001.0 * 4.0 / 1e6 + 10_000.0 * 15.0 / 1e6);
        assert!(long.long_context);
    }

    #[test]
    fn gpt_6_astra_carries_both_a_cache_write_rate_and_a_context_tier() {
        let p = price_for("gpt-6-astra").unwrap();
        assert_eq!((p.input, p.cached, p.write, p.output), (10.0, 1.0, Some(12.5), 50.0));

        let short = cost_of("gpt-6-astra", &CodexUsage {
            input: 100_000.0, output: 10_000.0, cache_write: 20_000.0, cache_write_known: true,
            ..Default::default()
        });
        close(short.total, 1.75);
        assert!(!short.long_context);

        // Past 272K the whole request reprices: 2x input, 1.5x output.
        let long = cost_of("gpt-6-astra", &CodexUsage {
            input: 272_001.0, output: 10_000.0, cache_write_known: true, total_input: 272_001.0,
            ..Default::default()
        });
        close(long.total, 6.19002);
        assert!(long.long_context);
    }
}
