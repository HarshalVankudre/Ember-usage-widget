//! Claude Code usage from other machines, such as a server signed in to the
//! same plan.
//!
//! Each source in `remote-sources.json` is reached with the system `ssh`
//! client. Its `~/.claude/projects` logs are copied into
//! `<data>/remote/<name>/`, and the Claude reader treats that mirror as one
//! more projects root. Remote usage therefore goes through the same parsing,
//! dedup and pricing as local usage, and its history survives the remote
//! logs being deleted, just like local history does.
//!
//! Each server gets one ssh connection that stays open. Ember sends the
//! size it already holds for each file; the remote shell script then looks
//! every couple of seconds and sends only the bytes past that point, or the
//! whole file if it shrank. Transcripts are append-only, so a quiet round
//! costs a file listing on the server and a few bytes on the wire. A dropped
//! connection is reopened with backoff. The only remote requirements are
//! `sh`, GNU `find`, `tail`, `head`, `wc` and `awk`, which any Linux server
//! has.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;

pub const FILE_NAME: &str = "remote-sources.json";
pub const STATUS_FILE_NAME: &str = "remote-sources-status.json";
/// How often the remote side looks for new usage, over a connection that
/// stays open. Each look is a file listing, so this can be short.
pub const DEFAULT_INTERVAL: Duration = Duration::from_secs(2);
const MIN_INTERVAL_SECS: u64 = 1;
const END_MARKER: &str = "EMBER-END";
const FILE_MARKER: &str = "EMBER-FILE";
const TICK_MARKER: &str = "EMBER-TICK";

const TEMPLATE: &str = r#"{
  "_help": "Claude Code usage from other machines on the same plan, such as a server. Each source is reached with your ssh client (key-based login, no password prompt) and its ~/.claude/projects logs are copied here and added to Ember's totals. Projects show as '<name> · <project>'. Ember rereads this file on every sync, so no restart is needed. 'port', 'identityFile', 'remotePath' (relative to the remote home unless it starts with /), 'sshPath' and 'enabled' are optional.",
  "_example": {
    "sources": [
      { "name": "vps", "ssh": "harshal@203.0.113.7", "port": 22, "identityFile": "~/.ssh/id_ed25519" }
    ]
  },
  "intervalSeconds": 2,
  "sources": []
}
"#;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    pub name: String,
    pub ssh: String,
    #[serde(default)]
    pub port: Option<u16>,
    #[serde(default)]
    pub identity_file: Option<String>,
    #[serde(default)]
    pub remote_path: Option<String>,
    #[serde(default)]
    pub ssh_path: Option<String>,
    #[serde(default = "enabled_default")]
    pub enabled: bool,
    /// Counted in Ember's totals. Switched from the titlebar pill; syncing
    /// carries on either way, so switching back on misses nothing.
    #[serde(default = "enabled_default")]
    pub included: bool,
}

fn enabled_default() -> bool {
    true
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    #[serde(default)]
    pub interval_seconds: Option<u64>,
    #[serde(default)]
    pub sources: Vec<Source>,
}

impl Config {
    pub fn interval(&self) -> Duration {
        self.interval_seconds
            .map(|s| Duration::from_secs(s.max(MIN_INTERVAL_SECS)))
            .unwrap_or(DEFAULT_INTERVAL)
    }
}

static USER_DATA: OnceLock<PathBuf> = OnceLock::new();

/// The latest outcome per source folder name, for the titlebar indicator.
#[derive(Clone, Debug)]
struct LastSync {
    ok: bool,
    at_ms: f64,
    error: Option<String>,
}
static LAST: std::sync::Mutex<BTreeMap<String, LastSync>> = std::sync::Mutex::new(BTreeMap::new());
static WAKE: OnceLock<tokio::sync::Notify> = OnceLock::new();

/// Wakes the sync loop now instead of at the end of its interval.
pub fn wake() {
    WAKE.get_or_init(tokio::sync::Notify::new).notify_one();
}

/// Sleeps one interval, or less if `wake` is called.
pub async fn wait(interval: Duration) {
    let notify = WAKE.get_or_init(tokio::sync::Notify::new);
    let _ = tokio::time::timeout(interval, notify.notified()).await;
}

/// What the titlebar shows: one row per configured source, in config order.
/// `atMs` is the last attempt; `ok` says whether it succeeded. A source with
/// no attempt yet has `atMs: null`.
pub fn snapshot() -> serde_json::Value {
    let config = load_config();
    let last = LAST.lock().unwrap();
    let mut seen = std::collections::HashSet::new();
    let sources: Vec<serde_json::Value> = config
        .sources
        .iter()
        .filter(|s| !s.ssh.trim().is_empty())
        .filter(|s| seen.insert(folder_name(&s.name)))
        .map(|s| {
            let key = folder_name(&s.name);
            let rec = last.get(&key);
            serde_json::json!({
                "name": key,
                "host": s.ssh.trim(),
                "enabled": s.enabled,
                "included": s.included,
                "ok": rec.map(|r| r.ok),
                "atMs": rec.map(|r| r.at_ms),
                "error": rec.and_then(|r| r.error.clone()),
            })
        })
        .collect();
    serde_json::json!({ "sources": sources, "intervalMs": config.interval().as_millis() as f64 })
}

/// What the Servers dialog edits. Anything else a hand-edited entry carries
/// (`remotePath`, `sshPath`, `included`) is kept as it was.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceInput {
    pub name: String,
    pub ssh: String,
    #[serde(default)]
    pub port: Option<u16>,
    #[serde(default)]
    pub identity_file: Option<String>,
    #[serde(default = "enabled_default")]
    pub enabled: bool,
}

/// Every configured source with all its fields, for the Servers dialog.
pub fn list_sources() -> Vec<Source> {
    load_config().sources
}

fn config_path() -> Result<PathBuf, String> {
    Ok(USER_DATA.get().ok_or("not initialised")?.join(FILE_NAME))
}

fn read_config_doc() -> Result<serde_json::Value, String> {
    let raw = std::fs::read_to_string(config_path()?).unwrap_or_else(|_| TEMPLATE.to_string());
    serde_json::from_str(&raw).map_err(|e| format!("{FILE_NAME} is not valid JSON: {e}"))
}

