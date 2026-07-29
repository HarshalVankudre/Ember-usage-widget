//! Codex writes its ChatGPT-plan rate-limit state into rollout logs, while
//! ClaudeX stores the same shared-account state in its local usage cache. Use
//! whichever snapshot is newest so both runtimes feed one Codex limit group;
//! countdowns keep ticking client-side without another network call.

use super::claudex_paths;
use super::codex_usage::LimitsSnap;
use chrono::{SecondsFormat, TimeZone, Utc};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

static CACHE_FILE: Mutex<Option<PathBuf>> = Mutex::new(None);

pub fn claudex_usage_dir() -> PathBuf {
    claudex_paths::usage_dir()
}

fn claudex_limits_file() -> PathBuf {
    claudex_usage_dir().join("limits.json")
}

pub fn init(user_data: &Path) {
    *CACHE_FILE.lock().unwrap() = Some(user_data.join("codex-limits-cache.json"));
}

/// Snapshots cached before window lengths were recorded carry only the row
/// name. The names were generated from the length, so it reads back exactly —
/// without it the quota ledger would file the same meter under two identities.
fn hydrate_window(w: &Value) -> Value {
    if !w.is_object() || w.get("windowMinutes").and_then(|v| v.as_f64()).unwrap_or(0.0) != 0.0 {
        return w.clone();
    }
    let name = w.get("name").and_then(|v| v.as_str()).unwrap_or("");
    let minutes: Option<f64> = if let Some(caps) =
        regex::Regex::new(r"^Current session \((\d+)h\)$").unwrap().captures(name)
    {
        caps[1].parse::<f64>().ok().map(|h| h * 60.0)
    } else if let Some(caps) = regex::Regex::new(r"^(\d+)-day limit$").unwrap().captures(name) {
        caps[1].parse::<f64>().ok().map(|d| d * 1440.0)
    } else if name == "Weekly limit" {
        Some(7.0 * 1440.0)
    } else {
        None
    };
    match minutes {
        Some(minutes) => {
            let mut out = w.clone();
            out["windowMinutes"] = json!(minutes);
            out
        }
        None => w.clone(),
    }
}

/// last good snapshot survives restarts, so the card never goes blank
pub fn load_cached() -> Option<Value> {
    let path = CACHE_FILE.lock().unwrap().clone()?;
    let raw = std::fs::read_to_string(path).ok()?;
    let mut snap: Value = serde_json::from_str(&raw).ok()?;
    if snap.get("ok").and_then(|v| v.as_bool()) != Some(true) {
        return None;
    }
    if let Some(windows) = snap.get("windows").and_then(|v| v.as_array()) {
        let hydrated: Vec<Value> = windows.iter().map(hydrate_window).collect();
        snap["windows"] = Value::Array(hydrated);
    }
    Some(snap)
}

pub fn save_cached(snap: &Value) {
    let Some(path) = CACHE_FILE.lock().unwrap().clone() else { return };
    if let Ok(body) = serde_json::to_string(snap) {
        let _ = std::fs::write(path, body);
    }
}

fn plan_label(plan_type: Option<&str>) -> String {
    let Some(t) = plan_type.filter(|t| !t.is_empty()) else { return String::new() };
    match t.to_lowercase().as_str() {
        "free" => "Free".to_string(),
        "plus" => "Plus".to_string(),
        "pro" => "Pro".to_string(),
        "prolite" => "Pro Lite".to_string(),
        "business" | "team" => "Business".to_string(),
        "enterprise" => "Enterprise".to_string(),
        "edu" => "Edu".to_string(),
        lower => {
            let mut chars = lower.chars();
            match chars.next() {
                Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
                None => String::new(),
            }
        }
    }
}

fn iso_from_seconds(seconds: f64) -> Option<String> {
    let ms = (seconds * 1000.0).round() as i64;
    Utc.timestamp_millis_opt(ms)
        .single()
        .map(|dt| dt.to_rfc3339_opts(SecondsFormat::Millis, true))
}

