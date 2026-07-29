//! Quota ledger — the history the plan meters never keep.
//!
//! Both providers publish a single "you are N% through your quota" number and
//! nothing else: no history, and no record of what that percent used to buy.
//! When the allowance behind the percentage moves, every earlier reading is
//! gone, so a plan that quietly tightens looks identical to one that did not.
//!
//! Ember samples each meter it can see, remembers every window it observed, and
//! stores enough to pair that window with the usage recorded in the same
//! interval. The renderer turns the pair into the one figure that survives a
//! policy change: how much real work a single percent of the plan bought.
//!
//! Only the meter readings live here. Tokens and cost are never copied into
//! this file — they are recomputed from the usage buckets on demand, so the
//! ledger stays small and can never drift away from the usage history.

use regex::Regex;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

const FILE_VERSION: u64 = 1;
const MAX_INSTANCES: usize = 260; // per meter — roughly two months of sessions
const MAX_SAMPLES: usize = 90; // per instance, after thinning
const SAMPLE_MIN_GAP_MS: f64 = 60.0 * 1000.0;
const RESET_MATCH_TOLERANCE_MS: f64 = 90.0 * 1000.0;

// Anthropic publishes these window lengths; the meters themselves do not carry
// them. Codex reports its own window length in the rollout snapshot.
pub const CLAUDE_SESSION_MINUTES: f64 = 300.0;
pub const CLAUDE_WEEK_MINUTES: f64 = 7.0 * 24.0 * 60.0;

#[derive(Clone, Debug)]
pub struct Instance {
    pub resets_at: f64, // 0 = the provider published no reset time
    pub window_minutes: f64,
    pub started_at: f64,
    pub first_seen_at: f64,
    pub last_seen_at: f64,
    pub first_util: f64,
    pub peak_util: f64,
    pub last_util: f64,
    pub joined_late: bool,
    pub samples: Vec<(f64, f64)>,
    pub closed: bool,
    pub ended_at: Option<f64>,
}

#[derive(Clone, Debug)]
pub struct Meter {
    pub id: String,
    pub provider: String,
    pub kind: String,
    pub label: String,
    pub window_minutes: f64,
    pub instances: Vec<Instance>,
}

#[derive(Clone, Debug)]
pub struct Reading {
    pub id: String,
    pub provider: &'static str,
    pub kind: &'static str,
    pub label: String,
    pub window_minutes: f64,
    pub utilization: Option<f64>,
    pub resets_at: f64,
}

/// An early build filed Codex meters under their row label when the cached
/// snapshot had no window length. Those entries describe a meter that can
/// never receive another reading, so they are dropped rather than shown as a
/// duplicate of the same window.
fn is_known_meter_id(id: &str) -> bool {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| {
        Regex::new(r"^(claude\|session|claude\|weekly(:[a-z0-9-]+)?|codex\|\d+)$").unwrap()
    });
    re.is_match(id)
}

fn get_f64(v: &Value, key: &str) -> Option<f64> {
    v.get(key).and_then(|v| v.as_f64()).filter(|n| n.is_finite())
}

fn instance_from_value(v: &Value) -> Option<Instance> {
    if !v.is_object() {
        return None;
    }
    let started_at = get_f64(v, "startedAt")?;
    let samples = v
        .get("samples")
        .and_then(|s| s.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|pair| {
                    let pair = pair.as_array()?;
                    Some((pair.first()?.as_f64()?, pair.get(1)?.as_f64()?))
                })
                .collect()
        })
        .unwrap_or_default();
    Some(Instance {
        resets_at: get_f64(v, "resetsAt").unwrap_or(0.0),
        window_minutes: get_f64(v, "windowMinutes").unwrap_or(0.0),
        started_at,
        first_seen_at: get_f64(v, "firstSeenAt").unwrap_or(0.0),
        last_seen_at: get_f64(v, "lastSeenAt").unwrap_or(0.0),
        first_util: get_f64(v, "firstUtil").unwrap_or(0.0),
        peak_util: get_f64(v, "peakUtil").unwrap_or(0.0),
        last_util: get_f64(v, "lastUtil").unwrap_or(0.0),
        joined_late: v.get("joinedLate").and_then(|b| b.as_bool()).unwrap_or(false),
        samples,
        closed: v.get("closed").and_then(|b| b.as_bool()).unwrap_or(false),
        ended_at: get_f64(v, "endedAt"),
    })
}