fn write_config_doc(doc: &serde_json::Value) -> Result<(), String> {
    let mut out = serde_json::to_string_pretty(doc).map_err(|e| e.to_string())?;
    out.push('\n');
    crate::persist::write_atomic(&config_path()?, out).map_err(|e| e.to_string())?;
    load_config();
    Ok(())
}

/// Adds a source (`original` is `None`) or edits the one named `original`,
/// in the config document. Pure, so the rules are testable.
pub fn upsert_in(doc: &mut serde_json::Value, original: Option<&str>, input: &SourceInput) -> Result<(), String> {
    let name = input.name.trim();
    let ssh = input.ssh.trim();
    if name.is_empty() {
        return Err("Give the server a name.".into());
    }
    if ssh.is_empty() {
        return Err("Enter the ssh login, like user@203.0.113.7.".into());
    }
    if ssh.chars().any(char::is_whitespace) || ssh.starts_with('-') {
        return Err("The ssh login is one word, like user@host or a host alias.".into());
    }
    if input.port == Some(0) {
        return Err("The port must be between 1 and 65535.".into());
    }
    if !doc.is_object() {
        *doc = serde_json::json!({});
    }
    let obj = doc.as_object_mut().unwrap();
    let sources = obj.entry("sources").or_insert_with(|| serde_json::json!([]));
    if !sources.is_array() {
        *sources = serde_json::json!([]);
    }
    let list = sources.as_array_mut().unwrap();
    let key_of = |v: &serde_json::Value| v.get("name").and_then(|n| n.as_str()).map(folder_name);
    let target = folder_name(name);
    let index = match original {
        Some(orig) => {
            let orig = folder_name(orig);
            Some(list.iter().position(|v| key_of(v) == Some(orig.clone())).ok_or("That server no longer exists.")?)
        }
        None => None,
    };
    if list.iter().enumerate().any(|(i, v)| Some(i) != index && key_of(v) == Some(target.clone())) {
        return Err(format!("There is already a server called {target}."));
    }
    let mut entry = index
        .and_then(|i| list[i].as_object().cloned())
        .unwrap_or_default();
    entry.insert("name".into(), name.into());
    entry.insert("ssh".into(), ssh.into());
    match input.port {
        Some(port) => { entry.insert("port".into(), port.into()); }
        None => { entry.remove("port"); }
    }
    match input.identity_file.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(key) => { entry.insert("identityFile".into(), key.into()); }
        None => { entry.remove("identityFile"); }
    }
    entry.insert("enabled".into(), input.enabled.into());
    match index {
        Some(i) => list[i] = serde_json::Value::Object(entry),
        None => list.push(serde_json::Value::Object(entry)),
    }
    Ok(())
}

/// Saves a source from the Servers dialog. A rename moves the mirror, so the
/// server's usage history carries over under the new name.
pub fn save_source(original: Option<&str>, input: &SourceInput) -> Result<(), String> {
    let mut doc = read_config_doc()?;
    upsert_in(&mut doc, original, input)?;
    if let (Some(orig), Some(parent)) = (original, mirror_parent()) {
        let (old, new) = (folder_name(orig), folder_name(&input.name));
        if old != new {
            let (from, to) = (parent.join(&old), parent.join(&new));
            if to.exists() {
                // Left over from a server deleted outside Ember; the new name wins.
                std::fs::remove_dir_all(&to).map_err(|e| e.to_string())?;
            }
            if from.exists() {
                std::fs::rename(&from, &to).map_err(|e| format!("could not move the synced usage: {e}"))?;
            }
            let mut last = LAST.lock().unwrap();
            if let Some(rec) = last.remove(&old) {
                last.insert(new, rec);
            }
        }
    }
    write_config_doc(&doc)?;
    wake();
    Ok(())
}

/// Removes a source and the usage synced from it.
pub fn delete_source(name: &str) -> Result<(), String> {
    let mut doc = read_config_doc()?;
    let target = folder_name(name);
    if let Some(list) = doc.get_mut("sources").and_then(|v| v.as_array_mut()) {
        list.retain(|v| v.get("name").and_then(|n| n.as_str()).map(folder_name) != Some(target.clone()));
    }
    write_config_doc(&doc)?;
    LAST.lock().unwrap().remove(&target);
    if let Some(parent) = mirror_parent() {
        let dir = parent.join(&target);
        if dir.exists() {
            std::fs::remove_dir_all(&dir).map_err(|e| format!("could not remove the synced usage: {e}"))?;
        }
    }
    Ok(())
}

/// Counts one source in the totals, or leaves it out, by rewriting its
/// `included` flag. Every other field in the file is kept as written.
pub fn set_included(name: &str, included: bool) -> Result<(), String> {
    let dir = USER_DATA.get().ok_or("not initialised")?;
    let path = dir.join(FILE_NAME);
    let raw = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let updated = set_flag_in(&raw, name, "included", included)?;
    crate::persist::write_atomic(&path, updated).map_err(|e| e.to_string())?;
    load_config();
    Ok(())
}

pub fn set_flag_in(raw: &str, name: &str, flag: &str, value: bool) -> Result<String, String> {
    let mut doc: serde_json::Value = serde_json::from_str(raw).map_err(|e| e.to_string())?;
    let sources = doc
        .get_mut("sources")
        .and_then(|v| v.as_array_mut())
        .ok_or("no sources in the config")?;
    let target = folder_name(name);
    let mut found = false;
    for source in sources.iter_mut() {
        let matches = source.get("name").and_then(|n| n.as_str()).map(folder_name) == Some(target.clone());
        if let (true, Some(obj)) = (matches, source.as_object_mut()) {
            obj.insert(flag.into(), serde_json::Value::Bool(value));
            found = true;
        }
    }
    if !found {
        return Err(format!("no source named {name}"));
    }
    let mut out = serde_json::to_string_pretty(&doc).map_err(|e| e.to_string())?;
    out.push('\n');
    Ok(out)
}

