//! ClaudeX shares its config dir with Ember: projects (Anthropic-shaped
//! transcripts) and a usage-cache holding shared Codex limit snapshots.

use std::path::PathBuf;

fn expand_home(value: &str, home: &PathBuf) -> Option<PathBuf> {
    if value.is_empty() {
        return None;
    }
    if value == "~" {
        return Some(home.clone());
    }
    if let Some(rest) = value
        .strip_prefix("~/")
        .or_else(|| value.strip_prefix("~\\"))
    {
        return Some(home.join(rest));
    }
    Some(PathBuf::from(value))
}

pub fn resolve_config_dir() -> PathBuf {
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    match std::env::var("CLAUDEX_CONFIG_DIR") {
        Ok(configured) if !configured.is_empty() => {
            expand_home(&configured, &home).unwrap_or_else(|| home.join(".config").join("claudex"))
        }
        _ => home.join(".config").join("claudex"),
    }
}

pub fn projects_dir() -> PathBuf {
    resolve_config_dir().join("projects")
}

pub fn usage_dir() -> PathBuf {
    resolve_config_dir().join("usage-cache")
}