fn instance_to_value(i: &Instance) -> Value {
    let samples: Vec<Value> = i.samples.iter().map(|(ts, util)| json!([ts, util])).collect();
    let mut out = json!({
        "resetsAt": i.resets_at,
        "windowMinutes": i.window_minutes,
        "startedAt": i.started_at,
        "firstSeenAt": i.first_seen_at,
        "lastSeenAt": i.last_seen_at,
        "firstUtil": i.first_util,
        "peakUtil": i.peak_util,
        "lastUtil": i.last_util,
        "joinedLate": i.joined_late,
        "samples": samples,
        "closed": i.closed,
    });
    if let Some(ended_at) = i.ended_at {
        out["endedAt"] = json!(ended_at);
    }
    out
}

fn normalize_stored_meter(v: &Value) -> Option<Meter> {
    let id = v.get("id").and_then(|i| i.as_str())?.to_string();
    let provider = if v.get("provider").and_then(|p| p.as_str()) == Some("codex") { "codex" } else { "claude" };
    let kind = v
        .get("kind")
        .and_then(|k| k.as_str())
        .filter(|k| !k.is_empty())
        .unwrap_or("session")
        .to_string();
    let label = v
        .get("label")
        .and_then(|l| l.as_str())
        .filter(|l| !l.is_empty())
        .unwrap_or(&id)
        .to_string();
    let window_minutes = get_f64(v, "windowMinutes").unwrap_or(0.0);
    let mut instances: Vec<Instance> = v
        .get("instances")
        .and_then(|i| i.as_array())
        .map(|arr| arr.iter().filter_map(instance_from_value).collect())
        .unwrap_or_default();
    if instances.len() > MAX_INSTANCES {
        instances.drain(0..instances.len() - MAX_INSTANCES);
    }
    Some(Meter {
        id,
        provider: provider.to_string(),
        kind,
        label,
        window_minutes,
        instances,
    })
}

/* ---------------- meter extraction ---------------- */

fn pct(value: Option<&Value>) -> Option<f64> {
    let n = value?.as_f64()?;
    if !n.is_finite() {
        return None;
    }
    Some(n.clamp(0.0, 100.0))
}

/// Reset times arrive with microsecond noise around a boundary the providers
/// actually place on the minute — 03:59:59.190 and 04:00:00.388 are the same
/// instant restated. Rounding there keeps a window from reading as 00:59–05:59
/// and stops two readings of one window from looking like two windows.
fn to_ms(value: Option<&Value>) -> f64 {
    let Some(value) = value else { return 0.0 };
    let ms = match value {
        Value::String(s) => crate::parse_ts_ms(s).unwrap_or(f64::NAN),
        Value::Number(n) => n.as_f64().unwrap_or(f64::NAN),
        _ => return 0.0,
    };
    if ms.is_finite() { (ms / 60000.0).round() * 60000.0 } else { 0.0 }
}

/// "Fable" and "Fable 5" are the same product meter; the account API has used
/// both display names. Keep one identity so a rename never splits the history.
pub fn scoped_model_key(display_name: &str) -> String {
    static SPACES: OnceLock<Regex> = OnceLock::new();
    static VERSION: OnceLock<Regex> = OnceLock::new();
    static INVALID: OnceLock<Regex> = OnceLock::new();
    let spaces = SPACES.get_or_init(|| Regex::new(r"\s+").unwrap());
    let version = VERSION.get_or_init(|| Regex::new(r"-?\d+(\.\d+)?$").unwrap());
    let invalid = INVALID.get_or_init(|| Regex::new(r"[^a-z0-9-]").unwrap());
    let lower = display_name.to_lowercase();
    let dashed = spaces.replace_all(&lower, "-");
    let trimmed = version.replacen(&dashed, 1, "");
    let cleaned = invalid.replace_all(&trimmed, "").into_owned();
    if cleaned.is_empty() { "scoped".to_string() } else { cleaned }
}

fn scoped_model_label(display_name: &str) -> String {
    static FABLE: OnceLock<Regex> = OnceLock::new();
    let fable = FABLE.get_or_init(|| Regex::new(r"(?i)^fable(\s*5)?$").unwrap());
    let name = display_name.trim();
    if name.is_empty() {
        return "Scoped model".to_string();
    }
    if fable.is_match(name) { "Fable 5".to_string() } else { name.to_string() }
}

