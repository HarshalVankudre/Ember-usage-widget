//! Both providers' buckets are normalized to one shape so the renderer can
//! merge them freely:
//!   { provider, date, hour, minute, model, project, session, msgs, activeMs,
//!     input, output, cacheRead, cacheWrite, reasoning,   <- token counts
//!     cost, cIn, cOut, cCr, cCw, cRs, cacheSavings, priced }
//! Claude: cacheRead/cacheWrite are real log counts (5m+1h writes merged).
//! Codex: `cached` maps to cacheRead. Native logs currently omit cache writes,
//! so cacheWrite stays 0 while cCw and costMin/costMax expose the uncertainty.

use super::model_attribution::is_openai_model;
use super::{claude_usage, codex_usage};
use serde_json::{json, Value};

pub fn normalize_claude(b: &claude_usage::Bucket) -> Value {
    if is_openai_model(&b.model) {
        // Claudex/Ultracode records GPT calls in Claude's Anthropic-shaped
        // transcript. Attribute those calls to Codex, retain their real project
        // and session, and translate the token fields to OpenAI billing
        // semantics.
        return json!({
            "provider": "codex",
            "date": b.date, "hour": b.hour, "minute": b.minute,
            "model": b.model, "project": b.project, "session": b.session,
            "msgs": b.msgs, "activeMs": b.active_ms,
            "input": b.input, "output": b.output,
            "cacheRead": b.cache_read, "cacheWrite": b.cache_w5m + b.cache_w1h, "reasoning": b.reasoning,
            "cost": b.cost, "costMin": b.cost_min, "costMax": b.cost_max,
            "cIn": b.c_in, "cOut": b.c_out, "cCr": b.c_cr, "cCw": b.c_cw, "cRs": b.c_reasoning, "cTool": b.c_tool,
            "cacheSavings": b.cache_savings, "priced": b.priced, "estimated": b.estimated,
            "pricedCalls": b.priced_calls, "unpricedCalls": b.unpriced_calls,
            "longContextCalls": b.long_context_calls,
            "pricingSource": b.pricing_source,
            "projectDeleted": b.project_deleted,
        });
    }

    json!({
        "provider": "claude",
        "date": b.date, "hour": b.hour, "minute": b.minute,
        "model": b.model, "project": b.project, "session": b.session,
        "msgs": b.msgs, "activeMs": b.active_ms,
        "input": b.input, "output": b.output,
        "cacheRead": b.cache_read, "cacheWrite": b.cache_w5m + b.cache_w1h, "reasoning": b.reasoning,
        "cost": b.cost, "costMin": b.cost_min, "costMax": b.cost_max,
        "cIn": b.c_in, "cOut": b.c_out, "cCr": b.c_cr, "cCw": b.c_cw, "cRs": b.c_reasoning, "cTool": b.c_tool,
        "cacheSavings": b.cache_savings, "priced": b.priced, "estimated": b.estimated,
        "pricedCalls": b.priced_calls, "unpricedCalls": b.unpriced_calls,
        "fastCalls": b.fast_calls, "usRegionCalls": b.us_region_calls,
        "pricingSource": b.pricing_source,
        "projectDeleted": b.project_deleted,
    })
}

pub fn normalize_codex(b: &codex_usage::Bucket) -> Value {
    json!({
        "provider": "codex",
        "date": b.date, "hour": b.hour, "minute": b.minute,
        "model": b.model, "project": b.project, "session": b.session,
        "msgs": b.msgs, "activeMs": b.active_ms,
        "input": b.input, "output": b.output,
        "cacheRead": b.cached, "cacheWrite": b.cache_write, "reasoning": b.reasoning,
        "cost": b.cost, "costMin": b.cost_min, "costMax": b.cost_max,
        "cIn": b.c_in, "cOut": b.c_out, "cCr": b.c_cached, "cCw": b.c_write, "cRs": b.c_reasoning, "cTool": 0,
        "cacheSavings": b.cache_savings, "priced": b.priced, "estimated": b.estimated,
        "pricedCalls": b.priced_calls, "unpricedCalls": b.unpriced_calls,
        "longContextCalls": b.long_context_calls,
        "pricingSource": b.pricing_source,
        "projectDeleted": b.project_deleted,
    })
}
