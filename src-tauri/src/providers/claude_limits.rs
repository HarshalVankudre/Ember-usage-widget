//! Claude plan limits via Anthropic's account API, using Claude Code's own
//! OAuth token — read-only, sent only to Anthropic's API.

use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

pub const USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";

static CACHE_FILE: Mutex<Option<PathBuf>> = Mutex::new(None);

pub fn init(user_data: &Path) {
    *CACHE_FILE.lock().unwrap() = Some(user_data.join("claude-limits-cache.json"));
}

/// last good snapshot survives restarts, so the card never goes blank
pub fn load_cached() -> Option<Value> {
    let path = CACHE_FILE.lock().unwrap().clone()?;
    let raw = std::fs::read_to_string(path).ok()?;
    let snap: Value = serde_json::from_str(&raw).ok()?;
    if snap.get("ok").and_then(|v| v.as_bool()) == Some(true) {
        Some(snap)
    } else {
        None
    }
}

pub fn save_cached(snap: &Value) {
    let Some(path) = CACHE_FILE.lock().unwrap().clone() else { return };
    if let Ok(body) = serde_json::to_string(snap) {
        let _ = crate::persist::write_atomic(&path, body);
    }
}

fn cred_path() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".claude")
        .join(".credentials.json")
}

fn claude_json_path() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from(".")).join(".claude.json")
}

/// "max" + "default_claude_max_20x" -> "Max (20x)", "pro" -> "Pro", etc.
fn plan_label(sub: Option<&str>, tier: Option<&str>) -> String {
    static MULT: OnceLock<regex::Regex> = OnceLock::new();
    let mult_re = MULT.get_or_init(|| regex::Regex::new(r"(\d+)x").unwrap());
    let mult = tier.and_then(|t| mult_re.captures(t)).map(|c| c[1].to_string());
    match sub {
        Some("max") => match mult {
            Some(m) => format!("Max ({m}x)"),
            None => "Max".to_string(),
        },
        Some("pro") => "Pro".to_string(),
        Some("free") => "Free".to_string(),
        Some("enterprise") => "Enterprise".to_string(),
        Some("team") => "Team".to_string(),
        Some(other) if !other.is_empty() => {
            let mut chars = other.chars();
            match chars.next() {
                Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
                None => String::new(),
            }
        }
        _ => String::new(),
    }
}

pub async fn fetch_plan_limits(client: &reqwest::Client) -> Value {
    let mut token: Option<String> = None;
    let mut sub: Option<String> = None;
    let mut tier: Option<String> = None;
    if let Ok(raw) = std::fs::read_to_string(cred_path()) {
        if let Ok(cred) = serde_json::from_str::<Value>(&raw) {
            if let Some(oauth) = cred.get("claudeAiOauth").filter(|v| crate::js_truthy(v)) {
                token = oauth.get("accessToken").and_then(|v| v.as_str()).map(String::from);
                sub = oauth.get("subscriptionType").and_then(|v| v.as_str()).map(String::from);
                tier = oauth.get("rateLimitTier").and_then(|v| v.as_str()).map(String::from);
            }
        }
    }
    // ~/.claude.json carries the *current* org tier; the credentials file can be
    // stale (it reflects the tier at the time the token was issued).
    if let Ok(raw) = std::fs::read_to_string(claude_json_path()) {
        if let Ok(parsed) = serde_json::from_str::<Value>(&raw) {
            if let Some(acct) = parsed.get("oauthAccount").filter(|v| crate::js_truthy(v)) {
                tier = acct
                    .get("organizationRateLimitTier")
                    .and_then(|v| v.as_str())
                    .filter(|s| !s.is_empty())
                    .map(String::from)
                    .or_else(|| {
                        acct.get("userRateLimitTier")
                            .and_then(|v| v.as_str())
                            .filter(|s| !s.is_empty())
                            .map(String::from)
                    })
                    .or(tier);
                let org_type = acct.get("organizationType").and_then(|v| v.as_str());
                if sub.is_none() && org_type == Some("claude_max") {
                    sub = Some("max".to_string());
                }
                if sub.is_none() && org_type == Some("claude_pro") {
                    sub = Some("pro".to_string());
                }
            }
        }
    }
    let plan = if sub.is_some() || tier.is_some() {
        json!({
            "type": sub,
            "tier": tier,
            "label": plan_label(sub.as_deref(), tier.as_deref()),
        })
    } else {
        Value::Null
    };
    let Some(token) = token.filter(|t| !t.is_empty()) else {
        return json!({ "ok": false, "reason": "no-credentials", "plan": plan });
    };

    let res = client
        .get(USAGE_URL)
        .header("Authorization", format!("Bearer {token}"))
        .header("anthropic-beta", "oauth-2025-04-20")
        .timeout(Duration::from_secs(15))
        .send()
        .await;
    match res {
        Ok(res) => {
            if !res.status().is_success() {
                let retry_after = res
                    .headers()
                    .get("retry-after")
                    .and_then(|v| v.to_str().ok())
                    .and_then(|v| v.parse::<f64>().ok())
                    .unwrap_or(0.0);
                return json!({
                    "ok": false,
                    "reason": format!("http-{}", res.status().as_u16()),
                    "retryAfter": retry_after,
                    "plan": plan,
                });
            }
            match res.json::<Value>().await {
                Ok(data) => json!({
                    "ok": true,
                    "fetchedAt": crate::now_ms(),
                    "data": data,
                    "plan": plan,
                }),
                Err(_) => json!({ "ok": false, "reason": "network", "plan": plan }),
            }
        }
        Err(_) => json!({ "ok": false, "reason": "network", "plan": plan }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plan_labels_read_like_the_account_page() {
        assert_eq!(plan_label(Some("max"), Some("default_claude_max_20x")), "Max (20x)");
        assert_eq!(plan_label(Some("max"), None), "Max");
        assert_eq!(plan_label(Some("pro"), None), "Pro");
        assert_eq!(plan_label(Some("team"), None), "Team");
        assert_eq!(plan_label(Some("custom"), None), "Custom");
        assert_eq!(plan_label(None, Some("5x")), "");
    }
}