pub fn claude_meters(limits: Option<&Value>) -> Vec<Reading> {
    // A stale snapshot is a snapshot Ember could not refresh, not a new
    // reading. Replaying it would stamp an outdated utilization onto the live
    // window.
    let Some(limits) = limits else { return Vec::new() };
    let ok = limits.get("ok").and_then(|v| v.as_bool()) == Some(true);
    let stale = limits.get("stale").is_some_and(crate::js_truthy);
    let Some(d) = limits.get("data").filter(|v| crate::js_truthy(v)) else { return Vec::new() };
    if !ok || stale {
        return Vec::new();
    }

    let mut out: Vec<Reading> = Vec::new();
    let mut add = |meter: Reading| {
        if meter.utilization.is_none() || out.iter().any(|m| m.id == meter.id) {
            return;
        }
        out.push(meter);
    };

    if let Some(five_hour) = d.get("five_hour").filter(|v| crate::js_truthy(v)) {
        add(Reading {
            id: "claude|session".to_string(),
            provider: "claude",
            kind: "session",
            label: "Claude session · 5 hours".to_string(),
            window_minutes: CLAUDE_SESSION_MINUTES,
            utilization: pct(five_hour.get("utilization")),
            resets_at: to_ms(five_hour.get("resets_at")),
        });
    }
    if let Some(seven_day) = d.get("seven_day").filter(|v| crate::js_truthy(v)) {
        add(Reading {
            id: "claude|weekly".to_string(),
            provider: "claude",
            kind: "weekly",
            label: "Claude weekly · all models".to_string(),
            window_minutes: CLAUDE_WEEK_MINUTES,
            utilization: pct(seven_day.get("utilization")),
            resets_at: to_ms(seven_day.get("resets_at")),
        });
    }
    for (field, name) in [
        ("seven_day_opus", "Opus"),
        ("seven_day_sonnet", "Sonnet"),
        ("seven_day_fable", "Fable 5"),
        ("seven_day_fable_5", "Fable 5"),
    ] {
        let Some(v) = d.get(field).filter(|v| crate::js_truthy(v)) else { continue };
        if v.get("utilization").map_or(true, |u| u.is_null()) {
            continue;
        }
        add(Reading {
            id: format!("claude|weekly:{}", scoped_model_key(name)),
            provider: "claude",
            kind: "weekly-scoped",
            label: format!("Claude weekly · {name}"),
            window_minutes: CLAUDE_WEEK_MINUTES,
            utilization: pct(v.get("utilization")),
            resets_at: to_ms(v.get("resets_at")),
        });
    }
    // Newer payloads carry model-scoped quotas in a generic array rather than a
    // named field, so both shapes feed the same meter identity.
    for v in d.get("limits").and_then(|l| l.as_array()).map(|a| a.as_slice()).unwrap_or(&[]) {
        if !crate::js_truthy(v) || v.get("percent").map_or(true, |p| p.is_null()) {
            continue;
        }
        match v.get("kind").and_then(|k| k.as_str()) {
            Some("session") => add(Reading {
                id: "claude|session".to_string(),
                provider: "claude",
                kind: "session",
                label: "Claude session · 5 hours".to_string(),
                window_minutes: CLAUDE_SESSION_MINUTES,
                utilization: pct(v.get("percent")),
                resets_at: to_ms(v.get("resets_at")),
            }),
            Some("weekly_all") => add(Reading {
                id: "claude|weekly".to_string(),
                provider: "claude",
                kind: "weekly",
                label: "Claude weekly · all models".to_string(),
                window_minutes: CLAUDE_WEEK_MINUTES,
                utilization: pct(v.get("percent")),
                resets_at: to_ms(v.get("resets_at")),
            }),
            Some("weekly_scoped") => {
                let display = v
                    .pointer("/scope/model/display_name")
                    .and_then(|d| d.as_str())
                    .filter(|d| !d.is_empty());
                let Some(display) = display else { continue };
                add(Reading {
                    id: format!("claude|weekly:{}", scoped_model_key(display)),
                    provider: "claude",
                    kind: "weekly-scoped",
                    label: format!("Claude weekly · {}", scoped_model_label(display)),
                    window_minutes: CLAUDE_WEEK_MINUTES,
                    utilization: pct(v.get("percent")),
                    resets_at: to_ms(v.get("resets_at")),
                });
            }
            _ => {}
        }
    }
    out
}

