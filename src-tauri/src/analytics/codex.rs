//! OpenAI Codex CLI usage ingest. Codex writes local rollout JSONL files under
//! `~/.codex/sessions` (and `archived_sessions`). We retain only token counts,
//! subscription-limit snapshots, model, timestamp, thread id and cwd basename;
//! prompt/response content and auth data are never stored.

use std::fs::File;
use std::io::{BufRead, BufReader, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::analytics::stats::{CcUsageRow, CodexLimitFileState, StatsDb};

const LIMITS_FORMULA_VERSION: i64 = 1;
const OPENAI_PRICES_JSON: &str =
    include_str!("../../../scripts/cli/models/openai-prices.json");

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
struct RolloutContext {
    session_id: Option<String>,
    project: Option<String>,
    model: Option<String>,
}

fn parse_rollout_file(
    path: &Path,
    start_offset: u64,
    mut ctx: RolloutContext,
) -> (Vec<CcUsageRow>, u64, RolloutContext) {
    let Ok(mut file) = File::open(path) else {
        return (Vec::new(), start_offset, ctx);
    };
    if file.seek(SeekFrom::Start(start_offset)).is_err() {
        return (Vec::new(), start_offset, ctx);
    }
    let mut reader = BufReader::new(file);
    let mut line = String::new();
    let mut byte_offset = start_offset;
    let mut rows = Vec::new();
    loop {
        line.clear();
        let bytes = match reader.read_line(&mut line) {
            Ok(0) | Err(_) => break,
            Ok(bytes) => bytes,
        };
        if !line.ends_with('\n') {
            break;
        }
        byte_offset += bytes as u64;
        if let Some(row) = parse_rollout_line(line.trim_end_matches(['\r', '\n']), &mut ctx) {
            rows.push(row);
        }
    }
    (rows, byte_offset, ctx)
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexLimitWindow {
    pub used_percent: f64,
    pub window_minutes: i64,
    pub resets_at: i64,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexCredits {
    pub has_credits: bool,
    pub unlimited: bool,
    pub balance: String,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexRateLimits {
    pub observed_at: String,
    pub limit_id: String,
    pub plan_type: Option<String>,
    pub primary: Option<CodexLimitWindow>,
    pub secondary: Option<CodexLimitWindow>,
    pub credits: Option<CodexCredits>,
    pub rate_limit_reached_type: Option<String>,
}

fn parse_limit_window(value: Option<&Value>) -> Option<CodexLimitWindow> {
    let value = value?;
    Some(CodexLimitWindow {
        used_percent: value.get("used_percent")?.as_f64()?,
        window_minutes: value.get("window_minutes")?.as_i64()?,
        resets_at: value.get("resets_at")?.as_i64()?,
    })
}

fn scalar_string(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => n.to_string(),
        _ => String::new(),
    }
}

fn parse_rate_limits_line(line: &str) -> Option<CodexRateLimits> {
    if !line.contains("\"rate_limits\"") {
        return None;
    }
    let value: Value = serde_json::from_str(line).ok()?;
    if value.get("type").and_then(Value::as_str) != Some("event_msg") {
        return None;
    }
    let payload = value.get("payload")?;
    if payload.get("type").and_then(Value::as_str) != Some("token_count") {
        return None;
    }
    let limits = payload.get("rate_limits")?;
    let primary = parse_limit_window(limits.get("primary"));
    let secondary = parse_limit_window(limits.get("secondary"));
    if primary.is_none() && secondary.is_none() {
        return None;
    }
    let credits = limits.get("credits").map(|value| CodexCredits {
        has_credits: value
            .get("has_credits")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        unlimited: value
            .get("unlimited")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        balance: scalar_string(value.get("balance")),
    });
    Some(CodexRateLimits {
        observed_at: value.get("timestamp")?.as_str()?.to_string(),
        limit_id: limits
            .get("limit_id")
            .and_then(Value::as_str)
            .unwrap_or("codex")
            .to_string(),
        plan_type: limits
            .get("plan_type")
            .and_then(Value::as_str)
            .map(str::to_string),
        primary,
        secondary,
        credits,
        rate_limit_reached_type: limits
            .get("rate_limit_reached_type")
            .and_then(Value::as_str)
            .map(str::to_string),
    })
}

fn project_name(cwd: &str) -> Option<String> {
    let name = cwd
        .trim_end_matches(['/', '\\'])
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or("")
        .trim();
    (!name.is_empty()).then(|| name.to_string())
}

#[derive(Deserialize)]
struct OpenAiPriceRule {
    r#match: String,
    models: Vec<String>,
    input: f64,
    cached_input: f64,
    output: f64,
}

fn openai_prices() -> &'static [OpenAiPriceRule] {
    static PRICES: OnceLock<Vec<OpenAiPriceRule>> = OnceLock::new();
    PRICES.get_or_init(|| {
        serde_json::from_str(OPENAI_PRICES_JSON)
            .expect("scripts/cli/models/openai-prices.json must be valid")
    })
}

/// Current OpenAI API list prices per million (input, cached input, output).
/// Rules are shared with the CLI. Unknown models remain visible with zero
/// estimated cost.
pub fn price_per_mtok(model: &str) -> Option<(f64, f64, f64)> {
    let m = model.to_ascii_lowercase();
    openai_prices().iter().find_map(|rule| {
        let matched = rule.models.iter().any(|name| match rule.r#match.as_str() {
            "exact" => m == *name,
            "contains" => m.contains(name),
            _ => false,
        });
        matched.then_some((rule.input, rule.cached_input, rule.output))
    })
}

pub fn cost_for(model: &str, input: i64, output: i64, cache_write: i64, cache_read: i64) -> f64 {
    let Some((pin, pcached, pout)) = price_per_mtok(model) else {
        return 0.0;
    };
    let fresh = (input - cache_read - cache_write).max(0) as f64;
    (fresh * pin
        + cache_read as f64 * pcached
        + cache_write as f64 * pin * 1.25
        + output as f64 * pout)
        / 1_000_000.0
}

fn parse_rollout_line(line: &str, ctx: &mut RolloutContext) -> Option<CcUsageRow> {
    let v: Value = serde_json::from_str(line).ok()?;
    let kind = v.get("type").and_then(Value::as_str)?;
    let payload = v.get("payload").unwrap_or(&Value::Null);
    match kind {
        "session_meta" => {
            ctx.session_id = payload
                .get("id")
                .and_then(Value::as_str)
                .map(str::to_string);
            ctx.project = payload
                .get("cwd")
                .and_then(Value::as_str)
                .and_then(project_name);
            return None;
        }
        "turn_context" => {
            ctx.model = payload
                .get("model")
                .and_then(Value::as_str)
                .map(str::to_string);
            if let Some(project) = payload
                .get("cwd")
                .and_then(Value::as_str)
                .and_then(project_name)
            {
                ctx.project = Some(project);
            }
            return None;
        }
        "event_msg" if payload.get("type").and_then(Value::as_str) == Some("token_count") => {}
        _ => return None,
    }

    let info = payload.get("info")?;
    let usage = info.get("last_token_usage")?;
    let input = usage
        .get("input_tokens")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let output = usage
        .get("output_tokens")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let cache_read = usage
        .get("cached_input_tokens")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let cache_create = usage
        .get("cache_write_input_tokens")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    if input == 0 && output == 0 && cache_read == 0 && cache_create == 0 {
        return None;
    }
    let ts = v.get("timestamp")?.as_str()?.to_string();
    let model = ctx.model.clone().unwrap_or_else(|| "codex-unknown".into());
    let session = ctx.session_id.clone();
    // `token_count` may repeat the same last-turn snapshot (for example when
    // only rate-limit information changes). The cumulative counters identify
    // that snapshot stably across repeats and file rescans; older events that
    // lack them fall back to their timestamp plus the mutually exclusive
    // token buckets, without an order-dependent sequence number.
    let event_key = if let Some(total) = info.get("total_token_usage") {
        format!(
            "total:{}:{}:{}:{}",
            total
                .get("input_tokens")
                .and_then(Value::as_i64)
                .unwrap_or(0),
            total
                .get("cached_input_tokens")
                .and_then(Value::as_i64)
                .unwrap_or(0),
            total
                .get("cache_write_input_tokens")
                .and_then(Value::as_i64)
                .unwrap_or(0),
            total
                .get("output_tokens")
                .and_then(Value::as_i64)
                .unwrap_or(0),
        )
    } else {
        format!("at:{ts}:{input}:{cache_read}:{cache_create}:{output}")
    };
    let message_id = format!(
        "codex:{}:{event_key}",
        session.as_deref().unwrap_or("unknown")
    );
    Some(CcUsageRow {
        message_id,
        ts,
        model: model.clone(),
        // Existing analytics expects mutually exclusive input/cache buckets.
        input: (input - cache_read - cache_create).max(0),
        output,
        cache_create,
        cache_read,
        cost: cost_for(&model, input, output, cache_create, cache_read),
        session_id: session,
        project: ctx.project.clone(),
        is_subagent: false,
        agent_name: Some("codex".into()),
        agent_id: None,
        tool_uses: Vec::new(),
        service_tier: None,
        git_commits: 0,
        git_pushes: 0,
    })
}

fn collect_jsonl(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_jsonl(&path, out);
        } else if path.extension().and_then(|x| x.to_str()) == Some("jsonl")
            && path
                .file_name()
                .and_then(|x| x.to_str())
                .map(|x| x.starts_with("rollout-"))
                .unwrap_or(false)
        {
            out.push(path);
        }
    }
}