/// Creates the config template and the mirror folder, so the folder watcher
/// has something to attach to from the first launch.
pub fn init(user_data: &Path) {
    let _ = USER_DATA.set(user_data.to_path_buf());
    let path = user_data.join(FILE_NAME);
    if !path.exists() {
        let _ = crate::persist::write_atomic(&path, TEMPLATE);
    }
    let _ = std::fs::create_dir_all(mirror_parent_in(user_data));
    load_config();
}

fn mirror_parent_in(user_data: &Path) -> PathBuf {
    user_data.join("remote")
}

/// The folder holding one mirror per source. Watched as a whole.
pub fn mirror_parent() -> Option<PathBuf> {
    USER_DATA.get().map(|d| mirror_parent_in(d))
}

/// Every mirror on disk, configured or not. A source removed from the config
/// keeps its history, the same way a deleted local project does.
pub fn mirror_roots() -> Vec<(String, PathBuf)> {
    let Some(parent) = mirror_parent() else { return Vec::new() };
    let Ok(entries) = std::fs::read_dir(&parent) else { return Vec::new() };
    let mut roots: Vec<(String, PathBuf)> = entries
        .flatten()
        .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .map(|e| (e.file_name().to_string_lossy().into_owned(), e.path()))
        .collect();
    roots.sort();
    roots
}

pub fn load_config() -> Config {
    let Some(dir) = USER_DATA.get() else { return Config::default() };
    let config = match std::fs::read_to_string(dir.join(FILE_NAME)) {
        Ok(raw) => parse_config(&raw).unwrap_or_else(|err| {
            crate::journal::note(format!("remote: {FILE_NAME} unreadable: {err}"));
            Config::default()
        }),
        Err(_) => Config::default(),
    };
    let excluded: Vec<String> =
        config.sources.iter().filter(|s| !s.included).map(|s| folder_name(&s.name)).collect();
    *EXCLUDED.lock().unwrap() = excluded;
    config
}

/// Names of the sources switched off, as of the last config read.
static EXCLUDED: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new());

/// Mirror folders whose usage is left out of the totals.
pub fn excluded_mirror_roots() -> Vec<PathBuf> {
    let Some(parent) = mirror_parent() else { return Vec::new() };
    EXCLUDED.lock().unwrap().iter().map(|name| parent.join(name)).collect()
}

pub fn parse_config(raw: &str) -> Result<Config, serde_json::Error> {
    serde_json::from_str(raw)
}

/// A source name becomes a folder name and a project label prefix, so it is
/// kept to characters that are safe in both.
pub fn folder_name(name: &str) -> String {
    let cleaned: String = name
        .trim()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' { c } else { '-' })
        .collect();
    let cleaned = cleaned.trim_matches('.').to_string();
    if cleaned.is_empty() { "remote".to_string() } else { cleaned }
}

/// The readable project name for a remote slug such as
/// `-home-harshal-claude-agents`: the remote home prefix is dropped the same
/// way `C--Users-you-` is for local Windows projects.
pub fn project_label(source: &str, slug: &str) -> String {
    static HOME_RE: OnceLock<regex::Regex> = OnceLock::new();
    let re = HOME_RE.get_or_init(|| {
        regex::Regex::new(r"^(-home-[^-]+|-root|-Users-[^-]+|[A-Za-z]--Users-[^-]+)-?").unwrap()
    });
    let rest = re.replace(slug, "").replace('-', "/");
    let rest = if rest.is_empty() { "~ (home)".to_string() } else { rest };
    format!("{source} · {rest}")
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

/// The script the remote `sh` runs. `have` is what Ember already holds:
/// relative path → size in bytes. With `every` set, the script keeps the
/// connection open and checks again at that interval, ending each round with
/// a tick line; without it, it runs one round and ends.
///
/// The remote side keeps its own copy of the manifest and moves it forward
/// as it sends, so later rounds need nothing more from Ember.
pub fn build_script(remote_path: &str, have: &BTreeMap<String, u64>, every: Option<Duration>) -> String {
    let remote_path = remote_path.trim();
    let dir = if remote_path.starts_with('/') {
        shell_quote(remote_path)
    } else {
        let rel = remote_path.trim_start_matches("~/");
        format!("\"$HOME\"/{}", shell_quote(rel))
    };
    let mut manifest = String::new();
    for (rel, size) in have {
        // Tabs and newlines would break the line format; Claude never writes them.
        if rel.contains(['\t', '\n', '\r']) {
            continue;
        }
        manifest.push_str(&format!("{size}\t{rel}\n"));
    }
    let (loop_head, loop_tail) = match every {
        Some(every) => ("while :; do".to_string(), format!("sleep {}\ndone", every.as_secs().max(1))),
        None => ("for once in 1; do".to_string(), "done".to_string()),
    };
    format!(
        r#"set -u
m=$(mktemp) || exit 1
u=$(mktemp) || exit 1
trap 'rm -f "$m" "$u" "$m.new"' EXIT
cat > "$m" <<'EMBER_MANIFEST_EOF'
{manifest}EMBER_MANIFEST_EOF
{loop_head}
if cd {dir} 2>/dev/null; then
  : > "$u"
  find . -type f -name '*.jsonl' -printf '%s\t%P\n' |
  awk -F '\t' -v m="$m" 'FILENAME == m {{ have[$2]=$1; next }}
    {{ o = 0; if (($2 in have) && have[$2]+0 <= $1+0) o = have[$2]+0;
       if (o != $1+0) printf "%d\t%d\t%s\n", o, $1, $2 }}' "$m" - |
  while IFS='	' read -r off size rel; do
    n=$(tail -c +$((off+1)) -- "$rel" 2>/dev/null | head -c $((size-off)) | wc -c | tr -d ' ')
    printf '{FILE_MARKER}\t%s\t%s\t%s\n' "$off" "$n" "$rel"
    tail -c +$((off+1)) -- "$rel" 2>/dev/null | head -c "$n"
    printf '%s\t%s\n' "$((off+n))" "$rel" >> "$u"
  done
  if [ -s "$u" ]; then
    awk -F '\t' '{{ have[$2]=$1 }} END {{ for (k in have) printf "%s\t%s\n", have[k], k }}' "$m" "$u" > "$m.new" && mv "$m.new" "$m"
  fi
  echo {TICK_MARKER}
else
  echo {TICK_MARKER}	nodir
fi
{loop_tail}
echo {END_MARKER}
"#
    )
}

#[derive(Debug, Default, PartialEq)]
pub struct SyncReport {
    pub files_changed: usize,
    pub bytes: u64,
    /// The remote folder does not exist yet (no Claude Code session there).
    pub no_remote_dir: bool,
}

/// What Ember holds for one mirror: relative path (with `/`) → size.
pub fn local_manifest(mirror: &Path) -> BTreeMap<String, u64> {
    fn walk(base: &Path, dir: &Path, out: &mut BTreeMap<String, u64>) {
        let Ok(entries) = std::fs::read_dir(dir) else { return };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(kind) = entry.file_type() else { continue };
            if kind.is_dir() {
                walk(base, &path, out);
            } else if kind.is_file() && path.extension().is_some_and(|e| e == "jsonl") {
                if let (Ok(rel), Ok(meta)) = (path.strip_prefix(base), entry.metadata()) {
                    let rel: Vec<String> =
                        rel.components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect();
                    out.insert(rel.join("/"), meta.len());
                }
            }
        }
    }
    let mut out = BTreeMap::new();
    walk(mirror, mirror, &mut out);
    out
}