pub fn codex_meters(limits: Option<&Value>) -> Vec<Reading> {
    let Some(limits) = limits else { return Vec::new() };
    if limits.get("ok").and_then(|v| v.as_bool()) != Some(true) {
        return Vec::new();
    }
    let Some(windows) = limits.get("windows").and_then(|w| w.as_array()) else {
        return Vec::new();
    };
    let mut out: Vec<Reading> = Vec::new();
    for w in windows {
        if !crate::js_truthy(w) || w.get("utilization").map_or(true, |u| u.is_null()) {
            continue;
        }
        // The window length is the stable identity: Codex renames the row (and
        // ChatGPT plan changes shift the label) while the meter stays the same.
        // A row that cannot supply one is skipped rather than filed under its
        // label, which would split one meter's history in two.
        let minutes = w.get("windowMinutes").and_then(|m| m.as_f64()).unwrap_or(0.0);
        if minutes == 0.0 {
            continue;
        }
        let id = format!("codex|{}", crate::js_num(minutes));
        if out.iter().any(|m| m.id == id) {
            continue;
        }
        let name = w.get("name").and_then(|n| n.as_str()).unwrap_or("");
        out.push(Reading {
            id,
            provider: "codex",
            kind: if minutes <= 720.0 { "session" } else { "weekly" },
            label: format!("Codex · {name}"),
            window_minutes: minutes,
            utilization: pct(w.get("utilization")),
            resets_at: to_ms(w.get("resetsAt")),
        });
    }
    out
}

/* ---------------- window instances ---------------- */

/// A meter reading belongs to the window it says it belongs to. `resets_at` is
/// the only stable identity both providers publish, so it decides the
/// boundary; a utilization drop is the fallback for meters that omit a reset
/// time.
fn is_same_instance(instance: &Instance, resets_at: f64, utilization: f64) -> bool {
    if instance.resets_at != 0.0 && resets_at != 0.0 {
        return (instance.resets_at - resets_at).abs() <= RESET_MATCH_TOLERANCE_MS;
    }
    if instance.resets_at == 0.0 && resets_at == 0.0 {
        return utilization + 5.0 >= instance.last_util;
    }
    false
}

/// Keep the shape of the burn curve without keeping every reading: once an
/// instance is full, drop every second older sample and halve the resolution.
fn push_sample(instance: &mut Instance, ts: f64, utilization: f64) {
    if let Some(last) = instance.samples.last_mut() {
        if ts - last.0 < SAMPLE_MIN_GAP_MS {
            if utilization == last.1 {
                return;
            }
            // A change inside the sampling gap replaces the reading rather
            // than appending, so a burst of refreshes cannot flood the curve.
            last.0 = ts;
            last.1 = utilization;
            return;
        }
    }
    instance.samples.push((ts, utilization));
    if instance.samples.len() > MAX_SAMPLES {
        let len = instance.samples.len();
        let thinned: Vec<(f64, f64)> = instance
            .samples
            .iter()
            .enumerate()
            .filter(|(i, _)| i % 2 == 0 || *i == len - 1)
            .map(|(_, s)| *s)
            .collect();
        instance.samples = thinned;
    }
}

fn start_instance(meter: &Meter, resets_at: f64, utilization: f64, now: f64) -> Instance {
    let window_ms = meter.window_minutes * 60000.0;
    // The true window start is derived from the reset time, so the very first
    // window Ember sees is already measurable — usage history reaches back
    // further than the ledger does.
    let anchored = resets_at != 0.0 && window_ms != 0.0;
    Instance {
        resets_at,
        window_minutes: meter.window_minutes,
        started_at: if anchored { resets_at - window_ms } else { now },
        first_seen_at: now,
        last_seen_at: now,
        first_util: utilization,
        peak_util: utilization,
        last_util: utilization,
        // A window observed from its first moments is measured end to end. One
        // joined midstream still reports real usage, because `started_at` is
        // the provider's own boundary rather than the moment Ember started
        // looking.
        joined_late: !anchored,
        samples: vec![(now, utilization)],
        closed: false,
        ended_at: None,
    }
}