fn mtime_key(modified: Result<SystemTime, std::io::Error>) -> String {
    modified
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|value| format!("{}.{:09}", value.as_secs(), value.subsec_nanos()))
        .unwrap_or_default()
}

fn newer_snapshot(
    current: &mut Option<(DateTime<Utc>, CodexRateLimits)>,
    candidate: CodexRateLimits,
) {
    let Ok(timestamp) = DateTime::parse_from_rfc3339(&candidate.observed_at) else {
        return;
    };
    let timestamp = timestamp.with_timezone(&Utc);
    if current.as_ref().is_none_or(|(old, _)| timestamp > *old) {
        *current = Some((timestamp, candidate));
    }
}

fn scan_limits_tail(
    path: &Path,
    offset: u64,
    mut latest: Option<(DateTime<Utc>, CodexRateLimits)>,
) -> Result<(u64, Option<(DateTime<Utc>, CodexRateLimits)>), String> {
    let mut file = File::open(path).map_err(|e| e.to_string())?;
    file.seek(SeekFrom::Start(offset))
        .map_err(|e| e.to_string())?;
    let mut reader = BufReader::new(file);
    let mut complete_offset = offset;
    let mut bytes = Vec::new();
    loop {
        bytes.clear();
        let read = reader
            .read_until(b'\n', &mut bytes)
            .map_err(|e| e.to_string())?;
        if read == 0 || bytes.last() != Some(&b'\n') {
            break;
        }
        complete_offset += read as u64;
        let line = String::from_utf8_lossy(&bytes);
        if let Some(snapshot) = parse_rate_limits_line(line.trim_end_matches(['\r', '\n'])) {
            newer_snapshot(&mut latest, snapshot);
        }
    }
    Ok((complete_offset, latest))
}

