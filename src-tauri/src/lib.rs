//! Ember — Tauri backend. Mirrors the behavior of the original Electron main
//! process: tray-resident frameless widget, debounced filesystem watchers,
//! serialized aggregation passes, plan-limit polling with backoff, and the
//! durable quota ledger.

pub mod providers;
pub mod settings;
pub mod signature;

use providers::{
    claude_limits, claude_pricing_live, claude_usage, codex_limits, codex_pricing_live,
    codex_usage, model_attribution::is_first_party_model, normalize, opencode_usage,
    quota_ledger::Ledger,
};
use serde_json::{json, Value};
use settings::Settings;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Listener, Manager, WebviewUrl, WebviewWindowBuilder, Wry};
use tauri_plugin_autostart::ManagerExt as AutostartManagerExt;
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_notification::NotificationExt;
use tokio::sync::mpsc;

const WATCH_DEBOUNCE_MS: u64 = 110;
// A long streaming write never goes quiet, so this bounds how long a burst can
// run before publishing anyway — the ceiling on how stale a live number gets.
const WATCH_MAX_WAIT_MS: u64 = 380;
// An unchanged pass costs a stat sweep rather than a full rebuild, which is
// what makes reconciling this often affordable.
const RECONCILE_INTERVAL_MS: u64 = 8 * 1000;
// The account endpoint rate-limits hard, so polls stay spaced even when usage
// is pouring in; the periodic poll below is the floor, this is the ceiling.
const CLAUDE_MIN_POLL_MS: f64 = 90.0 * 1000.0;
const CLAUDE_CATCH_UP_MS: u64 = 25 * 1000;

/* ---------------- small JS-parity helpers ---------------- */

pub fn now_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as f64)
        .unwrap_or(0.0)
}

/// Format a float the way JS `String(number)` does for the integers that
/// appear in dedup keys and signatures: no trailing ".0".
pub fn js_num(v: f64) -> String {
    if v.is_finite() && v.fract() == 0.0 && v.abs() < 1e15 {
        format!("{}", v as i64)
    } else {
        format!("{v}")
    }
}

/// JS truthiness for JSON values: null/false/0/NaN/"" are falsy.
pub fn js_truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().map_or(false, |f| f != 0.0 && !f.is_nan()),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

pub struct LocalParts {
    pub date: String,
    pub hour: u32,
    pub minute: u32,
}

/// Epoch milliseconds for an ISO-8601 timestamp; naive strings read as local
/// time, matching the JS Date constructor.
pub fn parse_ts_ms(ts: &str) -> Option<f64> {
    if ts.is_empty() {
        return None;
    }
    if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(ts) {
        return Some(dt.timestamp_millis() as f64);
    }
    let naive = chrono::NaiveDateTime::parse_from_str(ts, "%Y-%m-%dT%H:%M:%S%.f").ok()?;
    let local = chrono::TimeZone::from_local_datetime(&chrono::Local, &naive).single()?;
    Some(local.timestamp_millis() as f64)
}

fn local_parts_of(dt: chrono::DateTime<chrono::Local>) -> LocalParts {
    use chrono::{Datelike, Timelike};
    LocalParts {
        date: format!("{:04}-{:02}-{:02}", dt.year(), dt.month(), dt.day()),
        hour: dt.hour(),
        minute: dt.minute(),
    }
}

pub fn local_parts(ts: &str) -> Option<LocalParts> {
    let ms = parse_ts_ms(ts)?;
    local_parts_ms(ms)
}

pub fn local_parts_ms(ms: f64) -> Option<LocalParts> {
    if !ms.is_finite() {
        return None;
    }
    let dt = chrono::TimeZone::timestamp_millis_opt(&chrono::Local, ms as i64).single()?;
    Some(local_parts_of(dt))
}

fn is_ok(v: &Value) -> bool {
    v.get("ok").and_then(|b| b.as_bool()) == Some(true)
}

/* ---------------- app state ---------------- */

struct ClaudeLimitsState {
    last: Option<Value>,
    last_good: Option<Value>,
    backoff_until: f64,
    last_forced_at: f64,
    last_poll_at: f64,
}

struct CodexLimitsCell {
    last: Option<Value>,
    last_sig: String,
}

struct TrayHandles {
    pin: CheckMenuItem<Wry>,
    autostart: CheckMenuItem<Wry>,
    mini: CheckMenuItem<Wry>,
}

pub struct EmberState {
    user_data: PathBuf,
    settings: Mutex<Settings>,
    ledger: Mutex<Ledger>,
    claude: Mutex<ClaudeLimitsState>,
    codex: Mutex<CodexLimitsCell>,
    last_sig: Mutex<String>,
    revision: AtomicU64,
    update_tx: mpsc::UnboundedSender<bool>,
    watch_tx: mpsc::UnboundedSender<()>,
    bounds_tx: mpsc::UnboundedSender<()>,
    http: reqwest::Client,
    quitting: AtomicBool,
    catch_up_pending: AtomicBool,
    tray: Mutex<Option<TrayHandles>>,
}

