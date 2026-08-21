//! A small rolling log for the things that fail silently.
//!
//! A release Tauri build has no console and no devtools, so when the Claude
//! meter froze for sixteen hours there was nothing to read: the only evidence
//! was a cache file that had stopped advancing. Diagnosing it meant probing the
//! endpoint from a separate test binary to prove the network was fine and the
//! app was not. This exists so that never costs more than opening a file.
//!
//! Deliberately not a general logging framework. It records the poller's
//! decisions and outcomes — the state machine that can latch — and nothing
//! else. Nothing here ever sees a token: callers pass status and reason codes.

use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// Rotate at a size a person can still open and scan. At roughly 90 bytes a
/// line this holds on the order of a week of ordinary polling.
const MAX_BYTES: u64 = 64 * 1024;

static LOG_FILE: Mutex<Option<PathBuf>> = Mutex::new(None);

pub fn init(user_data: &Path) {
    *LOG_FILE.lock().unwrap() = Some(user_data.join("ember.log"));
}

fn stamp() -> String {
    chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f").to_string()
}

/// One previous generation is kept, so a rotation mid-incident cannot throw
/// away the lines that explain it.
fn rotate_if_full(path: &Path) {
    let full = std::fs::metadata(path).map(|m| m.len() >= MAX_BYTES).unwrap_or(false);
    if full {
        let _ = std::fs::rename(path, path.with_extension("log.1"));
    }
}

/// The whole of the behavior, with the destination passed in rather than read
/// from a global — which is what lets this be tested without one test's log
/// path leaking into another's.
fn note_into(target: Option<&Path>, line: &str) {
    let Some(path) = target else { return };
    rotate_if_full(path);
    let entry = format!("{} {line}\n", stamp());
    // Never propagates and never panics: a widget must not fall over because
    // its log file is locked or its disk is full.
    let _ = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .and_then(|mut f| f.write_all(entry.as_bytes()));
}

/// Append one line to the app's log. A no-op until [`init`] has run.
pub fn note(line: impl AsRef<str>) {
    // The guard is held across the write on purpose: it serializes concurrent
    // notes so two threads cannot interleave halves of a line.
    let target = LOG_FILE.lock().unwrap();
    note_into(target.as_deref(), line.as_ref());
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "ember-journal-{}-{}-{name}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn lines_accumulate_with_a_timestamp() {
        let dir = scratch("append");
        let path = dir.join("ember.log");
        note_into(Some(&path), "claude poll ok");
        note_into(Some(&path), "claude poll skipped state=backoff");

        let body = std::fs::read_to_string(&path).unwrap();
        let lines: Vec<_> = body.lines().collect();
        assert_eq!(lines.len(), 2);
        assert!(lines[0].ends_with("claude poll ok"), "got {:?}", lines[0]);
        assert!(lines[0].starts_with("20"), "line carries a timestamp: {:?}", lines[0]);
        assert!(lines[1].ends_with("claude poll skipped state=backoff"));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn an_oversized_log_rotates_instead_of_growing_without_bound() {
        let dir = scratch("rotate");
        let path = dir.join("ember.log");
        std::fs::write(&path, vec![b'x'; MAX_BYTES as usize + 1]).unwrap();

        note_into(Some(&path), "first line after rotation");

        let body = std::fs::read_to_string(&path).unwrap();
        assert!(body.ends_with("first line after rotation\n"));
        assert!(body.len() < 200, "the live log restarted, got {} bytes", body.len());
        assert!(dir.join("ember.log.1").exists(), "the previous generation is kept");
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// Anything logged before the data directory is known is dropped rather
    /// than guessed at, and must not panic.
    #[test]
    fn logging_before_init_is_a_no_op() {
        note_into(None, "dropped on the floor");
    }

    /// init() is what binds the global to a real file; the name it picks is
    /// part of the contract for anyone going to read it.
    #[test]
    fn init_names_the_log_inside_the_data_directory() {
        let dir = scratch("init");
        init(&dir);
        assert_eq!(LOG_FILE.lock().unwrap().clone(), Some(dir.join("ember.log")));
        std::fs::remove_dir_all(dir).unwrap();
    }
}