/// A remote path is only accepted if it stays inside the mirror.
fn safe_relative(rel: &str) -> Option<PathBuf> {
    let path = Path::new(rel);
    if rel.is_empty() || !rel.ends_with(".jsonl") {
        return None;
    }
    let mut out = PathBuf::new();
    for comp in path.components() {
        match comp {
            Component::Normal(part) => out.push(part),
            Component::CurDir => {}
            _ => return None,
        }
    }
    (!out.as_os_str().is_empty()).then_some(out)
}

fn read_line(reader: &mut impl std::io::BufRead) -> std::io::Result<Option<String>> {
    let mut buf = Vec::new();
    let n = reader.read_until(b'\n', &mut buf)?;
    if n == 0 {
        return Ok(None);
    }
    if buf.last() == Some(&b'\n') {
        buf.pop();
    }
    Ok(Some(String::from_utf8_lossy(&buf).into_owned()))
}

/// Applies the remote script's output to the mirror, calling `on_tick` with
/// what changed at the end of every round. Each file frame is written only
/// once it has arrived whole, so a dropped connection leaves every file
/// either at its old size or at a complete new one. Returns when the script
/// ends; an error means the stream broke and should be restarted.
pub fn apply_frames(
    mirror: &Path,
    reader: impl Read,
    mut on_tick: impl FnMut(SyncReport),
) -> Result<(), String> {
    let mut reader = std::io::BufReader::new(reader);
    let mut report = SyncReport::default();
    loop {
        let Some(line) = read_line(&mut reader).map_err(|e| e.to_string())? else {
            return Err("connection closed".into());
        };
        let line = line.trim_end_matches('\r');
        if line == END_MARKER {
            return Ok(());
        }
        if let Some(rest) = line.strip_prefix(TICK_MARKER) {
            report.no_remote_dir = rest.trim() == "nodir";
            on_tick(std::mem::take(&mut report));
            continue;
        }
        let mut parts = line.splitn(4, '\t');
        let (Some(FILE_MARKER), Some(off), Some(len), Some(rel)) =
            (parts.next(), parts.next(), parts.next(), parts.next())
        else {
            // Login banners and shell noise before the first frame are skipped.
            continue;
        };
        let off: u64 = off.parse().map_err(|_| format!("bad offset in frame for {rel}"))?;
        let len: u64 = len.parse().map_err(|_| format!("bad length in frame for {rel}"))?;
        let mut data = Vec::with_capacity(len.min(64 << 20) as usize);
        (&mut reader).take(len).read_to_end(&mut data).map_err(|e| e.to_string())?;
        if (data.len() as u64) < len {
            return Err(format!("transfer of {rel} was cut short"));
        }
        let Some(rel_path) = safe_relative(rel) else { continue };
        let target = mirror.join(rel_path);
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let current = std::fs::metadata(&target).map(|m| m.len()).ok();
        if off == 0 {
            crate::persist::write_atomic(&target, &data).map_err(|e| e.to_string())?;
        } else if current == Some(off) {
            if !data.is_empty() {
                let mut file =
                    std::fs::OpenOptions::new().append(true).open(&target).map_err(|e| e.to_string())?;
                file.write_all(&data).map_err(|e| e.to_string())?;
            }
        } else {
            // The local copy changed underneath the stream. Drop it and
            // restart, so the next connection sends it again in full.
            let _ = std::fs::remove_file(&target);
            return Err(format!("local copy of {rel} changed; resyncing"));
        }
        if !data.is_empty() || off == 0 {
            report.files_changed += 1;
            report.bytes += data.len() as u64;
        }
    }
}

/// One round: the whole script output, as a single report.
pub fn apply_stream(mirror: &Path, reader: impl Read) -> Result<SyncReport, String> {
    let mut total = SyncReport::default();
    apply_frames(mirror, reader, |r| {
        total.files_changed += r.files_changed;
        total.bytes += r.bytes;
        total.no_remote_dir |= r.no_remote_dir;
    })?;
    Ok(total)
}

pub fn ssh_args(source: &Source) -> Vec<String> {
    let mut args: Vec<String> = [
        "-T",
        "-o", "BatchMode=yes",
        "-o", "ConnectTimeout=15",
        "-o", "ServerAliveInterval=10",
        "-o", "ServerAliveCountMax=3",
        "-o", "StrictHostKeyChecking=accept-new",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    if let Some(port) = source.port {
        args.push("-p".into());
        args.push(port.to_string());
    }
    if let Some(identity) = source.identity_file.as_deref().filter(|s| !s.trim().is_empty()) {
        args.push("-i".into());
        args.push(expand_home(identity.trim()));
    }
    args.push(source.ssh.trim().to_string());
    args.push("sh -s".into());
    args
}

fn expand_home(value: &str) -> String {
    if let Some(rest) = value.strip_prefix("~/").or_else(|| value.strip_prefix("~\\")) {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest).to_string_lossy().into_owned();
        }
    }
    value.to_string()
}