static AGG_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/* ---------------- data migration ---------------- */

/// Carry-over from the Electron builds ("Ember", and before that
/// "ai-usage-widget"): settings, parsed-usage caches, limits caches, the quota
/// ledger and pricing caches move into the Tauri data dir so history —
/// including records of already-deleted logs — survives the migration.
fn migrate_legacy_data(user_data: &std::path::Path) {
    let carry = [
        "settings.json",
        "claude-usage-cache.json",
        "codex-usage-cache.json",
        "opencode-usage-cache.json",
        "claude-limits-cache.json",
        "codex-limits-cache.json",
        "quota-ledger.json",
        "pricing-live.json",
        "openai-pricing.json",
        "anthropic-pricing.json",
    ];
    let Some(roaming) = user_data.parent() else { return };
    for legacy_name in ["Ember", "ai-usage-widget"] {
        let legacy = roaming.join(legacy_name);
        if !legacy.exists() {
            continue;
        }
        for file in carry {
            let src = legacy.join(file);
            let dst = user_data.join(file);
            if src.exists() && !dst.exists() {
                let _ = std::fs::copy(&src, &dst);
            }
        }
    }
}

/* ---------------- aggregation + publishing ---------------- */

async fn aggregate_all(state: &EmberState) -> Value {
    // IPC bootstrap, watcher events, pricing callbacks, and manual refreshes
    // can arrive together; the lock keeps provider caches from being walked
    // concurrently, and each pass re-stats the logs so it always reflects
    // every event that preceded it.
    let _guard = AGG_LOCK.lock().await;
    let revision = state.revision.fetch_add(1, Ordering::SeqCst) + 1;
    let (claude, codex, opencode) = tokio::join!(
        tokio::task::spawn_blocking(claude_usage::aggregate),
        tokio::task::spawn_blocking(codex_usage::aggregate),
        opencode_usage::aggregate(),
    );
    let claude = claude.expect("claude aggregation panicked");
    let codex = codex.expect("codex aggregation panicked");

    // Claude-shaped compatibility transcripts can contain arbitrary gateway
    // models. Ember is a Claude + Codex ledger, so keep only first-party IDs.
    let mut buckets = Vec::new();
    for b in &claude.buckets {
        if is_first_party_model(&b.model) {
            buckets.push(normalize::normalize_claude(b));
        }
    }
    for b in &codex.buckets {
        if is_first_party_model(&b.model) {
            buckets.push(normalize::normalize_codex(b));
        }
    }
    for b in &opencode.buckets {
        if is_first_party_model(&b.model) {
            buckets.push(normalize::normalize_codex(b));
        }
    }

    json!({
        "buckets": buckets,
        "generatedAt": now_ms(),
        "revision": revision,
        "fileCount": claude.file_count + codex.file_count + opencode.file_count,
        // newest rate-limit state from the Codex logs
        "codexLimitsSnapshot": codex.limits,
        "pricing": {
            "openai": codex_pricing_live::status(),
            "anthropic": claude_pricing_live::status(),
        },
    })
}

async fn publish_update(app: &AppHandle, force: bool) {
    let state = app.state::<EmberState>();
    let data = aggregate_all(&state).await;
    let snapshot = data.get("codexLimitsSnapshot").cloned().unwrap_or(Value::Null);
    let sig = signature::update_signature(&data);
    let changed = {
        let mut last = state.last_sig.lock().unwrap();
        let changed = sig != *last;
        if force || changed {
            *last = sig;
        }
        changed
    };
    if force || changed {
        let _ = app.emit("usage:update", &data);
        if changed {
            schedule_claude_catch_up(app);
        }
    } else {
        let _ = app.emit("usage:heartbeat", now_ms());
    }
    push_codex_limits(app, &snapshot);
}

fn request_update(state: &EmberState, force: bool) {
    let _ = state.update_tx.send(force);
}

/* ---------------- plan limits ---------------- */

fn current_limits(state: &EmberState) -> Value {
    let claude = state.claude.lock().unwrap().last.clone().unwrap_or(Value::Null);
    let codex = state.codex.lock().unwrap().last.clone().unwrap_or(Value::Null);
    json!({ "claude": claude, "codex": codex })
}

fn record_ledger(app: &AppHandle) {
    let state = app.state::<EmberState>();
    let payload = current_limits(&state);
    let mut ledger = state.ledger.lock().unwrap();
    // Every reading is written to the durable quota history, so a window that
    // closes while Ember is running is never lost.
    if ledger.record(&payload, now_ms()) {
        ledger.persist(&state.user_data);
    }
}

fn send_limits(app: &AppHandle) {
    let state = app.state::<EmberState>();
    let payload = current_limits(&state);
    let snapshot = {
        let mut ledger = state.ledger.lock().unwrap();
        if ledger.record(&payload, now_ms()) {
            ledger.persist(&state.user_data);
        }
        ledger.snapshot(now_ms())
    };
    let _ = app.emit("limits:update", &payload);
    let _ = app.emit("quota:update", &snapshot);
}

