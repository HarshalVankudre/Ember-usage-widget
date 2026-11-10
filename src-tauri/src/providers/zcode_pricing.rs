//! Rates for the models Ember tracks from zcode.
//!
//! zcode reaches GLM through a Z.ai coding plan (a subscription, so no
//! per-token invoice) and through OpenRouter (metered). Both are priced here
//! against the OpenRouter catalog so the two providers stay comparable and the
//! coding-plan rows carry the same "API-equivalent cost" meaning the rest of
//! Ember uses. Rates are a dated snapshot of
//! https://openrouter.ai/api/v1/models; anything absent stays unpriced rather
//! than guessed.

pub const RATES_AS_OF: &str = "2026-08-31";
pub const SOURCE: &str = "openrouter-catalog";

const M: f64 = 1_000_000.0;

/// (canonical id, input, output, cache read) — US dollars per million tokens.
const RATES: &[(&str, f64, f64, f64)] = &[
    ("z-ai/glm-5.3-flash", 0.075, 0.25, 0.015),
    ("z-ai/glm-5.3", 1.40, 4.40, 0.26),
    ("z-ai/glm-5.2", 1.19, 3.74, 0.221),
    ("z-ai/glm-5.1", 0.966, 3.036, 0.1794),
    ("z-ai/glm-5-turbo", 1.20, 4.00, 0.24),
    ("z-ai/glm-5", 0.60, 1.92, 0.12),
    ("z-ai/glm-4.7-flash", 0.06, 0.40, 0.01),
    ("z-ai/glm-4.7", 0.40, 1.75, 0.08),
    ("z-ai/glm-4.6", 0.43, 1.75, 0.08),
    ("z-ai/glm-4.5-air", 0.13, 0.85, 0.025),
    ("z-ai/glm-4.5", 0.60, 2.20, 0.11),
    ("moonshotai/kimi-k3", 3.00, 15.00, 0.30),
    ("qwen/qwen3.8-flash", 0.15, 0.47, 0.016),
    ("qwen/qwen3.8-27b", 0.425, 2.55, 0.085),
    ("qwen/qwen3.8-max-0902", 2.00, 6.00, 0.25),
];

/// Reduce a zcode `model_id` to the catalog id it should be priced against.
///
/// The coding plan reports bare marketing names (`GLM-5.3-Flash`); OpenRouter
/// reports slugs with optional routing suffixes (`z-ai/glm-5.3-flash:makora`).
/// A suffix only picks which upstream serves the request, never the model, so
/// it is dropped before lookup.
pub fn canonical_id(model_id: &str) -> String {
    let base = model_id.split(':').next().unwrap_or(model_id).trim().to_lowercase();
    if base.is_empty() {
        return String::new();
    }
    if base.contains('/') {
        // `zai-org/GLM-5.3-Flash` and `z-ai/glm-5.3-flash` are the same model
        // under two vendor spellings.
        let (vendor, name) = base.split_once('/').unwrap_or(("", &base));
        let vendor = match vendor {
            "zai-org" | "zhipu" | "zhipuai" => "z-ai",
            other => other,
        };
        return format!("{vendor}/{name}");
    }
    // Bare coding-plan names are always GLM.
    format!("z-ai/{base}")
}

#[derive(Clone, Copy, Debug, Default)]
pub struct ZcodeUsage {
    /// Input excluding the cached portion.
    pub input: f64,
    pub output: f64,
    pub cache_read: f64,
    pub cache_write: f64,
}

#[derive(Clone, Debug, Default)]
pub struct ZcodeCost {
    pub total: f64,
    pub input: f64,
    pub output: f64,
    pub cache_read: f64,
    pub cache_write: f64,
    /// Reasoning's share of the output cost — informational, already in `total`.
    pub reasoning: f64,
    pub cache_savings: f64,
    pub known: bool,
    pub source: String,
}

fn rate_for(model_id: &str) -> Option<(f64, f64, f64)> {
    let id = canonical_id(model_id);
    if id.is_empty() {
        return None;
    }
    // Exact ids only. A longer id is a different product with its own price
    // (kimi-k3.1-pro is not kimi-k3, qwen3.8-max-prime is not qwen3.8-max), so
    // it stays unpriced until it has a row.
    RATES.iter().find(|(k, ..)| *k == id).map(|&(_, i, o, c)| (i, o, c))
}