fn observe(meter: &mut Meter, reading: &Reading, now: f64) -> bool {
    let Some(utilization) = reading.utilization else { return false };
    let resets_at = reading.resets_at;

    if let Some(current) = meter.instances.last_mut() {
        if !current.closed && is_same_instance(current, resets_at, utilization) {
            let changed = utilization != current.last_util;
            current.last_seen_at = now;
            current.last_util = utilization;
            if utilization > current.peak_util {
                current.peak_util = utilization;
            }
            push_sample(current, now, utilization);
            return changed;
        }
        if !current.closed {
            current.closed = true;
            // A window ends at its published reset time; without one, the last
            // moment it was still observed is the honest boundary.
            current.ended_at = Some(if current.resets_at != 0.0 {
                current.resets_at
            } else {
                current.last_seen_at
            });
        }
    }
    let instance = start_instance(meter, resets_at, utilization, now);
    meter.instances.push(instance);
    if meter.instances.len() > MAX_INSTANCES {
        let excess = meter.instances.len() - MAX_INSTANCES;
        meter.instances.drain(0..excess);
    }
    true
}

/* ---------------- the ledger ---------------- */

#[derive(Default)]
pub struct Ledger {
    meters: Vec<Meter>,
}

impl Ledger {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn load(user_data: &Path) -> Self {
        let mut ledger = Self::new();
        let path = ledger_path(user_data);
        // a missing or unreadable ledger just starts a fresh history
        let Ok(raw) = std::fs::read_to_string(path) else { return ledger };
        let Ok(parsed) = serde_json::from_str::<Value>(&raw) else { return ledger };
        if parsed.get("v").and_then(|v| v.as_u64()) != Some(FILE_VERSION) {
            return ledger;
        }
        let Some(meters) = parsed.get("meters").and_then(|m| m.as_array()) else {
            return ledger;
        };
        for meter in meters {
            let Some(id) = meter.get("id").and_then(|i| i.as_str()) else { continue };
            if !is_known_meter_id(id) {
                continue;
            }
            if ledger.meters.iter().any(|m| m.id == id) {
                continue;
            }
            if let Some(normalized) = normalize_stored_meter(meter) {
                ledger.meters.push(normalized);
            }
        }
        ledger
    }

    /// Returns true when the stored state changed and should be persisted.
    pub fn record(&mut self, limits: &Value, now: f64) -> bool {
        let mut readings = claude_meters(limits.get("claude"));
        readings.extend(codex_meters(limits.get("codex")));
        let mut dirty = false;
        for reading in readings {
            let meter_index = match self.meters.iter().position(|m| m.id == reading.id) {
                Some(index) => index,
                None => {
                    self.meters.push(Meter {
                        id: reading.id.clone(),
                        provider: reading.provider.to_string(),
                        kind: reading.kind.to_string(),
                        label: reading.label.clone(),
                        window_minutes: reading.window_minutes,
                        instances: Vec::new(),
                    });
                    dirty = true;
                    self.meters.len() - 1
                }
            };
            let meter = &mut self.meters[meter_index];
            // Labels follow the provider's current wording; the identity does
            // not.
            if meter.label != reading.label {
                meter.label = reading.label.clone();
                dirty = true;
            }
            if reading.window_minutes != 0.0 && meter.window_minutes != reading.window_minutes {
                meter.window_minutes = reading.window_minutes;
                dirty = true;
            }
            if observe(meter, &reading, now) {
                dirty = true;
            }
        }
        dirty
    }