/// New usage moves the plan meters, so the headroom bars and the quota rate
/// would otherwise lag the burn by up to five minutes. One catch-up poll after
/// a burst settles keeps them current without a faster polling loop.
fn schedule_claude_catch_up(app: &AppHandle) {
    let state = app.state::<EmberState>();
    if state.catch_up_pending.swap(true, Ordering::SeqCst) {
        return;
    }
    let recently_polled =
        now_ms() - state.claude.lock().unwrap().last_poll_at < CLAUDE_MIN_POLL_MS;
    if recently_polled {
        state.catch_up_pending.store(false, Ordering::SeqCst);
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(CLAUDE_CATCH_UP_MS)).await;
        app.state::<EmberState>().catch_up_pending.store(false, Ordering::SeqCst);
        push_claude_limits(&app, false).await;
    });
}

async fn push_claude_limits(app: &AppHandle, force: bool) {
    let state = app.state::<EmberState>();
    {
        let mut cl = state.claude.lock().unwrap();
        let now = now_ms();
        if !force && now < cl.backoff_until {
            return;
        }
        if force {
            // protect the strict endpoint from refresh-button spam
            if now - cl.last_forced_at < 60.0 * 1000.0 {
                return;
            }
            cl.last_forced_at = now;
        } else if now - cl.last_poll_at < CLAUDE_MIN_POLL_MS {
            return;
        }
        cl.last_poll_at = now;
    }
    let res = claude_limits::fetch_plan_limits(&state.http).await;
    {
        let mut cl = state.claude.lock().unwrap();
        if is_ok(&res) {
            cl.last_good = Some(res.clone());
            cl.last = Some(res.clone());
            cl.backoff_until = 0.0;
            claude_limits::save_cached(&res);
        } else {
            // honor Retry-After and keep serving the last good snapshot;
            // countdowns keep ticking client-side
            if res.get("reason").and_then(|r| r.as_str()) == Some("http-429") {
                let retry = res.get("retryAfter").and_then(|v| v.as_f64()).unwrap_or(0.0);
                cl.backoff_until = now_ms() + (retry * 1000.0).max(10.0 * 60.0 * 1000.0);
            }
            cl.last = match &cl.last_good {
                Some(good) => {
                    let mut stale = good.clone();
                    stale["stale"] = json!(true);
                    stale["lastError"] = res.get("reason").cloned().unwrap_or(Value::Null);
                    Some(stale)
                }
                None => Some(res),
            };
        }
    }
    send_limits(app);
}

fn push_codex_limits(app: &AppHandle, snapshot: &Value) {
    let state = app.state::<EmberState>();
    let snap: Option<codex_usage::LimitsSnap> = serde_json::from_value(snapshot.clone()).ok();
    let native = codex_limits::from_snapshot(snap.as_ref());
    let claudex = codex_limits::load_claudex();
    let mut l = codex_limits::newest(Some(native), Some(claudex)).unwrap_or(Value::Null);
    let changed = {
        let mut cx = state.codex.lock().unwrap();
        if is_ok(&l) {
            codex_limits::save_cached(&l);
        } else if let Some(last) = &cx.last {
            // native rollout history can outlive a temporarily unavailable scan
            if is_ok(last) && last.get("source").and_then(|s| s.as_str()) != Some("claudex") {
                l = last.clone();
            }
        }
        let fetched_at = l.get("fetchedAt").and_then(|v| v.as_f64()).unwrap_or(0.0);
        if is_ok(&l) && now_ms() - fetched_at > 30.0 * 60.0 * 1000.0 {
            l["stale"] = json!(true);
        }
        let sig = serde_json::to_string(&json!([
            l.get("ok"), l.get("fetchedAt"), l.get("stale"), l.get("reason"),
            l.get("plan"), l.get("windows"), l.get("source"),
        ]))
        .unwrap_or_default();
        cx.last = Some(l);
        if sig != cx.last_sig {
            cx.last_sig = sig;
            true
        } else {
            false
        }
    };
    if changed {
        send_limits(app);
    } else {
        // The renderer is already showing this state, but the ledger still
        // wants the reading — it is how an unchanged window keeps proving it
        // is open.
        record_ledger(app);
    }
}

/* ---------------- window + tray ---------------- */

#[cfg(windows)]
fn apply_windows_effects(window: &tauri::WebviewWindow) {
    use windows_sys::Win32::Graphics::Dwm::DwmSetWindowAttribute;
    let Ok(hwnd) = window.hwnd() else { return };
    let hwnd = hwnd.0;
    unsafe {
        // keep the acrylic tint dark on any system theme
        let dark: i32 = 1;
        DwmSetWindowAttribute(hwnd as _, 20, &dark as *const _ as _, 4); // DWMWA_USE_IMMERSIVE_DARK_MODE
        let corner: i32 = 2; // DWMWCP_ROUND
        DwmSetWindowAttribute(hwnd as _, 33, &corner as *const _ as _, 4); // DWMWA_WINDOW_CORNER_PREFERENCE
        let backdrop: i32 = 3; // DWMSBT_TRANSIENTWINDOW: real acrylic (Windows 11 22H2+)
        DwmSetWindowAttribute(hwnd as _, 38, &backdrop as *const _ as _, 4); // DWMWA_SYSTEMBACKDROP_TYPE
    }
}