/// Reasoning is a subset of output (zcode's `totalTokens` is input + output),
/// so it is never added on top — its cost is carved out of the output cost.
pub fn cost_of(model_id: &str, usage: &ZcodeUsage, reasoning: f64) -> ZcodeCost {
    let Some((in_rate, out_rate, cache_rate)) = rate_for(model_id) else {
        return ZcodeCost { known: false, ..Default::default() };
    };
    let input = (usage.input.max(0.0) / M) * in_rate;
    let output = (usage.output.max(0.0) / M) * out_rate;
    let cache_read = (usage.cache_read.max(0.0) / M) * cache_rate;
    // The catalog publishes no separate write rate for these models; writes bill
    // as ordinary input.
    let cache_write = (usage.cache_write.max(0.0) / M) * in_rate;
    let reasoning_cost = if usage.output > 0.0 {
        output * (reasoning.max(0.0) / usage.output)
    } else {
        0.0
    };
    ZcodeCost {
        total: input + output + cache_read + cache_write,
        input,
        output,
        cache_read,
        cache_write,
        reasoning: reasoning_cost,
        // What the cached input would have cost at the full input rate.
        cache_savings: (usage.cache_read.max(0.0) / M) * (in_rate - cache_rate),
        known: true,
        source: SOURCE.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn routing_suffixes_and_vendor_spellings_collapse_to_one_rate() {
        assert_eq!(canonical_id("z-ai/glm-5.3-flash:makora"), "z-ai/glm-5.3-flash");
        assert_eq!(canonical_id("z-ai/glm-5.3-flash:nitro"), "z-ai/glm-5.3-flash");
        assert_eq!(canonical_id("zai-org/GLM-5.3-Flash"), "z-ai/glm-5.3-flash");
        // The coding plan's bare marketing name reaches the same entry.
        assert_eq!(canonical_id("GLM-5.3-Flash"), "z-ai/glm-5.3-flash");
        assert_eq!(canonical_id("GLM-5.3"), "z-ai/glm-5.3");
    }

    #[test]
    fn prices_cached_input_below_fresh_input_and_reports_the_saving() {
        let c = cost_of(
            "GLM-5.3-Flash",
            &ZcodeUsage { input: 1_000_000.0, output: 0.0, cache_read: 1_000_000.0, cache_write: 0.0 },
            0.0,
        );
        assert!(c.known);
        assert!((c.input - 0.075).abs() < 1e-9);
        assert!((c.cache_read - 0.015).abs() < 1e-9);
        assert!((c.cache_savings - 0.06).abs() < 1e-9);
    }

    #[test]
    fn reasoning_is_carved_out_of_output_not_added_to_it() {
        let c = cost_of(
            "z-ai/glm-5.3-flash:makora",
            &ZcodeUsage { input: 0.0, output: 20_953.0, cache_read: 0.0, cache_write: 0.0 },
            18_465.0,
        );
        assert!((c.total - c.output).abs() < 1e-12, "reasoning must not inflate the total");
        assert!(c.reasoning < c.output);
        assert!(c.reasoning > 0.0);
    }

    #[test]
    fn a_longer_model_id_is_not_priced_as_its_shorter_namesake() {
        for model in ["moonshotai/kimi-k3.1-pro", "qwen/qwen3.8-max-prime", "z-ai/glm-5.3-flash-x"] {
            let c = cost_of(model, &ZcodeUsage { input: 1e6, output: 1e6, ..Default::default() }, 0.0);
            assert!(!c.known, "{model}");
        }
        assert!(cost_of("moonshotai/kimi-k3", &ZcodeUsage { input: 1e6, ..Default::default() }, 0.0).known);
        assert!(cost_of("qwen/qwen3.8-max-0902", &ZcodeUsage { input: 1e6, ..Default::default() }, 0.0).known);
    }

    #[test]
    fn unknown_models_stay_unpriced_rather_than_guessed() {
        let c = cost_of("some-vendor/unknown-model", &ZcodeUsage { input: 1e6, output: 1e6, ..Default::default() }, 0.0);
        assert!(!c.known);
        assert_eq!(c.total, 0.0);
    }
}