fn mirror_of(source: &Source) -> Result<PathBuf, String> {
    let mirror = mirror_parent().ok_or("not initialised")?.join(folder_name(&source.name));
    std::fs::create_dir_all(&mirror).map_err(|e| e.to_string())?;
    Ok(mirror)
}

/// Runs ssh with the script for `source` and feeds its output to
/// `apply_frames`. `slot` holds the child while it runs, so another thread
/// can stop it by killing it.
fn run_ssh(
    source: &Source,
    every: Option<Duration>,
    slot: &std::sync::Mutex<Option<std::process::Child>>,
    on_tick: impl FnMut(SyncReport),
) -> Result<(), String> {
    let mirror = mirror_of(source)?;
    let script = build_script(
        source.remote_path.as_deref().unwrap_or(".claude/projects"),
        &local_manifest(&mirror),
        every,
    );
    let program = source.ssh_path.clone().filter(|s| !s.trim().is_empty()).unwrap_or_else(|| "ssh".into());
    let mut cmd = std::process::Command::new(program);
    cmd.args(ssh_args(source))
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = cmd.spawn().map_err(|e| format!("could not start ssh: {e}"))?;
    let mut stdin = child.stdin.take().ok_or("no stdin")?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let mut stderr = child.stderr.take().ok_or("no stderr")?;
    *slot.lock().unwrap() = Some(child);

    let writer = std::thread::spawn(move || {
        let _ = stdin.write_all(script.as_bytes());
    });
    let err_reader = std::thread::spawn(move || {
        let mut text = String::new();
        let _ = stderr.read_to_string(&mut text);
        text
    });
    let result = apply_frames(&mirror, stdout, on_tick);
    let child = slot.lock().unwrap().take();
    if let Some(mut child) = child {
        if result.is_err() {
            let _ = child.kill();
        }
        let _ = child.wait();
    }
    let _ = writer.join();
    let stderr_text = err_reader.join().unwrap_or_default();
    result.map_err(|err| {
        let detail = stderr_text.lines().filter(|l| !l.trim().is_empty()).last().unwrap_or("").trim().to_string();
        if detail.is_empty() { err } else { detail }
    })
}

/// One sync of one source, start to finish. Blocking.
pub fn sync_source(source: &Source) -> Result<SyncReport, String> {
    let slot = std::sync::Mutex::new(None);
    let mut total = SyncReport::default();
    run_ssh(source, None, &slot, |r| {
        total.files_changed += r.files_changed;
        total.bytes += r.bytes;
        total.no_remote_dir |= r.no_remote_dir;
    })?;
    Ok(total)
}

fn record(name: &str, outcome: Result<(), String>) -> bool {
    let mut last = LAST.lock().unwrap();
    let was = last.get(name).map(|r| (r.ok, r.error.clone()));
    let now = (outcome.is_ok(), outcome.as_ref().err().cloned());
    last.insert(name.to_string(), LastSync { ok: now.0, at_ms: crate::now_ms(), error: now.1.clone() });
    let changed = was.as_ref() != Some(&now);
    if changed {
        match &now.1 {
            None => crate::journal::note(format!("remote {name}: connected")),
            Some(err) => crate::journal::note(format!("remote {name}: {err}")),
        }
        let status: serde_json::Map<String, serde_json::Value> = last
            .iter()
            .map(|(k, r)| (k.clone(), serde_json::json!({ "ok": r.ok, "atMs": r.at_ms, "error": r.error })))
            .collect();
        if let Some(dir) = USER_DATA.get() {
            if let Ok(body) = serde_json::to_string_pretty(&serde_json::Value::Object(status)) {
                let _ = crate::persist::write_atomic(&dir.join(STATUS_FILE_NAME), body);
            }
        }
    }
    changed
}

/// What the app does when a round lands: `usage_changed` when new bytes
/// arrived, and always so the light's age can move on.
pub type Notify = std::sync::Arc<dyn Fn(bool) + Send + Sync>;

struct Live {
    source: Source,
    every: Duration,
    stop: std::sync::Arc<std::sync::atomic::AtomicBool>,
    child: std::sync::Arc<std::sync::Mutex<Option<std::process::Child>>>,
}

impl Live {
    fn halt(&self) {
        self.stop.store(true, std::sync::atomic::Ordering::SeqCst);
        if let Some(child) = self.child.lock().unwrap().as_mut() {
            let _ = child.kill();
        }
    }
}

/// Keeps one live connection per enabled source, restarting a connection
/// whose settings changed and reconnecting with backoff after a failure.
/// Runs for the life of the app.
pub async fn supervise(notify: Notify) {
    let mut live: BTreeMap<String, Live> = BTreeMap::new();
    loop {
        let config = load_config();
        let every = config.interval();
        let mut wanted: BTreeMap<String, Source> = BTreeMap::new();
        for source in config.sources.iter().filter(|s| s.enabled && !s.ssh.trim().is_empty()) {
            wanted.entry(folder_name(&source.name)).or_insert_with(|| source.clone());
        }
        live.retain(|name, conn| {
            let keep = wanted.get(name) == Some(&conn.source) && conn.every == every;
            if !keep {
                conn.halt();
            }
            keep
        });
        for (name, source) in wanted {
            if live.contains_key(&name) {
                continue;
            }
            let conn = Live {
                source: source.clone(),
                every,
                stop: Default::default(),
                child: Default::default(),
            };
            let (stop, child, notify) = (conn.stop.clone(), conn.child.clone(), notify.clone());
            let thread_name = name.clone();
            std::thread::spawn(move || keep_connected(&thread_name, &source, every, &stop, &child, &notify));
            live.insert(name, conn);
        }
        wait(Duration::from_secs(5)).await;
    }
}

