use ember_widget_lib::providers::{codex_limits, codex_usage, quota_ledger};
use serde_json::json;

#[test]
fn refresh_ignores_model_specific_codex_limits_and_keeps_the_account_meter() {
    // The account-wide weekly meter and a model-specific Spark meter coexist
    // in current Codex rollout logs. Spark is newer, but it is not a newer
    // reading of the account meter and must not replace it during Refresh.
    let lines = [
        json!({
            "type": "event_msg",
            "timestamp": "2026-08-20T10:00:00Z",
            "payload": {
                "type": "token_count",
                "rate_limits": {
                    "limit_id": "codex",
                    "plan_type": "pro",
                    "primary": {
                        "used_percent": 68.0,
                        "window_minutes": 10_080.0,
                        "resets_at": 1_787_529_600.0
                    }
                }
            }
        }),
        json!({
            "type": "event_msg",
            "timestamp": "2026-08-20T10:01:00Z",
            "payload": {
                "type": "token_count",
                "rate_limits": {
                    "limit_id": "codex_bengalfox",
                    "limit_name": "GPT-5.3-Codex-Spark",
                    "plan_type": "pro",
                    "primary": {
                        "used_percent": 0.0,
                        "window_minutes": 300.0,
                        "resets_at": 1_787_227_200.0
                    },
                    "secondary": {
                        "used_percent": 0.0,
                        "window_minutes": 10_080.0,
                        "resets_at": 1_787_529_600.0
                    }
                }
            }
        }),
    ]
    .map(|value| value.to_string())
    .join("\n");

    let parsed = codex_usage::parse_content(&lines);
    let snapshot = parsed
        .limits
        .expect("the account-wide Codex snapshot should survive parsing");
    let refreshed = codex_limits::from_snapshot(Some(&snapshot));
    let meters = quota_ledger::codex_meters(Some(&refreshed));
    let session_pct = meters
        .iter()
        .find(|meter| meter.id == "codex|300")
        .and_then(|meter| meter.utilization);
    let weekly_pct = meters
        .iter()
        .find(|meter| meter.id == "codex|10080")
        .and_then(|meter| meter.utilization)
        .unwrap_or_default();
    let selected_limit = snapshot.rate_limits["limit_id"]
        .as_str()
        .unwrap_or("<missing>");
    println!(
        "REFRESH_REPRO selected_limit={selected_limit} session={session_pct:?} weekly={weekly_pct:.0}% rendered_week_waiting={}",
        weekly_pct <= 0.0
    );

    assert_eq!(
        selected_limit, "codex",
        "a model-specific Spark quota must not replace the main Codex account quota"
    );
    assert_eq!(
        session_pct, None,
        "the weekly-only account snapshot has no five-hour row"
    );
    assert_eq!(
        weekly_pct, 68.0,
        "Refresh must retain the account-wide weekly utilization"
    );
}