#[cfg(not(windows))]
fn apply_windows_effects(_window: &tauri::WebviewWindow) {}

fn clamped_position(app: &AppHandle, bounds: &settings::Bounds) -> Option<(f64, f64)> {
    let (x, y) = (bounds.x?, bounds.y?);
    let monitors = app.available_monitors().ok()?;
    let visible = monitors.iter().any(|m| {
        let scale = m.scale_factor();
        let pos = m.position();
        let size = m.size();
        let (ax, ay) = (pos.x as f64 / scale, pos.y as f64 / scale);
        let (aw, ah) = (size.width as f64 / scale, size.height as f64 / scale);
        x >= ax - 50.0 && y >= ay - 50.0 && x < ax + aw && y < ay + ah
    });
    if visible { Some((x, y)) } else { None }
}

fn create_window(app: &AppHandle) -> tauri::Result<tauri::WebviewWindow> {
    let state = app.state::<EmberState>();
    let (bounds, min, always_on_top) = {
        let s = state.settings.lock().unwrap();
        (s.mode_bounds(), s.mode_minimum(), s.always_on_top)
    };
    let mut builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
        .title("Ember")
        .inner_size(bounds.width.max(min.0), bounds.height.max(min.1))
        .min_inner_size(min.0, min.1)
        .resizable(true)
        .decorations(false)
        .transparent(true)
        .skip_taskbar(true)
        .always_on_top(always_on_top)
        .theme(Some(tauri::Theme::Dark));
    if let Some((x, y)) = clamped_position(app, &bounds) {
        builder = builder.position(x, y);
    }
    let window = builder.build()?;
    apply_windows_effects(&window);

    let bounds_tx = state.bounds_tx.clone();
    let app_handle = app.clone();
    window.on_window_event(move |event| match event {
        tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_) => {
            let _ = bounds_tx.send(());
        }
        // Closing the window (X / Alt+F4) keeps the app alive in the tray,
        // like Discord/Zoom. Real quit comes from the tray menu.
        tauri::WindowEvent::CloseRequested { api, .. } => {
            let state = app_handle.state::<EmberState>();
            if !state.quitting.load(Ordering::SeqCst) {
                api.prevent_close();
                hide_to_tray(&app_handle);
            }
        }
        _ => {}
    });
    Ok(window)
}

fn show_window(app: &AppHandle) {
    match app.get_webview_window("main") {
        Some(window) => {
            let _ = window.show();
            let _ = window.set_focus();
        }
        None => {
            let _ = create_window(app);
        }
    }
}

fn hide_to_tray(app: &AppHandle) {
    let state = app.state::<EmberState>();
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
    let show_tip = {
        let mut s = state.settings.lock().unwrap();
        if s.tray_tip_shown {
            false
        } else {
            s.tray_tip_shown = true;
            settings::save(&state.user_data, &s);
            true
        }
    };
    if show_tip {
        let _ = app
            .notification()
            .builder()
            .title("Ember")
            .body("Still burning here in the tray. Double-click the flame to reopen, right-click to quit.")
            .show();
    }
}

fn public_settings(state: &EmberState) -> Value {
    let s = state.settings.lock().unwrap();
    json!({
        "alwaysOnTop": s.always_on_top,
        "launchAtStartup": s.launch_at_startup,
        "miniMode": s.mini_mode,
    })
}

fn sync_tray(app: &AppHandle) {
    let state = app.state::<EmberState>();
    let s = state.settings.lock().unwrap();
    let tray = state.tray.lock().unwrap();
    if let Some(handles) = tray.as_ref() {
        let _ = handles.pin.set_checked(s.always_on_top);
        let _ = handles.autostart.set_checked(s.launch_at_startup);
        let _ = handles.mini.set_checked(s.mini_mode);
    }
}

fn emit_settings(app: &AppHandle) {
    let state = app.state::<EmberState>();
    let _ = app.emit("settings:update", public_settings(&state));
}

fn apply_autostart(app: &AppHandle) {
    // Only the installed build registers autostart — a dev run would otherwise
    // leave a stale Run entry pointing at a debug binary.
    if cfg!(debug_assertions) {
        return;
    }
    let state = app.state::<EmberState>();
    let enabled = state.settings.lock().unwrap().launch_at_startup;
    let manager = app.autolaunch();
    if enabled {
        let _ = manager.enable();
    } else {
        let _ = manager.disable();
    }
}

fn set_pin(app: &AppHandle, value: bool) {
    let state = app.state::<EmberState>();
    {
        let mut s = state.settings.lock().unwrap();
        s.always_on_top = value;
        settings::save(&state.user_data, &s);
    }
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_always_on_top(value);
    }
    sync_tray(app);
    emit_settings(app);
}