/// Latest subscription-limit snapshot emitted by a locally authenticated Codex
/// session. No ChatGPT bearer token or OpenAI Admin key is read or transmitted.
pub fn latest_limits(base: &Path, db: &StatsDb) -> Result<Option<CodexRateLimits>, String> {
    static PASS_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    let _pass = PASS_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut paths = Vec::new();
    collect_jsonl(&base.join("sessions"), &mut paths);
    collect_jsonl(&base.join("archived_sessions"), &mut paths);
    let mut states = db.codex_limit_file_states().unwrap_or_default();
    let mut newest = None;
    for path in paths {
        let Ok(meta) = std::fs::metadata(&path) else {
            continue;
        };
        let size = meta.len();
        let mtime = mtime_key(meta.modified());
        let key = path.to_string_lossy().to_string();
        let stored = states.remove(&key);
        let reusable = stored.as_ref().filter(|state| {
            state.formula_version == LIMITS_FORMULA_VERSION
                && state.size >= 0
                && state.byte_offset >= 0
                && state.byte_offset <= state.size
        });
        let unchanged =
            reusable.is_some_and(|state| state.size as u64 == size && state.mtime == mtime);
        let append = reusable.is_some_and(|state| size > state.size as u64);
        let start = if append {
            reusable.unwrap().byte_offset as u64
        } else {
            0
        };
        let prior = if unchanged || append {
            reusable.and_then(|state| {
                let snapshot: CodexRateLimits =
                    serde_json::from_str(state.snapshot_json.as_deref()?).ok()?;
                let timestamp = DateTime::parse_from_rfc3339(state.snapshot_ts.as_deref()?)
                    .ok()?
                    .with_timezone(&Utc);
                Some((timestamp, snapshot))
            })
        } else {
            None
        };
        let (byte_offset, latest) = if unchanged {
            (reusable.unwrap().byte_offset as u64, prior)
        } else {
            match scan_limits_tail(&path, start, prior) {
                Ok(scanned) => scanned,
                Err(_) => continue,
            }
        };
        if !unchanged {
            let state = CodexLimitFileState {
                size: size as i64,
                mtime,
                byte_offset: byte_offset as i64,
                snapshot_json: latest
                    .as_ref()
                    .and_then(|(_, value)| serde_json::to_string(value).ok()),
                snapshot_ts: latest.as_ref().map(|(_, value)| value.observed_at.clone()),
                formula_version: LIMITS_FORMULA_VERSION,
            };
            let _ = db.set_codex_limit_file_state(&key, &state);
        }
        if let Some((_, snapshot)) = latest {
            // Rollout mtimes can be flushed out of order. The event's RFC3339
            // timestamp, not file metadata, defines the newest snapshot.
            newer_snapshot(&mut newest, snapshot);
        }
    }
    Ok(newest.map(|(_, snapshot)| snapshot))
}

