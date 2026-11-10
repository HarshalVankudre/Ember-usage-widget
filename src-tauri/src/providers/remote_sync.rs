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
//! The transfer is incremental. Ember sends the size it already holds for
//! each file. The remote shell script sends back only the bytes past that
//! point, or the whole file if it shrank. Transcripts are append-only, so a
//! quiet sync moves a file listing and nothing else. The only remote
//! requirements are `sh`, GNU `find`, `tail`, `head`, `wc` and `awk`, which
//! any Linux server has.

use serde::Deserialize;
use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;

pub const FILE_NAME: &str = "remote-sources.json";
pub const STATUS_FILE_NAME: &str = "remote-sources-status.json";
pub const DEFAULT_INTERVAL: Duration = Duration::from_secs(60);
const MIN_INTERVAL_SECS: u64 = 15;
/// A sync that has not finished by then is abandoned and retried next round.
const SYNC_TIMEOUT: Duration = Duration::from_secs(300);
const END_MARKER: &str = "EMBER-END";
const FILE_MARKER: &str = "EMBER-FILE";
const NO_DIR_MARKER: &str = "EMBER-NODIR";

const TEMPLATE: &str = r#"{
  "_help": "Claude Code usage from other machines on the same plan, such as a server. Each source is reached with your ssh client (key-based login, no password prompt) and its ~/.claude/projects logs are copied here and added to Ember's totals. Projects show as '<name> · <project>'. Ember rereads this file on every sync, so no restart is needed. 'port', 'identityFile', 'remotePath' (relative to the remote home unless it starts with /), 'sshPath' and 'enabled' are optional.",
  "_example": {
    "sources": [
      { "name": "vps", "ssh": "harshal@203.0.113.7", "port": 22, "identityFile": "~/.ssh/id_ed25519" }
    ]
  },
  "intervalSeconds": 60,
  "sources": []
}
"#;

#[derive(Clone, Debug, Deserialize, PartialEq)]
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

