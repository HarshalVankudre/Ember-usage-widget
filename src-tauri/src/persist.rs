//! Crash-safe replacement for Ember's small JSON state files.
//!
//! `std::fs::rename` replaces an existing destination on Unix, but not on
//! Windows. Ember previously ignored that failure, so caches and the quota
//! ledger could stop advancing after their first successful save. Keep the
//! temporary file beside the destination and use the native replace primitive
//! on Windows so every later snapshot is durable too.

use std::fs::OpenOptions;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

fn temp_path(path: &Path) -> io::Result<PathBuf> {
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidInput, "state path has no file name")
        })?;
    let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    Ok(path.with_file_name(format!(".{name}.{}.{}.tmp", std::process::id(), sequence)))
}

#[cfg(windows)]
fn replace(temp: &Path, destination: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let from: Vec<u16> = temp.as_os_str().encode_wide().chain(Some(0)).collect();
    let to: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    let flags = MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH;
    // SAFETY: both buffers are nul-terminated and remain alive for the call.
    if unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), flags) } == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn replace(temp: &Path, destination: &Path) -> io::Result<()> {
    std::fs::rename(temp, destination)
}

pub fn write_atomic(path: &Path, contents: impl AsRef<[u8]>) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let temp = temp_path(path)?;
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)?;
        file.write_all(contents.as_ref())?;
        file.sync_all()?;
        drop(file);
        replace(&temp, path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replaces_an_existing_state_file_without_leaving_temporary_files() {
        let unique = format!(
            "ember-persist-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let dir = std::env::temp_dir().join(unique);
        let path = dir.join("state.json");

        write_atomic(&path, br#"{"revision":1}"#).unwrap();
        write_atomic(&path, br#"{"revision":2}"#).unwrap();

        assert_eq!(std::fs::read(&path).unwrap(), br#"{"revision":2}"#);
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
