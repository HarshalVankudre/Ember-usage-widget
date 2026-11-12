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

/// "max" + "default_claude_max_20x" -> "Ultra", "max" + "..._5x" -> "Max",
/// "pro" -> "Pro", etc.
///
/// Anthropic renamed the plans on 30 Oct 2026: Max 20x became Ultra and Max 5x
/// became plain Max. The account still reports the old identifiers (type
/// "max", tier "default_claude_max_20x"), so the old names are mapped here; a
/// type or tier that already says "ultra" is honoured too.
fn plan_label(sub: Option<&str>, tier: Option<&str>) -> String {
    static MULT: OnceLock<regex::Regex> = OnceLock::new();
    let mult_re = MULT.get_or_init(|| regex::Regex::new(r"(\d+)x").unwrap());
    let mult = tier.and_then(|t| mult_re.captures(t)).map(|c| c[1].to_string());
    let tier_says_ultra = tier.is_some_and(|t| t.to_ascii_lowercase().contains("ultra"));
    match sub {
        Some("ultra") => "Ultra".to_string(),
        Some("max") if tier_says_ultra => "Ultra".to_string(),
        Some("max") => match mult.as_deref() {
            Some("20") => "Ultra".to_string(),
            Some("5") | None => "Max".to_string(),
            Some(m) => format!("Max ({m}x)"),
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

/// The access token worth sending, or the reason there is none. An expired
/// token is held back: the endpoint answers it with 401s, and a run of 401s is
/// punished with hour-long 429s. Claude Code rewrites the file when it
/// refreshes, and the next poll reads the new token.
fn usable_token(oauth: &Value, now: f64) -> Result<String, &'static str> {
    let token = oauth
        .get("accessToken")
        .and_then(|v| v.as_str())
        .filter(|t| !t.is_empty())
        .ok_or("no-credentials")?;
    let expires_at = oauth.get("expiresAt").and_then(|v| v.as_f64());
    if expires_at.is_some_and(|at| at <= now) {
        return Err("token-expired");
    }
    Ok(token.to_string())
}

/// What Claude Code's local files say about the signed-in account.
struct Account {
    token: Result<String, &'static str>,
    plan: Value,
    claude_json: Option<Value>,
}

fn read_account() -> Account {
    let mut token: Result<String, &'static str> = Err("no-credentials");
    let mut sub: Option<String> = None;
    let mut tier: Option<String> = None;
    if let Ok(raw) = std::fs::read_to_string(cred_path()) {
        if let Ok(cred) = serde_json::from_str::<Value>(&raw) {
            if let Some(oauth) = cred.get("claudeAiOauth").filter(|v| crate::js_truthy(v)) {
                token = usable_token(oauth, crate::now_ms());
                sub = oauth.get("subscriptionType").and_then(|v| v.as_str()).map(String::from);
                tier = oauth.get("rateLimitTier").and_then(|v| v.as_str()).map(String::from);
            }
        }
    }
    // ~/.claude.json carries the *current* org tier; the credentials file can be
    // stale (it reflects the tier at the time the token was issued).
    let claude_json = std::fs::read_to_string(claude_json_path())
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok());
    let acct = claude_json
        .as_ref()
        .and_then(|parsed| parsed.get("oauthAccount"))
        .filter(|v| crate::js_truthy(v));
    if let Some(acct) = acct {
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
    let plan = if sub.is_some() || tier.is_some() {
        json!({
            "type": sub,
            "tier": tier,
            "label": plan_label(sub.as_deref(), tier.as_deref()),
        })
    } else {
        Value::Null
    };
    Account { token, plan, claude_json }
}

/// Claude Code fetches the same usage payload on its own schedule and keeps a
/// copy in ~/.claude.json. Adopting it costs no request against the shared,
/// tightly limited endpoint, and keeps the meter moving while Ember is
/// rate-limited.
fn shared_snapshot(claude_json: &Value, plan: &Value) -> Option<Value> {
    let cached = claude_json.get("cachedUsageUtilization")?;
    let account = claude_json.get("oauthAccount")?.get("accountUuid")?;
    if cached.get("accountUuid")? != account {
        return None;
    }
    let fetched_at = cached.get("fetchedAtMs")?.as_f64()?;
    let data = cached.get("utilization").filter(|d| d.is_object())?;
    Some(json!({
        "ok": true,
        "fetchedAt": fetched_at,
        "data": data,
        "plan": plan,
        "source": "claude-code",
    }))
}

pub fn load_shared() -> Option<Value> {
    let account = read_account();
    shared_snapshot(account.claude_json.as_ref()?, &account.plan)
}

pub async fn fetch_plan_limits(client: &reqwest::Client) -> Value {
    let Account { token, plan, .. } = read_account();
    let token = match token {
        Ok(token) => token,
        Err(reason) => return json!({ "ok": false, "reason": reason, "plan": plan }),
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

    /// An expired token gets a 401, and a run of 401s is what earned Ember
    /// three back-to-back hour-long 429 penalties on 10 Nov 2026. Claude Code
    /// refreshes the token itself, so the right move is to wait for it.
    #[test]
    fn an_expired_token_is_never_sent() {
        let now = 1_000_000.0;
        let oauth = |expires_at: f64| json!({ "accessToken": "tok", "expiresAt": expires_at });
        assert_eq!(usable_token(&oauth(now + 60_000.0), now), Ok("tok".to_string()));
        assert_eq!(usable_token(&oauth(now - 1.0), now), Err("token-expired"));
        assert_eq!(
            usable_token(&json!({ "accessToken": "tok" }), now),
            Ok("tok".to_string()),
            "a token without an expiry is still tried"
        );
        assert_eq!(usable_token(&json!({ "accessToken": "" }), now), Err("no-credentials"));
    }

    #[test]
    fn claude_codes_own_snapshot_is_adopted_for_the_same_account() {
        let plan = json!({ "label": "Ultra" });
        let utilization = json!({ "five_hour": { "utilization": 5 } });
        let file = |owner: &str| {
            json!({
                "oauthAccount": { "accountUuid": "acct-1" },
                "cachedUsageUtilization": {
                    "fetchedAtMs": 1_000.0,
                    "accountUuid": owner,
                    "utilization": utilization,
                },
            })
        };
        let snap = shared_snapshot(&file("acct-1"), &plan).expect("same account is adopted");
        assert_eq!(snap["ok"], json!(true));
        assert_eq!(snap["fetchedAt"], json!(1_000.0));
        assert_eq!(snap["data"], utilization);
        assert_eq!(snap["plan"], plan);
        assert!(shared_snapshot(&file("acct-2"), &plan).is_none(), "another account's numbers are not");
        assert!(shared_snapshot(&json!({ "oauthAccount": { "accountUuid": "acct-1" } }), &plan).is_none());
    }

    #[test]
    fn plan_labels_read_like_the_account_page() {
        // Max 20x was renamed Ultra, and Max 5x plain Max, on 30 Oct 2026.
        assert_eq!(plan_label(Some("max"), Some("default_claude_max_20x")), "Ultra");
        assert_eq!(plan_label(Some("max"), Some("default_claude_max_5x")), "Max");
        assert_eq!(plan_label(Some("max"), Some("default_claude_ultra")), "Ultra");
        assert_eq!(plan_label(Some("ultra"), None), "Ultra");
        assert_eq!(plan_label(Some("max"), Some("default_claude_max_40x")), "Max (40x)");
        assert_eq!(plan_label(Some("max"), None), "Max");
        assert_eq!(plan_label(Some("pro"), None), "Pro");
        assert_eq!(plan_label(Some("team"), None), "Team");
        assert_eq!(plan_label(Some("custom"), None), "Custom");
        assert_eq!(plan_label(None, Some("5x")), "");
    }
}