fn set_autostart_setting(app: &AppHandle, value: bool) {
    let state = app.state::<EmberState>();
    {
        let mut s = state.settings.lock().unwrap();
        s.launch_at_startup = value;
        settings::save(&state.user_data, &s);
    }
    apply_autostart(app);
    sync_tray(app);
    emit_settings(app);
}

fn window_logical_bounds(window: &tauri::WebviewWindow) -> Option<settings::Bounds> {
    let scale = window.scale_factor().ok()?;
    let pos = window.outer_position().ok()?.to_logical::<f64>(scale);
    let size = window.outer_size().ok()?.to_logical::<f64>(scale);
    Some(settings::Bounds {
        width: size.width,
        height: size.height,
        x: Some(pos.x),
        y: Some(pos.y),
    })
}

fn set_mini_mode(app: &AppHandle, value: bool) {
    let state = app.state::<EmberState>();
    {
        let mut s = state.settings.lock().unwrap();
        if s.mini_mode == value {
            return;
        }
        match app.get_webview_window("main") {
            Some(window) => {
                // Bank the size of the mode being left before the switch
                // resizes it.
                if let Some(from) = window_logical_bounds(&window) {
                    if value {
                        s.bounds = from;
                    } else {
                        s.mini_bounds = from;
                    }
                }
                s.mini_mode = value;
                let target = s.mode_bounds();
                let min = s.mode_minimum();
                let _ = window.set_min_size(Some(tauri::LogicalSize::new(min.0, min.1)));
                let _ = window.set_size(tauri::LogicalSize::new(
                    target.width.max(min.0),
                    target.height.max(min.1),
                ));
            }
            None => {
                s.mini_mode = value;
            }
        }
        settings::save(&state.user_data, &s);
    }
    sync_tray(app);
    emit_settings(app);
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Show widget", true, None::<&str>)?;
    let hide = MenuItem::with_id(app, "hide", "Hide widget", true, None::<&str>)?;
    let state = app.state::<EmberState>();
    let (pin_checked, autostart_checked, mini_checked) = {
        let s = state.settings.lock().unwrap();
        (s.always_on_top, s.launch_at_startup, s.mini_mode)
    };
    let pin = CheckMenuItem::with_id(app, "pin", "Always on top", true, pin_checked, None::<&str>)?;
    let autostart =
        CheckMenuItem::with_id(app, "autostart", "Launch at startup", true, autostart_checked, None::<&str>)?;
    let mini = CheckMenuItem::with_id(app, "mini", "Compact mode", true, mini_checked, None::<&str>)?;
    let refresh = MenuItem::with_id(app, "refresh", "Refresh data", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &show,
            &hide,
            &PredefinedMenuItem::separator(app)?,
            &pin,
            &autostart,
            &mini,
            &PredefinedMenuItem::separator(app)?,
            &refresh,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;
    *state.tray.lock().unwrap() = Some(TrayHandles {
        pin: pin.clone(),
        autostart: autostart.clone(),
        mini: mini.clone(),
    });

    let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/tray.png"))?;
    TrayIconBuilder::with_id("ember-tray")
        .icon(icon)
        .tooltip("Ember — Claude + Codex usage")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, event| match event.id.as_ref() {
            "show" => show_window(app),
            "hide" => hide_to_tray(app),
            "pin" => {
                let state = app.state::<EmberState>();
                let checked = state
                    .tray
                    .lock()
                    .unwrap()
                    .as_ref()
                    .map(|t| t.pin.is_checked().unwrap_or(false))
                    .unwrap_or(false);
                set_pin(app, checked);
            }
            "autostart" => {
                let state = app.state::<EmberState>();
                let checked = state
                    .tray
                    .lock()
                    .unwrap()
                    .as_ref()
                    .map(|t| t.autostart.is_checked().unwrap_or(false))
                    .unwrap_or(false);
                set_autostart_setting(app, checked);
            }
            "mini" => {
                let state = app.state::<EmberState>();
                let checked = state
                    .tray
                    .lock()
                    .unwrap()
                    .as_ref()
                    .map(|t| t.mini.is_checked().unwrap_or(false))
                    .unwrap_or(false);
                set_mini_mode(app, checked);
                show_window(app);
            }
            "refresh" => {
                let state = app.state::<EmberState>();
                request_update(&state, true);
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    push_claude_limits(&app, true).await;
                });
            }
            "quit" => {
                let state = app.state::<EmberState>();
                state.quitting.store(true, Ordering::SeqCst);
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            use tauri::tray::TrayIconEvent;
            match event {
                TrayIconEvent::Click { button: tauri::tray::MouseButton::Left, .. }
                | TrayIconEvent::DoubleClick { .. } => show_window(tray.app_handle()),
                _ => {}
            }
        })
        .build(app)?;
    Ok(())
}

/* ---------------- background workers ---------------- */