fn window_row(w: Option<&Value>, fallback_name: &str) -> Option<Value> {
    let w = w.filter(|w| w.is_object())?;
    let utilization = w.get("used_percent").filter(|v| !v.is_null())?.clone();
    let mins = w.get("window_minutes").and_then(|v| v.as_f64()).unwrap_or(0.0);
    let mut name = fallback_name.to_string();
    let mut style = "day";
    if mins > 0.0 && mins <= 720.0 {
        name = format!("Current session ({}h)", (mins / 60.0).round());
        style = "countdown";
    } else if (8640.0..=11520.0).contains(&mins) {
        name = "Weekly limit".to_string();
    } else if mins > 720.0 {
        name = format!("{}-day limit", (mins / 1440.0).round());
    }
    let resets_at = w
        .get("resets_at")
        .and_then(|v| v.as_f64())
        .filter(|v| *v != 0.0)
        .and_then(iso_from_seconds);
    Some(json!({
        "name": name,
        // 'countdown' -> "Resets in X hr Y min", 'day' -> "Resets Tue 9:30 AM"
        "style": style,
        // The window length is the meter's stable identity for the quota
        // ledger: Codex renames the row when the ChatGPT plan changes, but a
        // 7-day meter stays a 7-day meter.
        "windowMinutes": mins.round(),
        "utilization": utilization,
        "resetsAt": resets_at,
    }))
}

fn timestamp_ms(value: Option<&Value>) -> f64 {
    let n = value.and_then(|v| v.as_f64()).unwrap_or(0.0);
    if !n.is_finite() || n <= 0.0 {
        return 0.0;
    }
    if n < 1e12 { n * 1000.0 } else { n }
}

fn claudex_window_row(w: Option<&Value>, fallback_name: &str) -> Option<Value> {
    let w = w.filter(|w| w.is_object())?;
    w.get("used_percent").filter(|v| !v.is_null())?;
    let seconds = w.get("limit_window_seconds").and_then(|v| v.as_f64()).unwrap_or(0.0);
    let resets = timestamp_ms(w.get("reset_at"));
    window_row(
        Some(&json!({
            "used_percent": w.get("used_percent"),
            "window_minutes": seconds / 60.0,
            "resets_at": resets / 1000.0,
        })),
        fallback_name,
    )
}

pub fn from_claudex_payload(payload: &Value) -> Value {
    let Some(rl) = payload.get("rate_limit").filter(|v| crate::js_truthy(v)) else {
        return json!({ "ok": false, "reason": "no-data" });
    };
    // additional_rate_limits are model-specific meters. Keep them out of the
    // account headroom card so ClaudeX does not create separate model bars.
    let mut windows = Vec::new();
    if let Some(primary) = claudex_window_row(rl.get("primary_window"), "Codex limit") {
        windows.push(primary);
    }
    if let Some(secondary) = claudex_window_row(rl.get("secondary_window"), "Secondary limit") {
        windows.push(secondary);
    }
    let label = plan_label(payload.get("plan_type").and_then(|v| v.as_str()));
    if windows.is_empty() && label.is_empty() {
        return json!({ "ok": false, "reason": "no-data" });
    }
    json!({
        "ok": true,
        "fetchedAt": timestamp_ms(payload.get("fetched_at")),
        "plan": if label.is_empty() { Value::Null } else {
            json!({ "type": payload.get("plan_type"), "label": label })
        },
        "windows": windows,
        "source": "claudex",
    })
}

pub fn load_claudex() -> Value {
    match std::fs::read_to_string(claudex_limits_file()) {
        Ok(raw) => match serde_json::from_str::<Value>(&raw) {
            Ok(payload) => from_claudex_payload(&payload),
            Err(_) => json!({ "ok": false, "reason": "no-data" }),
        },
        Err(_) => json!({ "ok": false, "reason": "no-data" }),
    }
}

fn is_ok(v: &Value) -> bool {
    v.get("ok").and_then(|v| v.as_bool()) == Some(true)
}

pub fn newest(a: Option<Value>, b: Option<Value>) -> Option<Value> {
    let a_ok = a.as_ref().is_some_and(is_ok);
    let b_ok = b.as_ref().is_some_and(is_ok);
    if !a_ok {
        return if b_ok { b } else { a.or(b) };
    }
    if !b_ok {
        return a;
    }
    let at = |v: &Option<Value>| {
        v.as_ref()
            .and_then(|v| v.get("fetchedAt"))
            .and_then(|v| v.as_f64())
            .unwrap_or(0.0)
    };
    if at(&b) > at(&a) { b } else { a }
}