    /// Renderer view: the current window plus every completed one, newest
    /// first. Utilization only — the renderer pairs each window with its own
    /// usage.
    pub fn snapshot(&self, now: f64) -> Value {
        let mut out = Vec::new();
        for meter in &self.meters {
            if meter.instances.is_empty() {
                continue;
            }
            let last = meter.instances.last().unwrap();
            // A window whose reset time has passed is finished even if no
            // newer reading has arrived yet (the app may have been asleep).
            let live_now = !last.closed && (last.resets_at == 0.0 || last.resets_at > now);
            let history_slice: &[Instance] = if live_now {
                &meter.instances[..meter.instances.len() - 1]
            } else {
                &meter.instances
            };
            let history: Vec<Value> = history_slice
                .iter()
                .map(|i| {
                    json!({
                        "resetsAt": i.resets_at,
                        "startedAt": i.started_at,
                        "endedAt": i.ended_at.unwrap_or(if i.resets_at != 0.0 { i.resets_at } else { i.last_seen_at }),
                        "windowMinutes": if i.window_minutes != 0.0 { i.window_minutes } else { meter.window_minutes },
                        "peakUtil": i.peak_util,
                        "firstUtil": i.first_util,
                        "joinedLate": i.joined_late,
                        "observedFor": (i.last_seen_at - i.first_seen_at).max(0.0),
                    })
                })
                .rev()
                .collect();
            let current = if live_now {
                let samples: Vec<Value> = last.samples.iter().map(|(ts, util)| json!([ts, util])).collect();
                json!({
                    "resetsAt": last.resets_at,
                    "startedAt": last.started_at,
                    "endedAt": now,
                    "windowMinutes": if last.window_minutes != 0.0 { last.window_minutes } else { meter.window_minutes },
                    "peakUtil": last.peak_util,
                    "firstUtil": last.first_util,
                    "joinedLate": last.joined_late,
                    "samples": samples,
                })
            } else {
                Value::Null
            };
            out.push(json!({
                "id": meter.id,
                "provider": meter.provider,
                "kind": meter.kind,
                "label": meter.label,
                "windowMinutes": meter.window_minutes,
                "current": current,
                "history": history,
            }));
        }
        json!({ "meters": out, "generatedAt": now })
    }

    pub fn to_file_value(&self) -> Value {
        let meters: Vec<Value> = self
            .meters
            .iter()
            .map(|m| {
                json!({
                    "id": m.id,
                    "provider": m.provider,
                    "kind": m.kind,
                    "label": m.label,
                    "windowMinutes": m.window_minutes,
                    "instances": m.instances.iter().map(instance_to_value).collect::<Vec<Value>>(),
                })
            })
            .collect();
        json!({ "v": FILE_VERSION, "meters": meters })
    }

    pub fn persist(&self, user_data: &Path) {
        let path = ledger_path(user_data);
        if let Ok(body) = serde_json::to_string(&self.to_file_value()) {
            let temp = path.with_extension("json.tmp");
            if std::fs::write(&temp, body).is_ok() {
                let _ = std::fs::rename(&temp, path);
            }
        }
    }
}

fn ledger_path(user_data: &Path) -> PathBuf {
    user_data.join("quota-ledger.json")
}

#[cfg(test)]
mod tests {
    use super::*;

    const HOUR: f64 = 3600.0 * 1000.0;
    // 2026-07-24T23:00:00Z
    const T0: f64 = 1_784_934_000_000.0;

    fn iso(ms: f64) -> String {
        chrono::TimeZone::timestamp_millis_opt(&chrono::Utc, ms as i64)
            .single()
            .unwrap()
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
    }

    struct SnapOpts {
        session: f64,
        weekly: f64,
        scoped: Option<(&'static str, f64)>,
        session_resets: f64,
        weekly_resets: f64,
        stale: bool,
    }

    impl Default for SnapOpts {
        fn default() -> Self {
            Self {
                session: 23.0,
                weekly: 56.0,
                scoped: None,
                session_resets: T0 + 5.0 * HOUR,
                weekly_resets: T0 + 5.0 * HOUR,
                stale: false,
            }
        }
    }

    fn claude_snapshot(opts: SnapOpts) -> Value {
        let mut limits = vec![
            json!({ "kind": "session", "percent": opts.session, "resets_at": iso(opts.session_resets), "scope": null }),
            json!({ "kind": "weekly_all", "percent": opts.weekly, "resets_at": iso(opts.weekly_resets), "scope": null }),
        ];
        if let Some((name, percent)) = opts.scoped {
            limits.push(json!({
                "kind": "weekly_scoped",
                "percent": percent,
                "resets_at": iso(opts.weekly_resets),
                "scope": { "model": { "id": null, "display_name": name } },
            }));
        }
        json!({
            "ok": true,
            "fetchedAt": T0,
            "data": {
                "five_hour": { "utilization": opts.session, "resets_at": iso(opts.session_resets) },
                "seven_day": { "utilization": opts.weekly, "resets_at": iso(opts.weekly_resets) },
                "limits": limits,
            },
            "stale": opts.stale,
            "plan": { "label": "Max (5x)" },
        })
    }

    fn session_meter(snapshot: &Value) -> Value {
        snapshot["meters"]
            .as_array()
            .unwrap()
            .iter()
            .find(|m| m["id"] == json!("claude|session"))
            .cloned()
            .unwrap()
    }