async fn update_worker(app: AppHandle, mut rx: mpsc::UnboundedReceiver<bool>) {
    while let Some(mut force) = rx.recv().await {
        // One pass is enough for any burst, but remember whether any caller
        // required a forced renderer/pricing update.
        while let Ok(next) = rx.try_recv() {
            force = force || next;
        }
        publish_update(&app, force).await;
    }
}

async fn watch_debouncer(app: AppHandle, mut rx: mpsc::UnboundedReceiver<()>) {
    loop {
        if rx.recv().await.is_none() {
            return;
        }
        // Quiet-period debounce with a hard ceiling, so a continuously
        // appended log still publishes fresh data at a steady cadence.
        let max_deadline = tokio::time::Instant::now() + Duration::from_millis(WATCH_MAX_WAIT_MS);
        loop {
            let now = tokio::time::Instant::now();
            if now >= max_deadline {
                break;
            }
            let quiet = Duration::from_millis(WATCH_DEBOUNCE_MS).min(max_deadline - now);
            match tokio::time::timeout(quiet, rx.recv()).await {
                Ok(Some(())) => continue,
                Ok(None) => return,
                Err(_) => break, // quiet period elapsed
            }
        }
        let state = app.state::<EmberState>();
        request_update(&state, false);
    }
}

async fn bounds_worker(app: AppHandle, mut rx: mpsc::UnboundedReceiver<()>) {
    loop {
        if rx.recv().await.is_none() {
            return;
        }
        loop {
            match tokio::time::timeout(Duration::from_millis(400), rx.recv()).await {
                Ok(Some(())) => continue,
                Ok(None) => return,
                Err(_) => break,
            }
        }
        let state = app.state::<EmberState>();
        if let Some(window) = app.get_webview_window("main") {
            if let Some(bounds) = window_logical_bounds(&window) {
                let mut s = state.settings.lock().unwrap();
                if s.mini_mode {
                    s.mini_bounds = bounds;
                } else {
                    s.bounds = bounds;
                }
                settings::save(&state.user_data, &s);
            }
        }
    }
}

fn usage_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    for dir in claude_usage::projects_dirs() {
        if !dirs.contains(&dir) {
            dirs.push(dir);
        }
    }
    for dir in codex_usage::session_dirs() {
        if !dirs.contains(&dir) {
            dirs.push(dir);
        }
    }
    for dir in [opencode_usage::data_dir(), codex_limits::claudex_usage_dir()] {
        if !dirs.contains(&dir) {
            dirs.push(dir);
        }
    }
    dirs
}

fn start_watchers(app: &AppHandle) {
    use notify::Watcher;
    let state = app.state::<EmberState>();
    let watch_tx = state.watch_tx.clone();
    let dirs = usage_dirs();
    let mut watchers: std::collections::HashMap<PathBuf, notify::RecommendedWatcher> =
        std::collections::HashMap::new();

    let attach = move |watchers: &mut std::collections::HashMap<PathBuf, notify::RecommendedWatcher>,
                           dir: &PathBuf,
                           tx: &mpsc::UnboundedSender<()>| {
        if watchers.contains_key(dir) || !dir.exists() {
            return;
        }
        let tx = tx.clone();
        match notify::recommended_watcher(move |result: Result<notify::Event, notify::Error>| {
            if result.is_ok() {
                let _ = tx.send(());
            }
        }) {
            Ok(mut watcher) => {
                if watcher.watch(dir, notify::RecursiveMode::Recursive).is_ok() {
                    watchers.insert(dir.clone(), watcher);
                } else {
                    eprintln!("fs watch failed for {}, retrying during reconciliation", dir.display());
                }
            }
            Err(err) => {
                eprintln!("fs watch failed for {}: {err}", dir.display());
            }
        }
    };

    for dir in &dirs {
        attach(&mut watchers, dir, &watch_tx);
    }

    // The watcher provides the live path. This slower pass reconciles missed
    // or unavailable watcher events without walking every log cache once a
    // second. It also picks up directories created after startup.
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_millis(RECONCILE_INTERVAL_MS));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            interval.tick().await;
            watchers.retain(|dir, _| dir.exists());
            for dir in &dirs {
                attach(&mut watchers, dir, &watch_tx);
            }
            let state = app.state::<EmberState>();
            request_update(&state, false);
        }
    });
}

/* ---------------- IPC commands ---------------- */

#[tauri::command]
async fn get_usage(app: AppHandle) -> Value {
    let data = {
        let state = app.state::<EmberState>();
        aggregate_all(&state).await
    };
    let snapshot = data.get("codexLimitsSnapshot").cloned().unwrap_or(Value::Null);
    push_codex_limits(&app, &snapshot);
    data
}

#[tauri::command]
fn get_limits(state: tauri::State<'_, EmberState>) -> Value {
    current_limits(&state)
}

#[tauri::command]
fn get_quota(app: AppHandle) -> Value {
    record_ledger(&app);
    let state = app.state::<EmberState>();
    let ledger = state.ledger.lock().unwrap();
    ledger.snapshot(now_ms())
}