/// snapshot from codex_usage::aggregate(): { ts, rateLimits } or None
pub fn from_snapshot(snap: Option<&LimitsSnap>) -> Value {
    let Some(snap) = snap else {
        return json!({ "ok": false, "reason": "no-data" });
    };
    let rl = &snap.rate_limits;
    if !crate::js_truthy(rl) {
        return json!({ "ok": false, "reason": "no-data" });
    }
    let mut windows = Vec::new();
    if let Some(primary) = window_row(rl.get("primary"), "Session limit") {
        windows.push(primary);
    }
    if let Some(secondary) = window_row(rl.get("secondary"), "Weekly limit") {
        windows.push(secondary);
    }
    let label = plan_label(rl.get("plan_type").and_then(|v| v.as_str()));
    if windows.is_empty() && label.is_empty() {
        return json!({ "ok": false, "reason": "no-data" });
    }
    json!({
        "ok": true,
        "fetchedAt": snap.ts,
        "plan": if label.is_empty() { Value::Null } else {
            json!({ "type": rl.get("plan_type"), "label": label })
        },
        "windows": windows,
        "source": "codex",
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_claudex_shared_account_limits_into_the_codex_limit_shape() {
        let limits = from_claudex_payload(&json!({
            "fetched_at": 1_784_329_364_i64,
            "plan_type": "prolite",
            "rate_limit": {
                "primary_window": {
                    "used_percent": 34,
                    "limit_window_seconds": 7 * 24 * 60 * 60,
                    "reset_at": 1_784_780_961_i64,
                },
                "secondary_window": null,
            },
            "additional_rate_limits": [{
                "limit_name": "GPT-5.3-Codex-Spark",
                "rate_limit": { "primary_window": { "used_percent": 0 } },
            }],
        }));

        assert_eq!(limits["ok"], json!(true));
        assert_eq!(limits["source"], json!("claudex"));
        assert_eq!(limits["fetchedAt"], json!(1_784_329_364_000.0));
        assert_eq!(limits["plan"], json!({ "type": "prolite", "label": "Pro Lite" }));
        let windows = limits["windows"].as_array().unwrap();
        assert_eq!(windows.len(), 1);
        assert_eq!(windows[0]["name"], json!("Weekly limit"));
        assert_eq!(windows[0]["utilization"], json!(34));
        // JS: new Date(1_784_780_961_000).toISOString()
        assert_eq!(
            windows[0]["resetsAt"].as_str(),
            iso_from_seconds(1_784_780_961.0).as_deref()
        );
        let iso = windows[0]["resetsAt"].as_str().unwrap();
        assert!(iso.ends_with(".000Z") && iso.starts_with("2026-"), "unexpected ISO shape: {iso}");
    }

    #[test]
    fn newest_uses_the_freshest_snapshot_without_adding_another_group() {
        let native = json!({
            "ok": true, "source": "codex", "fetchedAt": 1_000,
            "windows": [{ "name": "Weekly limit", "utilization": 20 }],
        });
        let claudex = json!({
            "ok": true, "source": "claudex", "fetchedAt": 2_000,
            "windows": [{ "name": "Weekly limit", "utilization": 34 }],
        });
        assert_eq!(newest(Some(native.clone()), Some(claudex.clone())), Some(claudex.clone()));
        assert_eq!(newest(Some(claudex.clone()), Some(native.clone())), Some(claudex));
    }

    #[test]
    fn old_snapshots_read_their_window_length_back_from_the_row_name() {
        let hydrated = hydrate_window(&json!({
            "name": "Current session (5h)", "style": "countdown", "utilization": 12
        }));
        assert_eq!(hydrated["windowMinutes"], json!(300.0));
        let weekly = hydrate_window(&json!({ "name": "Weekly limit", "style": "day", "utilization": 91 }));
        assert_eq!(weekly["windowMinutes"], json!(10080.0));
    }

    #[test]
    fn a_fresh_scan_already_carries_the_window_length() {
        let limits = from_snapshot(Some(&LimitsSnap {
            ts: 1_000.0,
            rate_limits: json!({
                "plan_type": "prolite",
                "primary": { "used_percent": 12, "window_minutes": 300, "resets_at": 1_784_780_961_i64 },
                "secondary": { "used_percent": 91, "window_minutes": 10080, "resets_at": 1_784_980_961_i64 },
            }),
        }));
        let windows = limits["windows"].as_array().unwrap();
        assert_eq!(windows[0]["windowMinutes"], json!(300.0));
        assert_eq!(windows[1]["windowMinutes"], json!(10080.0));
    }
}
