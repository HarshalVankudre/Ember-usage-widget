//! Persisted user settings — same file name and shape as the Electron build,
//! so a migrated settings.json reads back without translation.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub struct Bounds {
    pub width: f64,
    pub height: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub x: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub y: Option<f64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub bounds: Bounds,
    pub mini_bounds: Bounds,
    pub mini_mode: bool,
    pub always_on_top: bool,
    pub launch_at_startup: bool,
    pub first_run: bool,
    pub tray_tip_shown: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            bounds: Bounds { width: 460.0, height: 820.0, x: None, y: None },
            mini_bounds: Bounds { width: 348.0, height: 84.0, x: None, y: None },
            mini_mode: false,
            always_on_top: true,
            launch_at_startup: true,
            first_run: true,
            tray_tip_shown: false,
        }
    }
}

/// Each mode keeps its own remembered size, so collapsing to the strip and
/// expanding again lands back on the layout the window already had.
pub const FULL_MIN: (f64, f64) = (390.0, 560.0);
pub const MINI_MIN: (f64, f64) = (268.0, 72.0);

impl Settings {
    pub fn mode_bounds(&self) -> Bounds {
        if self.mini_mode { self.mini_bounds } else { self.bounds }
    }

    pub fn mode_minimum(&self) -> (f64, f64) {
        if self.mini_mode { MINI_MIN } else { FULL_MIN }
    }
}

fn settings_path(user_data: &Path) -> PathBuf {
    user_data.join("settings.json")
}

pub fn load(user_data: &Path) -> Settings {
    match std::fs::read_to_string(settings_path(user_data)) {
        Ok(raw) => serde_json::from_str(&raw).unwrap_or_default(),
        Err(_) => Settings::default(),
    }
}

pub fn save(user_data: &Path, settings: &Settings) {
    if let Ok(body) = serde_json::to_string_pretty(settings) {
        let _ = std::fs::write(settings_path(user_data), body);
    }
}