#[tauri::command]
fn get_settings(state: tauri::State<'_, EmberState>) -> Value {
    public_settings(&state)
}

#[tauri::command]
fn get_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}

#[tauri::command]
fn win_hide(app: AppHandle) {
    hide_to_tray(&app);
}

#[tauri::command]
fn win_close(app: AppHandle) {
    hide_to_tray(&app);
}

#[tauri::command]
fn win_pin(app: AppHandle, value: bool) {
    set_pin(&app, value);
}

#[tauri::command]
fn win_mini(app: AppHandle, value: bool) {
    set_mini_mode(&app, value);
}

#[tauri::command]
fn app_autostart(app: AppHandle, value: bool) {
    set_autostart_setting(&app, value);
}

#[tauri::command]
fn win_drag(window: tauri::WebviewWindow) {
    let _ = window.start_dragging();
}

#[tauri::command]
fn usage_refresh(app: AppHandle) {
    // An explicit refresh rebuilds from the caches rather than trusting the
    // memo — it is the one action that should never be a no-op.
    claude_usage::invalidate();
    codex_usage::invalidate();
    opencode_usage::invalidate();
    let state = app.state::<EmberState>();
    request_update(&state, true);
    tauri::async_runtime::spawn(async move {
        push_claude_limits(&app, true).await;
    });
}

/* Export stays a backend job: the renderer composes the text, the user picks
   the destination, and nothing leaves the machine on its own. */

#[tauri::command]
async fn export_save(app: AppHandle, payload: Value) -> Value {
    let content = payload.get("content").and_then(|v| v.as_str()).unwrap_or("");
    if content.is_empty() {
        return json!({ "ok": false, "reason": "empty" });
    }
    let content = content.to_string();
    let format = payload
        .get("format")
        .and_then(|v| v.as_str())
        .unwrap_or("csv")
        .to_string();
    let suggested = payload
        .get("suggestedName")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .unwrap_or("ember-usage.csv")
        .to_string();

    let dialog_app = app.clone();
    let dialog_format = format.clone();
    let picked = tokio::task::spawn_blocking(move || {
        let mut builder = dialog_app
            .dialog()
            .file()
            .set_title("Export Ember usage")
            .set_file_name(&suggested);
        if let Ok(documents) = dialog_app.path().document_dir() {
            builder = builder.set_directory(documents);
        }
        builder = match dialog_format.as_str() {
            "json" => builder.add_filter("JSON", &["json"]),
            "md" => builder.add_filter("Markdown", &["md"]),
            _ => builder.add_filter("CSV spreadsheet", &["csv"]),
        };
        builder.blocking_save_file()
    })
    .await
    .ok()
    .flatten();

    let Some(file_path) = picked else {
        return json!({ "ok": false, "reason": "canceled" });
    };
    let Some(path) = file_path.as_path().map(|p| p.to_path_buf()) else {
        return json!({ "ok": false, "reason": "canceled" });
    };
    // A byte-order mark keeps Excel from mangling the ° and · characters.
    let body = if format == "csv" { format!("\u{feff}{content}") } else { content };
    match std::fs::write(&path, body) {
        Ok(()) => json!({
            "ok": true,
            "path": path.to_string_lossy(),
            "name": path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
        }),
        Err(err) => {
            eprintln!("export failed: {err}");
            json!({ "ok": false, "reason": "write-failed" })
        }
    }
}

#[tauri::command]
fn export_reveal(path: String) {
    if !path.is_empty() {
        let _ = tauri_plugin_opener::reveal_item_in_dir(path);
    }
}

#[tauri::command]
fn clipboard_write(app: AppHandle, text: String) -> bool {
    let _ = app.clipboard().write_text(text);
    true
}