    #[test]
    fn meters_come_from_both_named_fields_and_the_generic_limits_array() {
        let snap = claude_snapshot(SnapOpts { scoped: Some(("Fable", 81.0)), ..Default::default() });
        let meters = claude_meters(Some(&snap));
        let ids: Vec<&str> = meters.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids, ["claude|session", "claude|weekly", "claude|weekly:fable"]);
        assert_eq!(meters[0].window_minutes, 300.0);
        assert_eq!(meters[1].window_minutes, 7.0 * 24.0 * 60.0);
        assert_eq!(meters[2].utilization, Some(81.0));
        assert_eq!(meters[2].label, "Claude weekly · Fable 5");
    }

    #[test]
    fn scoped_meters_keep_one_identity_across_renames() {
        assert_eq!(scoped_model_key("Fable"), scoped_model_key("Fable 5"));
        assert_eq!(scoped_model_key("Opus"), "opus");
        assert_ne!(scoped_model_key("Opus"), scoped_model_key("Sonnet"));
    }

    #[test]
    fn a_stale_snapshot_is_not_replayed_as_a_new_reading() {
        let snap = claude_snapshot(SnapOpts { stale: true, ..Default::default() });
        assert!(claude_meters(Some(&snap)).is_empty());
        assert!(claude_meters(Some(&json!({ "ok": false, "reason": "http-429" }))).is_empty());
    }

    #[test]
    fn codex_meters_are_keyed_by_window_length_not_row_name() {
        let before = codex_meters(Some(&json!({
            "ok": true,
            "windows": [{ "name": "Weekly limit", "windowMinutes": 10080, "utilization": 91, "resetsAt": iso(T0) }],
        })));
        let after = codex_meters(Some(&json!({
            "ok": true,
            "windows": [{ "name": "7-day limit", "windowMinutes": 10080, "utilization": 12, "resetsAt": iso(T0) }],
        })));
        assert_eq!(before[0].id, after[0].id);
        assert_eq!(before[0].kind, "weekly");
    }

    #[test]
    fn window_start_comes_from_the_provider_reset_time() {
        let mut ledger = Ledger::new();
        ledger.record(&json!({ "claude": claude_snapshot(SnapOpts::default()) }), T0 + HOUR);
        let meter = session_meter(&ledger.snapshot(T0 + HOUR));
        assert_eq!(meter["current"]["startedAt"], json!(T0), "five hours before the reset");
        assert_eq!(meter["current"]["peakUtil"], json!(23.0));
        assert_eq!(meter["current"]["joinedLate"], json!(false));
        assert_eq!(meter["history"], json!([]));
    }

    #[test]
    fn climbing_utilization_updates_the_peak_without_opening_another_window() {
        let mut ledger = Ledger::new();
        ledger.record(&json!({ "claude": claude_snapshot(SnapOpts { session: 23.0, ..Default::default() }) }), T0 + HOUR);
        ledger.record(&json!({ "claude": claude_snapshot(SnapOpts { session: 61.0, ..Default::default() }) }), T0 + 2.0 * HOUR);
        ledger.record(&json!({ "claude": claude_snapshot(SnapOpts { session: 58.0, ..Default::default() }) }), T0 + 3.0 * HOUR);
        let meter = session_meter(&ledger.snapshot(T0 + 3.0 * HOUR));
        assert_eq!(meter["history"].as_array().unwrap().len(), 0);
        assert_eq!(meter["current"]["peakUtil"], json!(61.0), "the peak survives a lower later reading");
        assert!(meter["current"]["samples"].as_array().unwrap().len() >= 3);
    }

    #[test]
    fn a_new_reset_time_closes_the_finished_window_and_keeps_history() {
        let mut ledger = Ledger::new();
        ledger.record(&json!({ "claude": claude_snapshot(SnapOpts { session: 23.0, ..Default::default() }) }), T0 + HOUR);
        ledger.record(&json!({ "claude": claude_snapshot(SnapOpts { session: 97.0, ..Default::default() }) }), T0 + 4.0 * HOUR);
        let next = T0 + 10.0 * HOUR;
        ledger.record(
            &json!({ "claude": claude_snapshot(SnapOpts { session: 4.0, session_resets: next, ..Default::default() }) }),
            T0 + 5.5 * HOUR,
        );
        let meter = session_meter(&ledger.snapshot(T0 + 5.5 * HOUR));
        let history = meter["history"].as_array().unwrap();
        assert_eq!(history.len(), 1);
        assert_eq!(history[0]["peakUtil"], json!(97.0));
        assert_eq!(history[0]["startedAt"], json!(T0));
        assert_eq!(history[0]["endedAt"], json!(T0 + 5.0 * HOUR), "a window ends at its published reset time");
        assert_eq!(meter["current"]["peakUtil"], json!(4.0));
        assert_eq!(meter["current"]["startedAt"], json!(next - 5.0 * HOUR));
    }

