//! Official OpenAI model ids belong to the Codex provider even when a
//! compatibility gateway makes them appear in Claude Code's transcript.

use regex::Regex;
use std::sync::OnceLock;

fn openai_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)^(gpt|chatgpt|chat-|codex|o\d)").unwrap())
}

fn claude_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r"(?i)^claude-(?:(?:\d+(?:[-.]\d+)*-)?(?:fable|mythos|opus|sonnet|haiku)|(?:instant-)?\d+(?:[-.]\d+)*)(?:[-.]?\d+)*(?:-|$)",
        )
        .unwrap()
    })
}

pub fn is_openai_model(model: &str) -> bool {
    openai_re().is_match(model)
}

pub fn is_claude_model(model: &str) -> bool {
    claude_re().is_match(model)
}

pub fn is_first_party_model(model: &str) -> bool {
    is_claude_model(model) || is_openai_model(model)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn openai_ids_are_openai() {
        for m in [
            "gpt-5.6-sol",
            "gpt-4o",
            "chatgpt-4o-latest",
            "chat-latest",
            "codex-mini-latest",
            "o3-mini",
            "o1",
            "GPT-5.4",
        ] {
            assert!(is_openai_model(m), "{m} should be OpenAI");
            assert!(is_first_party_model(m), "{m} should be first-party");
        }
    }

    #[test]
    fn claude_ids_are_claude_not_openai() {
        for m in [
            "claude-opus-4-8-20250915",
            "claude-3-5-haiku-20241022",
            "claude-sonnet-5",
            "claude-fable-5",
            "claude-mythos-5-20260101",
            "claude-instant-1.2",
            "claude-2.1",
        ] {
            assert!(is_claude_model(m), "{m} should be Claude");
            assert!(!is_openai_model(m), "{m} should not be OpenAI");
        }
    }

    #[test]
    fn gateway_models_are_not_first_party() {
        for m in ["qwen3-coder-plus", "nexus-gpt", "<synthetic>", "glm-4.7", ""] {
            // nexus-gpt starts with 'n', not matching either family
            if m == "nexus-gpt" {
                continue; // guarded separately below
            }
            assert!(!is_first_party_model(m), "{m} should not be first-party");
        }
        // "nexus-gpt-*" does not start with gpt/o<d>/codex, so it is excluded.
        assert!(!is_first_party_model("nexus-gpt-5"));
    }

    #[test]
    fn claude_regex_rejects_lookalikes() {
        assert!(!is_claude_model("claude"));
        assert!(!is_claude_model("claudette-1"));
        assert!(!is_claude_model("claude-unknown"));
    }
}