/* ---------------- bootstrap ---------------- */

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_window(app);
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .invoke_handler(tauri::generate_handler![
            get_usage,
            get_limits,
            get_quota,
            get_settings,
            get_version,
            win_hide,
            win_close,
            win_pin,
            win_mini,
            win_drag,
            app_autostart,
            usage_refresh,
            export_save,
            export_reveal,
            clipboard_write,
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            let user_data = handle.path().app_data_dir()?;
            std::fs::create_dir_all(&user_data)?;
            migrate_legacy_data(&user_data);

            let loaded_settings = settings::load(&user_data);
            claude_usage::init(&user_data);
            claude_limits::init(&user_data);
            codex_usage::init(&user_data);
            opencode_usage::init(&user_data);
            codex_limits::init(&user_data);
            claude_pricing_live::init(&user_data);
            codex_pricing_live::init(&user_data);
            let ledger = Ledger::load(&user_data);

            // Cached limits keep the cards warm before the first live reading.
            let last_good_claude = claude_limits::load_cached();
            let last_claude = last_good_claude.clone().map(|mut v| {
                v["stale"] = json!(true);
                v
            });
            let cached_codex = codex_limits::load_cached();
            let live_claudex = codex_limits::load_claudex();
            let mut last_codex = if is_ok(&live_claudex) {
                codex_limits::newest(cached_codex, Some(live_claudex))
            } else {
                cached_codex.filter(|c| c.get("source").and_then(|s| s.as_str()) != Some("claudex"))
            };
            if let Some(l) = &mut last_codex {
                let fetched_at = l.get("fetchedAt").and_then(|v| v.as_f64()).unwrap_or(0.0);
                if now_ms() - fetched_at > 30.0 * 60.0 * 1000.0 {
                    l["stale"] = json!(true);
                }
            }
            let cache_fresh = last_good_claude
                .as_ref()
                .and_then(|v| v.get("fetchedAt"))
                .and_then(|v| v.as_f64())
                .map(|at| now_ms() - at < 4.0 * 60.0 * 1000.0)
                .unwrap_or(false);

            let (update_tx, update_rx) = mpsc::unbounded_channel::<bool>();
            let (watch_tx, watch_rx) = mpsc::unbounded_channel::<()>();
            let (bounds_tx, bounds_rx) = mpsc::unbounded_channel::<()>();

            let first_run = loaded_settings.first_run;
            app.manage(EmberState {
                user_data: user_data.clone(),
                settings: Mutex::new(loaded_settings),
                ledger: Mutex::new(ledger),
                claude: Mutex::new(ClaudeLimitsState {
                    last: last_claude,
                    last_good: last_good_claude,
                    backoff_until: 0.0,
                    last_forced_at: 0.0,
                    last_poll_at: 0.0,
                }),
                codex: Mutex::new(CodexLimitsCell { last: last_codex, last_sig: String::new() }),
                last_sig: Mutex::new(String::new()),
                revision: AtomicU64::new(0),
                update_tx,
                watch_tx,
                bounds_tx,
                http: reqwest::Client::new(),
                quitting: AtomicBool::new(false),
                catch_up_pending: AtomicBool::new(false),
                tray: Mutex::new(None),
            });

            if first_run {
                let state = handle.state::<EmberState>();
                let mut s = state.settings.lock().unwrap();
                s.first_run = false;
                settings::save(&user_data, &s);
                drop(s);
            }
            apply_autostart(&handle); // default ON for first run

            build_tray(&handle)?;
            create_window(&handle)?;
            start_watchers(&handle);

            tauri::async_runtime::spawn(update_worker(handle.clone(), update_rx));
            tauri::async_runtime::spawn(watch_debouncer(handle.clone(), watch_rx));
            tauri::async_runtime::spawn(bounds_worker(handle.clone(), bounds_rx));

            // Claude plan-limit polling: a fresh-enough snapshot from the last
            // run means startup costs no request; the periodic poll stays
            // gentle because the endpoint 429s easily.
            if !cache_fresh {
                let app = handle.clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(Duration::from_secs(2)).await;
                    push_claude_limits(&app, false).await;
                });
            }
            {
                let app = handle.clone();
                tauri::async_runtime::spawn(async move {
                    let mut interval = tokio::time::interval(Duration::from_secs(5 * 60));
                    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
                    interval.tick().await; // immediate first tick — skip it
                    loop {
                        interval.tick().await;
                        push_claude_limits(&app, false).await;
                    }
                });
            }

            // Fresh prices change costs without touching a single log, so the
            // cached aggregation is discarded before the re-push (token totals
            // are unchanged, hence the force).
            {
                let app = handle.clone();
                tauri::async_runtime::spawn(async move {
                    let http = app.state::<EmberState>().http.clone();
                    loop {
                        let fresh = claude_pricing_live::is_fresh();
                        let ok = fresh || claude_pricing_live::refresh(&http).await;
                        if !fresh && ok {
                            claude_usage::invalidate();
                            codex_usage::invalidate();
                            opencode_usage::invalidate();
                            request_update(&app.state::<EmberState>(), true);
                        }
                        tokio::time::sleep(if ok { claude_pricing_live::REFRESH } else { claude_pricing_live::RETRY }).await;
                    }
                });
            }
            {
                let app = handle.clone();
                tauri::async_runtime::spawn(async move {
                    let http = app.state::<EmberState>().http.clone();
                    loop {
                        let fresh = codex_pricing_live::is_fresh();
                        let ok = fresh || codex_pricing_live::refresh(&http).await;
                        if !fresh && ok {
                            claude_usage::invalidate();
                            codex_usage::invalidate();
                            opencode_usage::invalidate();
                            request_update(&app.state::<EmberState>(), true);
                        }
                        tokio::time::sleep(if ok { codex_pricing_live::REFRESH } else { codex_pricing_live::RETRY }).await;
                    }
                });
            }

            let _ = handle.listen("tauri://ready", |_| {});
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Ember")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { api, code, .. } = event {
                // The tray keeps the app alive even with every window closed;
                // quitting happens only via the tray menu.
                let state = app.state::<EmberState>();
                if code.is_none() && !state.quitting.load(Ordering::SeqCst) {
                    api.prevent_exit();
                }
            }
        });
}