/// Creates the config template and the mirror folder, so the folder watcher
/// has something to attach to from the first launch.
pub fn init(user_data: &Path) {
    let _ = USER_DATA.set(user_data.to_path_buf());
    let path = user_data.join(FILE_NAME);
    if !path.exists() {
        let _ = crate::persist::write_atomic(&path, TEMPLATE);
    }
    let _ = std::fs::create_dir_all(mirror_parent_in(user_data));
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
    match std::fs::read_to_string(dir.join(FILE_NAME)) {
        Ok(raw) => parse_config(&raw).unwrap_or_else(|err| {
            crate::journal::note(format!("remote: {FILE_NAME} unreadable: {err}"));
            Config::default()
        }),
        Err(_) => Config::default(),
    }
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
/// relative path → size in bytes.
pub fn build_script(remote_path: &str, have: &BTreeMap<String, u64>) -> String {
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
    format!(
        r#"set -u
cd {dir} 2>/dev/null || {{ echo {NO_DIR_MARKER}; exit 0; }}
m=$(mktemp) || exit 1
trap 'rm -f "$m"' EXIT
cat > "$m" <<'EMBER_MANIFEST_EOF'
{manifest}EMBER_MANIFEST_EOF
find . -type f -name '*.jsonl' -printf '%s\t%P\n' |
awk -F '\t' -v m="$m" 'FILENAME == m {{ have[$2]=$1; next }}
  {{ o = 0; if (($2 in have) && have[$2]+0 <= $1+0) o = have[$2]+0;
     if (o != $1+0) printf "%d\t%d\t%s\n", o, $1, $2 }}' "$m" - |
while IFS='	' read -r off size rel; do
  n=$(tail -c +$((off+1)) -- "$rel" 2>/dev/null | head -c $((size-off)) | wc -c | tr -d ' ')
  printf '{FILE_MARKER}\t%s\t%s\t%s\n' "$off" "$n" "$rel"
  tail -c +$((off+1)) -- "$rel" 2>/dev/null | head -c "$n"
done
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

fn read_line(reader: &mut impl Read) -> std::io::Result<Option<String>> {
    let mut buf = Vec::new();
    let mut byte = [0u8; 1];
    loop {
        match reader.read(&mut byte)? {
            0 => return Ok(if buf.is_empty() { None } else { Some(String::from_utf8_lossy(&buf).into_owned()) }),
            _ if byte[0] == b'\n' => return Ok(Some(String::from_utf8_lossy(&buf).into_owned())),
            _ => buf.push(byte[0]),
        }
    }
}

/// Applies the remote script's output to the mirror. Each file frame is
/// written only once it has arrived whole, so a dropped connection leaves
/// every file either at its old size or at a complete new one.
pub fn apply_stream(mirror: &Path, reader: impl Read) -> Result<SyncReport, String> {
    let mut reader = std::io::BufReader::new(reader);
    let mut report = SyncReport::default();
    loop {
        let Some(line) = read_line(&mut reader).map_err(|e| e.to_string())? else {
            return Err("connection closed before the transfer finished".into());
        };
        let line = line.trim_end_matches('\r');
        if line == END_MARKER {
            return Ok(report);
        }
        if line == NO_DIR_MARKER {
            report.no_remote_dir = true;
            return Ok(report);
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
        let mut data = Vec::with_capacity(len as usize);
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
        if off == 0 || current != Some(off) {
            if off != 0 {
                // The local copy changed underneath us; take it again in full next round.
                let _ = std::fs::remove_file(&target);
                continue;
            }
            crate::persist::write_atomic(&target, &data).map_err(|e| e.to_string())?;
        } else if !data.is_empty() {
            let mut file = std::fs::OpenOptions::new().append(true).open(&target).map_err(|e| e.to_string())?;
            file.write_all(&data).map_err(|e| e.to_string())?;
        }
        if !data.is_empty() || off == 0 {
            report.files_changed += 1;
            report.bytes += data.len() as u64;
        }
    }
}

pub fn ssh_args(source: &Source) -> Vec<String> {
    let mut args: Vec<String> = [
        "-T",
        "-o", "BatchMode=yes",
        "-o", "ConnectTimeout=15",
        "-o", "ServerAliveInterval=15",
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

/// One sync of one source. Blocking; run it off the async runtime.
pub fn sync_source(source: &Source) -> Result<SyncReport, String> {
    let parent = mirror_parent().ok_or("not initialised")?;
    let mirror = parent.join(folder_name(&source.name));
    std::fs::create_dir_all(&mirror).map_err(|e| e.to_string())?;
    let have = local_manifest(&mirror);
    let script = build_script(source.remote_path.as_deref().unwrap_or(".claude/projects"), &have);

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
    let writer = std::thread::spawn(move || {
        let _ = stdin.write_all(script.as_bytes());
    });
    let mut stderr = child.stderr.take().ok_or("no stderr")?;
    let err_reader = std::thread::spawn(move || {
        let mut text = String::new();
        let _ = stderr.read_to_string(&mut text);
        text
    });
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let result = apply_stream(&mirror, stdout);
    let _ = writer.join();
    let status = child.wait().map_err(|e| e.to_string())?;
    let stderr_text = err_reader.join().unwrap_or_default();
    match result {
        Ok(report) => Ok(report),
        Err(err) => {
            let detail = stderr_text.lines().filter(|l| !l.trim().is_empty()).last().unwrap_or("").trim().to_string();
            if detail.is_empty() {
                Err(format!("{err} (ssh exit {status})"))
            } else {
                Err(format!("{detail} (ssh exit {status})"))
            }
        }
    }
}

/// Runs one round over every enabled source and records the outcome in
/// `remote-sources-status.json`. Returns whether any mirror changed.
pub async fn sync_all(config: &Config) -> bool {
    let mut changed = false;
    let mut status = serde_json::Map::new();
    let mut seen = std::collections::HashSet::new();
    for source in config.sources.iter().filter(|s| s.enabled && !s.ssh.trim().is_empty()) {
        let name = folder_name(&source.name);
        if !seen.insert(name.clone()) {
            continue;
        }
        let owned = source.clone();
        let outcome = tokio::time::timeout(
            SYNC_TIMEOUT,
            tokio::task::spawn_blocking(move || sync_source(&owned)),
        )
        .await;
        let outcome = match outcome {
            Ok(Ok(result)) => result,
            Ok(Err(join)) => Err(join.to_string()),
            Err(_) => Err("timed out".into()),
        };
        let now = chrono::Local::now().to_rfc3339();
        let entry = match &outcome {
            Ok(report) => {
                if report.files_changed > 0 {
                    changed = true;
                    crate::journal::note(format!(
                        "remote {name}: {} file(s), {} bytes",
                        report.files_changed, report.bytes
                    ));
                }
                serde_json::json!({
                    "ok": true, "at": now, "filesChanged": report.files_changed,
                    "bytes": report.bytes, "noRemoteDir": report.no_remote_dir,
                })
            }
            Err(err) => {
                crate::journal::note(format!("remote {name}: sync failed: {err}"));
                serde_json::json!({ "ok": false, "at": now, "error": err })
            }
        };
        status.insert(name, entry);
    }
    if let Some(dir) = USER_DATA.get() {
        if let Ok(body) = serde_json::to_string_pretty(&serde_json::Value::Object(status)) {
            let _ = crate::persist::write_atomic(&dir.join(STATUS_FILE_NAME), body);
        }
    }
    changed
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
            r#"{ "_help": "x", "intervalSeconds": 3,
                 "sources": [ { "name": "vps", "ssh": "me@host", "port": 2222 } ] }"#,
        )
        .unwrap();
        assert_eq!(config.interval(), Duration::from_secs(MIN_INTERVAL_SECS));
        assert_eq!(config.sources.len(), 1);
        assert!(config.sources[0].enabled);
        assert_eq!(config.sources[0].port, Some(2222));
        assert!(parse_config(TEMPLATE).unwrap().sources.is_empty());
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
            let script = build_script(remote.to_str().unwrap(), &local_manifest(mirror));
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

        let missing = build_script("/definitely/not/here", &BTreeMap::new());
        let out = std::process::Command::new("sh").arg("-c").arg(&missing).output().unwrap();
        assert!(apply_stream(&mirror, &out.stdout[..]).unwrap().no_remote_dir);

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
    }
}