pub fn codex_dir() -> Option<PathBuf> {
    if let Ok(dir) = std::env::var("CODEX_HOME") {
        if !dir.trim().is_empty() {
            return Some(PathBuf::from(dir));
        }
    }
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .ok()?;
    Some(PathBuf::from(home).join(".codex"))
}

pub fn ingest(base: &Path, db: &StatsDb) -> Result<usize, String> {
    let mut files = Vec::new();
    collect_jsonl(&base.join("sessions"), &mut files);
    collect_jsonl(&base.join("archived_sessions"), &mut files);
    let mut states = db.cc_file_states().map_err(|e| e.to_string())?;
    let mut inserted = 0;
    for path in files {
        let Ok(meta) = std::fs::metadata(&path) else {
            continue;
        };
        let size = meta.len() as i64;
        let mtime = meta
            .modified()
            .ok()
            .map(|t| DateTime::<Utc>::from(t).to_rfc3339())
            .unwrap_or_default();
        let key = path.to_string_lossy().to_string();
        let state = states.remove(&key);
        if let Some(previous) = state.as_ref() {
            if previous.size == size && previous.mtime == mtime {
                continue;
            }
        }
        let append_state = state.as_ref().filter(|previous| {
            size > previous.size
                && previous.byte_offset >= 0
                && previous.byte_offset <= previous.size
        });
        let (start_offset, ctx) = append_state
            .and_then(|previous| {
                let context = serde_json::from_str(previous.parse_context.as_deref()?).ok()?;
                Some((previous.byte_offset as u64, context))
            })
            .unwrap_or((0, RolloutContext::default()));
        let (rows, byte_offset, ctx) = parse_rollout_file(&path, start_offset, ctx);
        if !rows.is_empty() {
            inserted += db.cc_upsert(&rows).map_err(|e| e.to_string())?;
        }
        let context_json = serde_json::to_string(&ctx).map_err(|e| e.to_string())?;
        db.cc_set_file_state(&key, size, &mtime, byte_offset as i64, Some(&context_json))
            .map_err(|e| e.to_string())?;
    }
    Ok(inserted)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn usage_line(timestamp: &str, total: i64) -> String {
        format!(
            r#"{{"type":"event_msg","timestamp":"{timestamp}","payload":{{"type":"token_count","info":{{"total_token_usage":{{"input_tokens":{total},"output_tokens":1}},"last_token_usage":{{"input_tokens":{total},"output_tokens":1}}}}}}}}"#
        )
    }

    #[test]
    fn ingest_restores_context_and_retries_an_unfinished_tail() {
        use std::io::Write;

        let base = limits_base("ingest-tail");
        let path = base
            .join("sessions")
            .join("2026")
            .join("10")
            .join("16")
            .join("rollout-tail.jsonl");
        let initial = format!(
            "{}\n{}\n{}\n",
            r#"{"type":"session_meta","payload":{"id":"s1","cwd":"D:\\work\\app"}}"#,
            r#"{"type":"turn_context","payload":{"model":"gpt-5.6-sol"}}"#,
            usage_line("2026-10-16T08:00:00Z", 10)
        );
        std::fs::write(&path, initial).unwrap();
        let db = StatsDb::open(Path::new(":memory:")).unwrap();
        assert_eq!(ingest(&base, &db).unwrap(), 1);
        let key = path.to_string_lossy();
        let complete_offset = db.cc_file_state(&key).unwrap().unwrap().byte_offset;

        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap();
        write!(file, "{}", usage_line("2026-10-16T09:00:00Z", 20)).unwrap();
        drop(file);
        assert_eq!(ingest(&base, &db).unwrap(), 0);
        assert_eq!(
            db.cc_file_state(&key).unwrap().unwrap().byte_offset,
            complete_offset
        );

        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap();
        writeln!(file).unwrap();
        drop(file);
        assert_eq!(ingest(&base, &db).unwrap(), 1);
        let state = db.cc_file_state(&key).unwrap().unwrap();
        let context: RolloutContext =
            serde_json::from_str(state.parse_context.as_deref().unwrap()).unwrap();
        assert_eq!(context.session_id.as_deref(), Some("s1"));
        assert_eq!(context.project.as_deref(), Some("app"));
        assert_eq!(context.model.as_deref(), Some("gpt-5.6-sol"));
        assert_eq!(
            state.byte_offset,
            std::fs::metadata(&path).unwrap().len() as i64
        );
        let _ = std::fs::remove_dir_all(&base);
    }

    fn limits_line(timestamp: &str, used: f64) -> String {
        format!(
            r#"{{"timestamp":"{timestamp}","type":"event_msg","payload":{{"type":"token_count","rate_limits":{{"limit_id":"codex","primary":{{"used_percent":{used},"window_minutes":300,"resets_at":1788510606}}}}}}}}"#
        )
    }

    fn limits_base(name: &str) -> PathBuf {
        let base =
            std::env::temp_dir().join(format!("cu-codex-limits-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(base.join("sessions/2026/10/16")).unwrap();
        base
    }

    fn used(limits: Option<CodexRateLimits>) -> Option<f64> {
        limits.and_then(|l| l.primary).map(|w| w.used_percent)
    }

    #[test]
    fn limits_state_picks_newest_event_and_follows_appends_and_deletions() {
        let base = limits_base("follow");
        let db = StatsDb::open(Path::new(":memory:")).unwrap();
        let dir = base.join("sessions/2026/10/16");
        let older = dir.join("rollout-a.jsonl");
        let newer = dir.join("rollout-b.jsonl");
        std::fs::write(
            &older,
            limits_line("2026-10-16T08:00:00Z", 10.0)
                + "
",
        )
        .unwrap();
        std::fs::write(
            &newer,
            limits_line("2026-10-16T09:00:00Z", 20.0)
                + "
",
        )
        .unwrap();
        assert_eq!(used(latest_limits(&base, &db).unwrap()), Some(20.0));

        let appended = limits_line("2026-10-16T08:00:00Z", 10.0)
            + "
" + &limits_line("2026-10-16T10:00:00Z", 30.0)
            + "
";
        std::fs::write(&older, appended).unwrap();
        assert_eq!(used(latest_limits(&base, &db).unwrap()), Some(30.0));

        std::fs::remove_file(&older).unwrap();
        assert_eq!(used(latest_limits(&base, &db).unwrap()), Some(20.0));
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn limits_state_persists_and_waits_for_a_complete_appended_line() {
        let base = limits_base("reuse");
        let path = base.join("sessions/2026/10/16/rollout-a.jsonl");
        let db_path = base.join("stats.db");
        std::fs::write(
            &path,
            limits_line("2026-10-16T08:00:00Z", 10.0)
                + "
",
        )
        .unwrap();
        {
            let db = StatsDb::open(&db_path).unwrap();
            assert_eq!(used(latest_limits(&base, &db).unwrap()), Some(10.0));
        }
        let partial = limits_line("2026-10-16T10:00:00Z", 30.0);
        use std::io::Write;
        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap();
        write!(file, "{partial}").unwrap();
        drop(file);
        let db = StatsDb::open(&db_path).unwrap();
        assert_eq!(used(latest_limits(&base, &db).unwrap()), Some(10.0));
        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap();
        writeln!(file).unwrap();
        drop(file);
        assert_eq!(used(latest_limits(&base, &db).unwrap()), Some(30.0));
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn rate_limits_prefilter_skips_lines_without_limits() {
        assert!(
            parse_rate_limits_line(r#"{"type":"event_msg","payload":{"type":"token_count"}}"#)
                .is_none()
        );
    }

    #[test]
    fn parses_last_usage_and_separates_cached_input() {
        let mut ctx = RolloutContext::default();
        assert!(parse_rollout_line(
            r#"{"type":"session_meta","payload":{"id":"s1","cwd":"D:\\work\\app"}}"#,
            &mut ctx
        )
        .is_none());
        assert!(parse_rollout_line(
            r#"{"type":"turn_context","payload":{"model":"gpt-5.6-sol"}}"#,
            &mut ctx
        )
        .is_none());
        let row = parse_rollout_line(r#"{"type":"event_msg","timestamp":"2026-09-03T10:00:00Z","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":100,"cached_input_tokens":60,"cache_write_input_tokens":10,"output_tokens":20},"last_token_usage":{"input_tokens":100,"cached_input_tokens":60,"cache_write_input_tokens":10,"output_tokens":20,"reasoning_output_tokens":5}}}}"#, &mut ctx).unwrap();
        assert_eq!(row.session_id.as_deref(), Some("s1"));
        assert_eq!(row.project.as_deref(), Some("app"));
        assert_eq!(
            (row.input, row.cache_read, row.cache_create, row.output),
            (30, 60, 10, 20)
        );
        assert!(row.cost > 0.0);
    }

    #[test]
    fn shared_pricing_matches_suffixed_model_names() {
        assert_eq!(
            price_per_mtok("gpt-5.6-sol-preview"),
            Some((4.0, 0.4, 20.0))
        );
    }

    #[test]
    fn repeated_last_usage_snapshot_has_one_stable_identity() {
        let mut ctx = RolloutContext::default();
        parse_rollout_line(r#"{"type":"session_meta","payload":{"id":"s1"}}"#, &mut ctx);
        let first = parse_rollout_line(r#"{"type":"event_msg","timestamp":"2026-09-03T10:00:00Z","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":100,"cached_input_tokens":60,"output_tokens":20},"last_token_usage":{"input_tokens":100,"cached_input_tokens":60,"output_tokens":20}}}}"#, &mut ctx).unwrap();
        let repeated = parse_rollout_line(r#"{"type":"event_msg","timestamp":"2026-09-03T10:01:00Z","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":100,"cached_input_tokens":60,"output_tokens":20},"last_token_usage":{"input_tokens":100,"cached_input_tokens":60,"output_tokens":20}}}}"#, &mut ctx).unwrap();
        assert_eq!(first.message_id, repeated.message_id);
    }

    #[test]
    fn ignores_cumulative_usage_and_content_events() {
        let mut ctx = RolloutContext::default();
        let line = r#"{"type":"event_msg","timestamp":"t","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":99}}}}"#;
        assert!(parse_rollout_line(line, &mut ctx).is_none());
        assert!(parse_rollout_line(
            r#"{"type":"response_item","payload":{"type":"message","content":"secret"}}"#,
            &mut ctx
        )
        .is_none());
    }

    #[test]
    fn parses_codex_subscription_windows_without_auth_data() {
        let limits = parse_rate_limits_line(
            r#"{"timestamp":"2026-09-04T03:31:43Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":1}},"rate_limits":{"limit_id":"codex","primary":{"used_percent":4.0,"window_minutes":300,"resets_at":1788510606},"secondary":{"used_percent":16.0,"window_minutes":10080,"resets_at":1789058710},"credits":{"has_credits":false,"unlimited":false,"balance":"0"},"plan_type":"plus","rate_limit_reached_type":null}}}"#,
        )
        .unwrap();
        assert_eq!(limits.plan_type.as_deref(), Some("plus"));
        assert_eq!(limits.primary.unwrap().window_minutes, 300);
        assert_eq!(limits.secondary.unwrap().used_percent, 16.0);
        assert_eq!(limits.credits.unwrap().balance, "0");
    }
}