    #[test]
    fn a_window_whose_reset_passed_is_reported_finished() {
        let mut ledger = Ledger::new();
        ledger.record(&json!({ "claude": claude_snapshot(SnapOpts { session: 88.0, ..Default::default() }) }), T0 + HOUR);
        let still_open = session_meter(&ledger.snapshot(T0 + 2.0 * HOUR));
        assert!(!still_open["current"].is_null());
        // Ember slept through the reset and no newer reading has arrived.
        let after_reset = session_meter(&ledger.snapshot(T0 + 6.0 * HOUR));
        assert!(after_reset["current"].is_null());
        let history = after_reset["history"].as_array().unwrap();
        assert_eq!(history.len(), 1);
        assert_eq!(history[0]["peakUtil"], json!(88.0));
    }

    #[test]
    fn readings_within_the_sampling_gap_replace_rather_than_flood() {
        let mut ledger = Ledger::new();
        for i in 0..12 {
            ledger.record(
                &json!({ "claude": claude_snapshot(SnapOpts { session: 10.0 + i as f64, ..Default::default() }) }),
                T0 + HOUR + i as f64 * 1000.0,
            );
        }
        let meter = session_meter(&ledger.snapshot(T0 + HOUR + 12000.0));
        let samples = meter["current"]["samples"].as_array().unwrap();
        assert_eq!(samples.len(), 1);
        assert_eq!(samples[0][1], json!(21.0));
        assert_eq!(meter["current"]["peakUtil"], json!(21.0));
    }

    #[test]
    fn both_providers_are_tracked_side_by_side() {
        let mut ledger = Ledger::new();
        ledger.record(
            &json!({
                "claude": claude_snapshot(SnapOpts { session: 30.0, ..Default::default() }),
                "codex": {
                    "ok": true,
                    "windows": [{ "name": "Weekly limit", "windowMinutes": 10080, "utilization": 91, "resetsAt": iso(T0 + 72.0 * HOUR) }],
                },
            }),
            T0 + HOUR,
        );
        let snapshot = ledger.snapshot(T0 + HOUR);
        let mut ids: Vec<String> = snapshot["meters"]
            .as_array()
            .unwrap()
            .iter()
            .map(|m| m["id"].as_str().unwrap().to_string())
            .collect();
        ids.sort();
        assert_eq!(ids, ["claude|session", "claude|weekly", "codex|10080"]);
    }

    #[test]
    fn label_keyed_meters_from_early_builds_are_dropped() {
        let dir = std::env::temp_dir().join(format!("ember-ledger-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let instance = json!({
            "startedAt": T0, "lastSeenAt": T0, "firstSeenAt": T0,
            "firstUtil": 5, "peakUtil": 5, "lastUtil": 5, "samples": []
        });
        std::fs::write(
            dir.join("quota-ledger.json"),
            serde_json::to_string(&json!({
                "v": 1,
                "meters": [
                    { "id": "codex|Weekly limit", "provider": "codex", "kind": "weekly", "label": "stale",
                      "windowMinutes": 0, "instances": [instance] },
                    { "id": "codex|10080", "provider": "codex", "kind": "weekly", "label": "Codex · Weekly limit",
                      "windowMinutes": 10080, "instances": [instance] },
                ],
            }))
            .unwrap(),
        )
        .unwrap();
        let ledger = Ledger::load(&dir);
        let snapshot = ledger.snapshot(T0 + 1000.0);
        let ids: Vec<&str> = snapshot["meters"]
            .as_array()
            .unwrap()
            .iter()
            .map(|m| m["id"].as_str().unwrap())
            .collect();
        assert_eq!(ids, ["codex|10080"]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn codex_rows_without_a_window_length_are_skipped() {
        let meters = codex_meters(Some(&json!({
            "ok": true,
            "windows": [{ "name": "Weekly limit", "utilization": 91 }],
        })));
        assert!(meters.is_empty());
    }
}
