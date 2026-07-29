//! Canonical hashing of the usage payload so the renderer only repaints when
//! usage state actually changed. Covers every bucket field and all payload
//! metadata, so redistributions, reasoning tokens, deletions, and price-only
//! changes are observable even when top-level token totals stay unchanged.

use serde_json::Value;
use sha2::{Digest, Sha256};

fn hash_value(hasher: &mut Sha256, value: &Value) {
    match value {
        Value::Null => hasher.update(b"null;"),
        Value::Bool(b) => hasher.update(format!("boolean:{b};").as_bytes()),
        Value::Number(n) => hasher.update(format!("number:{n};").as_bytes()),
        Value::String(s) => {
            hasher.update(format!("string:{}:", s.len()).as_bytes());
            hasher.update(s.as_bytes());
        }
        Value::Array(items) => {
            hasher.update(format!("array:{}:[", items.len()).as_bytes());
            for item in items {
                hash_value(hasher, item);
            }
            hasher.update(b"]");
        }
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            hasher.update(format!("object:{}:{{", keys.len()).as_bytes());
            for key in keys {
                hash_value(hasher, &Value::String(key.clone()));
                hash_value(hasher, &map[key]);
            }
            hasher.update(b"}");
        }
    }
}

/// These transport fields intentionally change on every aggregation. The
/// revision orders responses; generatedAt preserves snapshot timing. Neither
/// represents a usage-state change that should trigger a full renderer pass.
pub fn update_signature(data: &Value) -> String {
    let mut stable = data.clone();
    if let Some(map) = stable.as_object_mut() {
        map.remove("generatedAt");
        map.remove("revision");
    }
    let mut hasher = Sha256::new();
    hash_value(&mut hasher, &stable);
    format!("{:x}", hasher.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn transport_fields_do_not_change_the_signature() {
        let a = json!({ "buckets": [1, 2], "generatedAt": 1, "revision": 5, "fileCount": 2 });
        let b = json!({ "buckets": [1, 2], "generatedAt": 99, "revision": 6, "fileCount": 2 });
        assert_eq!(update_signature(&a), update_signature(&b));
    }

    #[test]
    fn usage_changes_do_change_the_signature() {
        let a = json!({ "buckets": [{ "cost": 1.0 }], "fileCount": 2 });
        let b = json!({ "buckets": [{ "cost": 1.5 }], "fileCount": 2 });
        assert_ne!(update_signature(&a), update_signature(&b));
    }

    #[test]
    fn key_order_is_canonical() {
        let a = json!({ "x": 1, "y": { "b": 2, "a": 3 } });
        let mut map = serde_json::Map::new();
        map.insert("y".into(), json!({ "a": 3, "b": 2 }));
        map.insert("x".into(), json!(1));
        assert_eq!(update_signature(&a), update_signature(&Value::Object(map)));
    }
}
