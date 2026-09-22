//! Hand-edited Claude prices in `pricing-overrides.json`, next to the other
//! app data. They beat both the live official table and the bundled one, and
//! are reloaded whenever the file changes, so a price can be corrected the
//! day a model ships without a rebuild.

use super::claude_pricing::{set_overrides, LivePrice};
use serde::Deserialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime};

pub const FILE_NAME: &str = "pricing-overrides.json";
pub const POLL: Duration = Duration::from_secs(5);

const TEMPLATE: &str = r#"{
  "_help": "USD per million tokens. Rows under \"claude\" beat the live Anthropic table and the bundled one. Keys are model ids (\"opus-5-5\" or \"claude-opus-5-5\"). fastInput/fastOutput are optional. Ember reloads this file as soon as it is saved.",
  "_example": {
    "opus-5-5": { "input": 4, "cacheW5m": 5, "cacheW1h": 8, "cacheRead": 0.2, "output": 20, "fastInput": 8, "fastOutput": 40 }
  },
  "claude": {}
}
"#;

#[derive(Deserialize, Default)]
struct OverridesFile {
    #[serde(default)]
    claude: HashMap<String, LivePrice>,
}

static PATH: OnceLock<PathBuf> = OnceLock::new();
static SEEN: Mutex<Option<Option<SystemTime>>> = Mutex::new(None);

pub fn path() -> Option<&'static Path> {
    PATH.get().map(PathBuf::as_path)
}

pub fn init(user_data: &Path) {
    let path = user_data.join(FILE_NAME);
    if !path.exists() {
        let _ = crate::persist::write_atomic(&path, TEMPLATE);
    }
    let _ = PATH.set(path);
    reload_if_changed();
}

fn parse(raw: &str) -> Result<HashMap<String, LivePrice>, serde_json::Error> {
    serde_json::from_str::<OverridesFile>(raw).map(|f| f.claude)
}

/// True when the file changed and the overrides were re-applied. A file that
/// fails to parse keeps the previous overrides, so a half-saved edit does not
/// flip every cost back to the defaults.
pub fn reload_if_changed() -> bool {
    let Some(path) = PATH.get() else { return false };
    let mtime = std::fs::metadata(path).and_then(|m| m.modified()).ok();
    let mut seen = SEEN.lock().unwrap();
    if seen.as_ref() == Some(&mtime) {
        return false;
    }
    *seen = Some(mtime);
    drop(seen);

    let Some(_) = mtime else {
        set_overrides(HashMap::new());
        return true;
    };
    match std::fs::read_to_string(path).map_err(|e| e.to_string()).and_then(|raw| parse(&raw).map_err(|e| e.to_string())) {
        Ok(map) => {
            crate::journal::note(format!("pricing overrides loaded: {} model(s)", map.len()));
            set_overrides(map);
            true
        }
        Err(err) => {
            crate::journal::note(format!("pricing overrides ignored ({FILE_NAME}): {err}"));
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_template_parses_to_no_overrides() {
        assert!(parse(TEMPLATE).unwrap().is_empty());
    }

    #[test]
    fn parses_a_claude_row_with_optional_fast_rates() {
        let map = parse(r#"{"claude":{"claude-opus-5-5":{"input":4,"cacheW5m":5,"cacheW1h":8,"cacheRead":0.2,"output":20,"fastInput":8,"fastOutput":40}}}"#).unwrap();
        let row = &map["claude-opus-5-5"];
        assert_eq!(row.cache_read, 0.2);
        assert_eq!(row.fast_output, Some(40.0));
    }
}
