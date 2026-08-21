//! Crash-safe replacement for Ember's small JSON state files.
//!
//! `std::fs::rename` replaces an existing destination on Unix, but not on
//! Windows. Ember previously ignored that failure, so caches and the quota
//! ledger could stop advancing after their first successful save. Keep the
//! temporary file beside the destination and use the native replace primitive
//! on Windows so every later snapshot is durable too.

use std::fs::{File, OpenOptions};
use std::io::{self, BufWriter, Write};
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
    write_atomic_with(path, |file| file.write_all(contents.as_ref()))
}

/// Same durability contract as [`write_atomic`], for payloads large enough that
/// building them in memory is the expensive part. The usage caches are tens of
/// megabytes; serializing one to a `String` first cost a transient allocation
/// the size of the whole cache on every save, on top of the copy already
/// resident. The callback writes straight into the temporary file instead.
pub fn write_atomic_with<F>(path: &Path, fill: F) -> io::Result<()>
where
    F: FnOnce(&mut BufWriter<File>) -> io::Result<()>,
{
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let temp = temp_path(path)?;
    let result = (|| {
        let file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)?;
        let mut writer = BufWriter::new(file);
        fill(&mut writer)?;
        // Both steps matter: the buffer has to reach the file, and the file has
        // to reach the disk, before the replace makes it the live copy.
        writer.flush()?;
        let file = writer
            .into_inner()
            .map_err(|e| io::Error::new(io::ErrorKind::Other, e.to_string()))?;
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

    #[test]
    fn streaming_writes_replace_in_place_and_leave_no_temporaries() {
        let dir = std::env::temp_dir().join(format!("ember-stream-{}", std::process::id()));
        let path = dir.join("cache.json");

        write_atomic(&path, br#"{"v":1}"#).unwrap();
        write_atomic_with(&path, |w| {
            // written in pieces, exactly as a serializer would
            w.write_all(br#"{"v":2,"#)?;
            w.write_all(br#""files":{}}"#)
        })
        .unwrap();

        assert_eq!(std::fs::read(&path).unwrap(), br#"{"v":2,"files":{}}"#);
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1, "no .tmp left behind");
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// A serializer that fails partway must leave the previous file intact
    /// rather than a truncated one.
    #[test]
    fn a_failed_streaming_write_keeps_the_previous_file() {
        let dir = std::env::temp_dir().join(format!("ember-stream-fail-{}", std::process::id()));
        let path = dir.join("cache.json");
        write_atomic(&path, br#"{"good":true}"#).unwrap();

        let err = write_atomic_with(&path, |w| {
            w.write_all(b"partial")?;
            Err(io::Error::new(io::ErrorKind::Other, "serializer gave up"))
        });

        assert!(err.is_err());
        assert_eq!(std::fs::read(&path).unwrap(), br#"{"good":true}"#, "old copy survives");
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1, "no .tmp left behind");
        std::fs::remove_dir_all(dir).unwrap();
    }
}
