//! Low-priority reconstruction of restart observations for finished runner
//! steps.  It deliberately reuses `build_task_work_tree`, the trace path, so a
//! background record and an interactively opened trace cannot disagree.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;

use super::{
    load_run_steps,
    restart_store::{load_params, transcript_stamp, TranscriptStamp},
    work_tree::{build_task_work_tree_with_index, TranscriptIndex},
};
use crate::board::{task_sessions, task_sessions::TaskBlock};

#[derive(Clone, Debug)]
pub struct RestartBackfillPaths {
    pub task_sessions: PathBuf,
    pub runs: PathBuf,
    pub calibration: PathBuf,
    pub restart_points: PathBuf,
    pub claude_base: Option<PathBuf>,
    pub codex_base: Option<PathBuf>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RestartBackfillResult {
    /// Distinct runner session blocks needing a calculation.
    pub pending_blocks: usize,
    /// Tasks handed to the normal trace builder.
    pub calculated_tasks: usize,
}

/// Fill missing observations for closed historical `run-step` blocks.  Broken
/// journal lines and absent transcripts are intentionally ignored: a later app
/// start can retry them, and this must never affect application startup.
pub fn backfill(
    paths: &RestartBackfillPaths,
    task_numbers: &HashMap<String, u32>,
) -> RestartBackfillResult {
    let events = task_sessions::load(&paths.task_sessions);
    let blocks = task_sessions::blocks(&events, &HashMap::new());
    let transcripts =
        TranscriptIndex::build(paths.claude_base.as_deref(), paths.codex_base.as_deref());
    let current_records = load_current_records(&paths.restart_points);
    let pending: Vec<TaskBlock> = blocks
        .into_iter()
        .filter(|block| block.source == "run-step" && block.to > block.from)
        .filter(|block| {
            let Some(transcript) = transcripts.path_for_block(block) else {
                return false;
            };
            let Some(stamp) = transcript_stamp(&transcript) else {
                return false;
            };
            !current_records.contains(&RestartRecordKey::new(&block.session, &block.task, &stamp))
        })
        .collect();
    let pending_blocks = pending.len();
    let mut by_task: HashMap<String, Vec<TaskBlock>> = HashMap::new();
    for block in pending {
        by_task.entry(block.task.clone()).or_default().push(block);
    }
    let run_steps = load_run_steps(&paths.runs);
    let params = load_params(&paths.calibration);
    let calculated_tasks = by_task.len();
    for (task, task_blocks) in by_task {
        // The builder owns both provider-specific parsing and append-if-new;
        // this is intentionally the exact path used by `get_task_work_tree`.
        let _ = build_task_work_tree_with_index(
            &task,
            task_numbers.get(&task).copied().unwrap_or_default(),
            &task_blocks,
            &[],
            &run_steps,
            task_numbers,
            paths.claude_base.as_deref(),
            paths.codex_base.as_deref(),
            &params,
            Some(&paths.restart_points),
            &transcripts,
        );
    }
    RestartBackfillResult {
        pending_blocks,
        calculated_tasks,
    }
}

#[derive(Debug, Hash, PartialEq, Eq)]
struct RestartRecordKey {
    session: String,
    task: String,
    size: u64,
    mtime_ns: u128,
}

impl RestartRecordKey {
    fn new(session: &str, task: &str, stamp: &TranscriptStamp) -> Self {
        Self {
            session: session.to_string(),
            task: task.to_string(),
            size: stamp.size,
            mtime_ns: stamp.mtime_ns,
        }
    }
}

fn load_current_records(path: &std::path::Path) -> HashSet<RestartRecordKey> {
    #[derive(serde::Deserialize)]
    struct StoredRecord {
        session: String,
        task: String,
        stamp: TranscriptStamp,
    }

    std::fs::read_to_string(path)
        .ok()
        .map(|raw| {
            raw.lines()
                .filter_map(|line| serde_json::from_str::<StoredRecord>(line).ok())
                .map(|record| RestartRecordKey {
                    session: record.session,
                    task: record.task,
                    size: record.stamp.size,
                    mtime_ns: record.stamp.mtime_ns,
                })
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn ignores_open_or_non_runner_blocks_before_transcript_work() {
        let dir = std::env::temp_dir().join("restart-backfill-filter");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("task-sessions.jsonl"),
            concat!(
                r#"{"ts":"2026-01-01T00:00:00Z","session":"non-runner","task":"a","event":"start","source":"take"}"#,
                "\n",
                r#"{"ts":"2026-01-01T00:01:00Z","session":"non-runner","task":"a","event":"end","source":"take"}"#,
                "\n",
                r#"{"ts":"2026-01-01T00:00:00Z","session":"open-runner","task":"b","event":"start","source":"run-step"}"#,
                "\n"
            ),
        )
        .unwrap();
        let paths = RestartBackfillPaths {
            task_sessions: dir.join("task-sessions.jsonl"),
            runs: dir.join("runs.jsonl"),
            calibration: dir.join("restart-calibration.json"),
            restart_points: dir.join("restart-points.jsonl"),
            claude_base: None,
            codex_base: None,
        };
        assert_eq!(
            backfill(&paths, &HashMap::new()),
            RestartBackfillResult::default()
        );
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn loads_restart_keys_once_and_ignores_broken_lines() {
        let path = std::env::temp_dir().join("restart-backfill-current-records.jsonl");
        fs::write(
            &path,
            concat!(
                "broken\n",
                r#"{"session":"s","task":"t","stamp":{"size":42,"mtime_ns":99}}"#,
                "\n"
            ),
        )
        .unwrap();
        let records = load_current_records(&path);
        assert!(records.contains(&RestartRecordKey {
            session: "s".into(),
            task: "t".into(),
            size: 42,
            mtime_ns: 99,
        }));
        assert_eq!(records.len(), 1);
        fs::remove_file(path).unwrap();
    }
}