fn keep_connected(
    name: &str,
    source: &Source,
    every: Duration,
    stop: &std::sync::atomic::AtomicBool,
    child: &std::sync::Mutex<Option<std::process::Child>>,
    notify: &Notify,
) {
    use std::sync::atomic::Ordering;
    let mut backoff = Duration::from_secs(2);
    while !stop.load(Ordering::SeqCst) {
        let result = run_ssh(source, Some(every), child, |report| {
            if stop.load(Ordering::SeqCst) {
                return;
            }
            backoff = Duration::from_secs(2);
            record(name, Ok(()));
            notify(report.files_changed > 0);
        });
        if stop.load(Ordering::SeqCst) {
            break;
        }
        let outcome = match result {
            Ok(()) => Err("the server closed the connection".to_string()),
            Err(err) => Err(err),
        };
        record(name, outcome);
        notify(false);
        let until = std::time::Instant::now() + backoff;
        while std::time::Instant::now() < until && !stop.load(Ordering::SeqCst) {
            std::thread::sleep(Duration::from_millis(200));
        }
        backoff = (backoff * 2).min(Duration::from_secs(60));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "ember-remote-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn config_parses_with_optional_fields_and_clamps_interval() {
        let config = parse_config(
            r#"{ "_help": "x", "intervalSeconds": 0,
                 "sources": [ { "name": "vps", "ssh": "me@host", "port": 2222 } ] }"#,
        )
        .unwrap();
        assert_eq!(config.interval(), Duration::from_secs(MIN_INTERVAL_SECS));
        assert_eq!(config.sources.len(), 1);
        assert!(config.sources[0].enabled);
        assert_eq!(config.sources[0].port, Some(2222));
        assert!(parse_config(TEMPLATE).unwrap().sources.is_empty());
        assert_eq!(parse_config("{}").unwrap().interval(), DEFAULT_INTERVAL);
    }

    #[test]
    fn ssh_never_prompts_and_runs_the_script_from_stdin() {
        let source = Source {
            name: "vps".into(),
            ssh: "me@host".into(),
            port: Some(2222),
            identity_file: Some("/keys/id".into()),
            remote_path: None,
            ssh_path: None,
            enabled: true,
            included: true,
        };
        let args = ssh_args(&source);
        assert!(args.windows(2).any(|w| w == ["-o", "BatchMode=yes"]));
        assert!(args.windows(2).any(|w| w == ["-p", "2222"]));
        assert!(args.windows(2).any(|w| w == ["-i", "/keys/id"]));
        assert_eq!(&args[args.len() - 2..], ["me@host", "sh -s"]);
    }

    #[test]
    fn remote_projects_get_a_readable_label() {
        assert_eq!(project_label("vps", "-home-harshal-claude-agents"), "vps · claude/agents");
        assert_eq!(project_label("vps", "-home-harshal"), "vps · ~ (home)");
        assert_eq!(project_label("vps", "-root-app"), "vps · app");
        assert_eq!(folder_name(" my vps/1 "), "my-vps-1");
        assert_eq!(folder_name(".."), "remote");
    }

    #[test]
    fn switching_a_source_rewrites_only_its_flag() {
        let raw = r#"{ "_help": "keep me", "sources": [
            { "name": "vps", "ssh": "me@a" }, { "name": "box", "ssh": "me@b", "enabled": false } ] }"#;
        let out: serde_json::Value = serde_json::from_str(&set_flag_in(raw, "vps", "enabled", false).unwrap()).unwrap();
        assert_eq!(out["_help"], "keep me");
        assert_eq!(out["sources"][0]["enabled"], false);
        assert_eq!(out["sources"][1]["enabled"], false);
        let back: serde_json::Value = serde_json::from_str(&set_flag_in(raw, "box", "enabled", true).unwrap()).unwrap();
        assert_eq!(back["sources"][1]["enabled"], true);
        assert!(set_flag_in(raw, "nope", "included", true).is_err());
    }

    fn input(name: &str, ssh: &str) -> SourceInput {
        SourceInput { name: name.into(), ssh: ssh.into(), port: None, identity_file: None, enabled: true }
    }

    #[test]
    fn the_servers_dialog_adds_edits_and_validates() {
        let mut doc: serde_json::Value = serde_json::from_str(TEMPLATE).unwrap();
        upsert_in(&mut doc, None, &input("vps", "me@a")).unwrap();
        let mut second = input("box", "me@b");
        second.port = Some(2222);
        second.identity_file = Some("  C:\\keys\\id  ".into());
        upsert_in(&mut doc, None, &second).unwrap();
        assert_eq!(doc["sources"][1]["port"], 2222);
        assert_eq!(doc["sources"][1]["identityFile"], "C:\\keys\\id");
        assert_eq!(doc["_help"], parse_config(TEMPLATE).map(|_| doc["_help"].clone()).unwrap());

        // Hand-edited fields survive an edit from the dialog; cleared ones go.
        doc["sources"][1]["remotePath"] = "logs".into();
        upsert_in(&mut doc, Some("box"), &input("box-2", "me@c")).unwrap();
        assert_eq!(doc["sources"][1]["name"], "box-2");
        assert_eq!(doc["sources"][1]["remotePath"], "logs");
        assert!(doc["sources"][1].get("port").is_none());

        assert!(upsert_in(&mut doc, None, &input("vps", "me@z")).unwrap_err().contains("already"));
        assert!(upsert_in(&mut doc, Some("box-2"), &input("vps", "me@z")).is_err());
        assert!(upsert_in(&mut doc, None, &input(" ", "me@z")).is_err());
        assert!(upsert_in(&mut doc, None, &input("x", "me @z")).is_err());
        assert!(upsert_in(&mut doc, None, &input("x", "-oProxyCommand=x")).is_err());
        assert!(upsert_in(&mut doc, Some("gone"), &input("x", "me@z")).is_err());
        let config: Config = serde_json::from_value(doc).unwrap();
        assert_eq!(config.sources.len(), 2);
    }

    #[test]
    fn frames_cannot_escape_the_mirror() {
        assert!(safe_relative("../evil.jsonl").is_none());
        assert!(safe_relative("/etc/evil.jsonl").is_none());
        assert!(safe_relative("p/notes.txt").is_none());
        assert_eq!(safe_relative("p/s.jsonl"), Some(PathBuf::from("p").join("s.jsonl")));
    }

    #[test]
    fn a_cut_off_transfer_writes_nothing_partial() {
        let mirror = temp_dir("cut");
        let stream = b"FILE\nEMBER-FILE\t0\t10\tp/a.jsonl\nabc".to_vec();
        assert!(apply_stream(&mirror, &stream[..]).is_err());
        assert!(!mirror.join("p/a.jsonl").exists());
        let _ = std::fs::remove_dir_all(&mirror);
    }

    /// Runs the real remote script with the local `sh` against a temp folder,
    /// end to end: first copy, append, a shrunken file, and nothing to do.
    #[cfg(unix)]
    #[test]
    fn the_remote_script_mirrors_incrementally() {
        let remote = temp_dir("src");
        let mirror = temp_dir("dst");
        let run = |mirror: &Path| -> SyncReport {
            let script = build_script(remote.to_str().unwrap(), &local_manifest(mirror), None);
            let mut child = std::process::Command::new("sh")
                .arg("-s")
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::piped())
                .spawn()
                .unwrap();
            child.stdin.take().unwrap().write_all(script.as_bytes()).unwrap();
            let report = apply_stream(mirror, child.stdout.take().unwrap()).unwrap();
            child.wait().unwrap();
            report
        };
        std::fs::create_dir_all(remote.join("-home-me-app/sess/subagents")).unwrap();
        std::fs::write(remote.join("-home-me-app/s1.jsonl"), "{\"a\":1}\n").unwrap();
        std::fs::write(remote.join("-home-me-app/sess/subagents/x.jsonl"), "{\"b\":2}\n").unwrap();
        std::fs::write(remote.join("-home-me-app/ignore.txt"), "nope").unwrap();

        let first = run(&mirror);
        assert_eq!(first.files_changed, 2);
        assert_eq!(std::fs::read_to_string(mirror.join("-home-me-app/s1.jsonl")).unwrap(), "{\"a\":1}\n");
        assert!(!mirror.join("-home-me-app/ignore.txt").exists());

        assert_eq!(run(&mirror), SyncReport::default());

        let mut f = std::fs::OpenOptions::new().append(true).open(remote.join("-home-me-app/s1.jsonl")).unwrap();
        f.write_all(b"{\"a\":2}\n").unwrap();
        drop(f);
        let appended = run(&mirror);
        assert_eq!((appended.files_changed, appended.bytes), (1, 8));
        assert_eq!(
            std::fs::read_to_string(mirror.join("-home-me-app/s1.jsonl")).unwrap(),
            "{\"a\":1}\n{\"a\":2}\n"
        );

        std::fs::write(remote.join("-home-me-app/sess/subagents/x.jsonl"), "{}\n").unwrap();
        run(&mirror);
        assert_eq!(
            std::fs::read_to_string(mirror.join("-home-me-app/sess/subagents/x.jsonl")).unwrap(),
            "{}\n"
        );

        let missing = build_script("/definitely/not/here", &BTreeMap::new(), None);
        let out = std::process::Command::new("sh").arg("-c").arg(&missing).output().unwrap();
        assert!(apply_stream(&mirror, &out.stdout[..]).unwrap().no_remote_dir);

        let _ = std::fs::remove_dir_all(&remote);
        let _ = std::fs::remove_dir_all(&mirror);
    }

    /// The live mode: one script run keeps sending new bytes, round after
    /// round, without Ember sending anything more.
    #[cfg(unix)]
    #[test]
    fn the_live_script_streams_appends_as_they_happen() {
        let remote = temp_dir("live-src");
        let mirror = temp_dir("live-dst");
        std::fs::create_dir_all(remote.join("p")).unwrap();
        std::fs::write(remote.join("p/s.jsonl"), "1\n").unwrap();
        let script = build_script(remote.to_str().unwrap(), &BTreeMap::new(), Some(Duration::from_secs(1)));
        let mut child = std::process::Command::new("sh")
            .arg("-s")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        child.stdin.take().unwrap().write_all(script.as_bytes()).unwrap();
        let stdout = child.stdout.take().unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        let m = mirror.clone();
        let reader = std::thread::spawn(move || apply_frames(&m, stdout, |r| { let _ = tx.send(r); }));
        let wait_for_change = || loop {
            let r = rx.recv_timeout(Duration::from_secs(10)).expect("a tick");
            if r.files_changed > 0 {
                return r;
            }
        };
        assert_eq!(wait_for_change().bytes, 2);
        for (i, line) in ["2\n", "33\n"].iter().enumerate() {
            let mut f = std::fs::OpenOptions::new().append(true).open(remote.join("p/s.jsonl")).unwrap();
            f.write_all(line.as_bytes()).unwrap();
            drop(f);
            let r = wait_for_change();
            assert_eq!((r.files_changed, r.bytes), (1, line.len() as u64), "round {i}");
        }
        std::fs::write(remote.join("p/new.jsonl"), "x\n").unwrap();
        assert_eq!(wait_for_change().files_changed, 1);
        assert_eq!(std::fs::read_to_string(mirror.join("p/s.jsonl")).unwrap(), "1\n2\n33\n");
        assert_eq!(std::fs::read_to_string(mirror.join("p/new.jsonl")).unwrap(), "x\n");
        child.kill().unwrap();
        let _ = child.wait();
        assert!(reader.join().unwrap().is_err(), "a killed stream reports a break");
        let _ = std::fs::remove_dir_all(&remote);
        let _ = std::fs::remove_dir_all(&mirror);
    }

    /// Manual end to end check against a real ssh server:
    /// EMBER_E2E_SSH=user@host EMBER_E2E_KEY=/path/key EMBER_E2E_DATA=/tmp/dir
    /// cargo test --lib e2e_over_ssh -- --ignored --nocapture
    /// Prices the server's real logs read locally, then mirrors them over ssh
    /// and prices the mirror alone; both totals should agree.
    #[test]
    #[ignore]
    fn e2e_over_ssh() {
        use crate::providers::claude_usage;
        let target = std::env::var("EMBER_E2E_SSH").expect("EMBER_E2E_SSH");
        let data = PathBuf::from(std::env::var("EMBER_E2E_DATA").expect("EMBER_E2E_DATA"));
        let sum = |agg: &claude_usage::Aggregate| -> (u64, f64, f64, Vec<String>) {
            let mut projects: Vec<String> = agg.buckets.iter().map(|b| b.project.clone()).collect();
            projects.sort();
            projects.dedup();
            (
                agg.buckets.iter().map(|b| b.msgs).sum(),
                agg.buckets.iter().map(|b| b.input + b.output + b.cache_read + b.cache_w5m + b.cache_w1h).sum(),
                agg.buckets.iter().map(|b| b.cost).sum(),
                projects,
            )
        };
        let local = sum(&claude_usage::aggregate());
        println!("read locally   : {} calls, {:.0} tokens, ${:.2}, projects {:?}", local.0, local.1, local.2, local.3);

        init(&data);
        let source = Source {
            name: "vps".into(),
            ssh: target,
            port: None,
            identity_file: std::env::var("EMBER_E2E_KEY").ok(),
            remote_path: None,
            ssh_path: None,
            enabled: true,
            included: true,
        };
        let first = sync_source(&source).expect("first sync");
        println!("first sync    : {first:?}");
        let second = sync_source(&source).expect("second sync");
        println!("second sync   : {second:?}");

        // Hide the local logs so only the mirror is read.
        let empty = data.join("empty-home");
        std::fs::create_dir_all(&empty).unwrap();
        std::env::set_var("HOME", &empty);
        claude_usage::init(&empty); // forget the files read in the first pass
        let mirrored = sum(&claude_usage::aggregate());
        println!("via ssh mirror: {} calls, {:.0} tokens, ${:.2}, projects {:?}", mirrored.0, mirrored.1, mirrored.2, mirrored.3);
        assert!(mirrored.0 > 0);
        assert!(mirrored.3.iter().all(|p| p.starts_with("vps · ")));

        // Switched off from the pill: out of every total, records kept.
        std::fs::write(
            data.join(FILE_NAME),
            r#"{ "sources": [ { "name": "vps", "ssh": "x", "included": false } ] }"#,
        )
        .unwrap();
        load_config();
        claude_usage::invalidate();
        let off = sum(&claude_usage::aggregate());
        println!("switched off  : {} calls, ${:.2}", off.0, off.2);
        assert_eq!(off.0, 0);
        set_included("vps", true).unwrap();
        claude_usage::invalidate();
        let on = sum(&claude_usage::aggregate());
        println!("switched on   : {} calls, ${:.2}", on.0, on.2);
        assert_eq!((on.0, on.1), (mirrored.0, mirrored.1));

        // Renamed in the Servers dialog: same usage, new label, nothing doubled.
        let rename = SourceInput { name: "box".into(), ssh: "x".into(), port: None, identity_file: None, enabled: true };
        save_source(Some("vps"), &rename).unwrap();
        claude_usage::invalidate();
        let renamed = sum(&claude_usage::aggregate());
        println!("renamed       : {} calls, ${:.2}, projects {:?}", renamed.0, renamed.2, renamed.3);
        assert_eq!((renamed.0, renamed.1), (mirrored.0, mirrored.1));
        assert!(renamed.3.iter().all(|p| p.starts_with("box · ")));

        // Deleted: its usage goes too, instead of lingering as history.
        delete_source("box").unwrap();
        claude_usage::invalidate();
        let deleted = sum(&claude_usage::aggregate());
        println!("deleted       : {} calls, ${:.2}", deleted.0, deleted.2);
        assert_eq!(deleted.0, 0);
        assert!(!data.join("remote/box").exists());
        assert!(load_config().sources.is_empty());
    }

    /// Manual: how long a new line takes to arrive over a live ssh stream.
    /// Same env vars as `e2e_over_ssh`.
    #[test]
    #[ignore]
    fn e2e_live_latency() {
        let data = PathBuf::from(std::env::var("EMBER_E2E_DATA").expect("EMBER_E2E_DATA"));
        init(&data);
        let remote = data.join("live-remote");
        std::fs::create_dir_all(remote.join("p")).unwrap();
        std::fs::write(remote.join("p/s.jsonl"), "{}\n").unwrap();
        let source = Source {
            name: "live".into(),
            ssh: std::env::var("EMBER_E2E_SSH").unwrap(),
            port: None,
            identity_file: std::env::var("EMBER_E2E_KEY").ok(),
            remote_path: Some(remote.to_string_lossy().into_owned()),
            ssh_path: None,
            enabled: true,
            included: true,
        };
        let slot = std::sync::Arc::new(std::sync::Mutex::new(None));
        let (tx, rx) = std::sync::mpsc::channel();
        let (s2, src) = (slot.clone(), source.clone());
        let t = std::thread::spawn(move || run_ssh(&src, Some(Duration::from_secs(2)), &s2, |r| { let _ = tx.send(r); }));
        let first = rx.recv_timeout(Duration::from_secs(20)).unwrap();
        println!("connected, first round: {first:?}");
        let mut worst = Duration::ZERO;
        for i in 0..5 {
            std::thread::sleep(Duration::from_millis(700 * i + 300));
            let t0 = std::time::Instant::now();
            let mut f = std::fs::OpenOptions::new().append(true).open(remote.join("p/s.jsonl")).unwrap();
            f.write_all(b"{\"n\":1}\n").unwrap();
            drop(f);
            loop {
                let r = rx.recv_timeout(Duration::from_secs(20)).unwrap();
                if r.files_changed > 0 { break; }
            }
            let took = t0.elapsed();
            worst = worst.max(took);
            println!("line {i} arrived after {:.2}s", took.as_secs_f64());
        }
        assert_eq!(
            std::fs::read_to_string(data.join("remote/live/p/s.jsonl")).unwrap(),
            std::fs::read_to_string(remote.join("p/s.jsonl")).unwrap()
        );
        println!("worst: {:.2}s", worst.as_secs_f64());
        if let Some(c) = slot.lock().unwrap().as_mut() { let _ = c.kill(); }
        let _ = t.join();
    }
}
