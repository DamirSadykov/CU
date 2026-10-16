use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Instant;

use cu_lib::analytics::{cc, codex};
use cu_lib::stats::StatsDb;
use cu_lib::task_cost::restart_backfill::{backfill, RestartBackfillPaths};
use cu_lib::todos;
use serde_json::{json, Value};

const SCENARIOS: &[&str] = &[
    "limits_cold",
    "limits_warm",
    "backfill_first",
    "backfill_repeat",
    "ingest_cc",
    "ingest_codex",
];

const GROUPS: &[&[&str]] = &[
    &["limits_cold", "limits_warm"],
    &["backfill_first", "backfill_repeat"],
    &["ingest_cc"],
    &["ingest_codex"],
];

const METRICS: &[(&str, &str)] = &[
    ("wall_ms", "wall ms"),
    ("cpu_ms", "cpu ms"),
    ("retained_mb", "retained MB"),
    ("peak_mb", "peak MB"),
    ("read_mb", "read MB"),
];

const BACKFILL_FILES: &[&str] = &[
    "task-sessions.jsonl",
    "runs.jsonl",
    "restart-calibration.json",
    "restart-points.jsonl",
];

struct Options {
    only: Vec<String>,
    runs: usize,
    label: String,
    out: PathBuf,
    child: bool,
}

fn app_dir() -> PathBuf {
    if let Ok(d) = std::env::var("CUT_APP_DIR") {
        return PathBuf::from(d);
    }
    cu_lib::data_dir::selected_data_dir(
        &PathBuf::from(std::env::var("APPDATA").unwrap()),
        "com.cu.app",
    )
}

fn claude_base() -> Option<PathBuf> {
    if let Ok(d) = std::env::var("CLAUDE_CONFIG_DIR") {
        if !d.trim().is_empty() {
            return Some(PathBuf::from(d));
        }
    }
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .ok()?;
    Some(PathBuf::from(home).join(".claude"))
}

fn default_out() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("target")
        .join("io-bench.jsonl")
}

#[derive(Clone, Copy, Default)]
struct Snapshot {
    cpu_ms: f64,
    private_bytes: f64,
    peak_bytes: f64,
    read_bytes: f64,
}

struct Sample {
    wall_ms: f64,
    cpu_ms: f64,
    retained_mb: f64,
    peak_mb: f64,
    read_mb: f64,
}

#[cfg(windows)]
#[repr(C)]
#[derive(Default)]
struct ProcessMemoryCountersEx {
    cb: u32,
    page_fault_count: u32,
    peak_working_set_size: usize,
    working_set_size: usize,
    quota_peak_paged_pool_usage: usize,
    quota_paged_pool_usage: usize,
    quota_peak_non_paged_pool_usage: usize,
    quota_non_paged_pool_usage: usize,
    pagefile_usage: usize,
    peak_pagefile_usage: usize,
    private_usage: usize,
}

#[cfg(windows)]
#[link(name = "kernel32")]
extern "system" {
    fn K32GetProcessMemoryInfo(
        process: windows_sys::Win32::Foundation::HANDLE,
        counters: *mut ProcessMemoryCountersEx,
        cb: u32,
    ) -> i32;
}

#[cfg(windows)]
fn snapshot() -> Snapshot {
    use windows_sys::Win32::Foundation::FILETIME;
    use windows_sys::Win32::System::Threading::{
        GetCurrentProcess, GetProcessIoCounters, GetProcessTimes, IO_COUNTERS,
    };
    let zero = FILETIME {
        dwLowDateTime: 0,
        dwHighDateTime: 0,
    };
    let (mut created, mut exited, mut kernel, mut user) = (zero, zero, zero, zero);
    let mut memory = ProcessMemoryCountersEx {
        cb: std::mem::size_of::<ProcessMemoryCountersEx>() as u32,
        ..Default::default()
    };
    let mut io: IO_COUNTERS = unsafe { std::mem::zeroed() };
    let process = unsafe { GetCurrentProcess() };
    let times_ok =
        unsafe { GetProcessTimes(process, &mut created, &mut exited, &mut kernel, &mut user) } != 0;
    let memory_ok = unsafe { K32GetProcessMemoryInfo(process, &mut memory, memory.cb) } != 0;
    let io_ok = unsafe { GetProcessIoCounters(process, &mut io) } != 0;
    let ticks = |t: FILETIME| ((t.dwHighDateTime as u64) << 32) | t.dwLowDateTime as u64;
    let or_nan = |ok: bool, v: f64| if ok { v } else { f64::NAN };
    Snapshot {
        cpu_ms: or_nan(times_ok, (ticks(kernel) + ticks(user)) as f64 / 10_000.0),
        private_bytes: or_nan(memory_ok, memory.private_usage as f64),
        peak_bytes: or_nan(memory_ok, memory.peak_working_set_size as f64),
        read_bytes: or_nan(io_ok, io.ReadTransferCount as f64),
    }
}

#[cfg(not(windows))]
fn snapshot() -> Snapshot {
    Snapshot {
        cpu_ms: f64::NAN,
        private_bytes: f64::NAN,
        peak_bytes: f64::NAN,
        read_bytes: f64::NAN,
    }
}

fn git_rev() -> String {
    std::process::Command::new("git")
        .args(["rev-parse", "--short", "HEAD"])
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default()
}

fn parse_args(args: &[String]) -> Options {
    let mut options = Options {
        only: SCENARIOS.iter().map(|s| s.to_string()).collect(),
        runs: 3,
        label: git_rev(),
        out: default_out(),
        child: false,
    };
    let mut i = 0;
    while i < args.len() {
        let value = args.get(i + 1).cloned().unwrap_or_default();
        match args[i].as_str() {
            "--only" => {
                options.only = value.split(',').map(|s| s.trim().to_string()).collect();
                i += 1;
            }
            "--runs" => {
                options.runs = value.parse().unwrap_or(3).max(1);
                i += 1;
            }
            "--label" => {
                options.label = value;
                i += 1;
            }
            "--out" => {
                options.out = PathBuf::from(value);
                i += 1;
            }
            "--child" => {
                options.child = true;
                i += 1;
                continue;
            }
            other => {
                eprintln!("unknown argument {other}");
                std::process::exit(2);
            }
        }
        i += 1;
    }
    for name in &options.only {
        if !SCENARIOS.contains(&name.as_str()) {
            eprintln!("unknown scenario {name}; known: {}", SCENARIOS.join(", "));
            std::process::exit(2);
        }
    }
    options
}

const MB: f64 = 1024.0 * 1024.0;

fn measure(f: impl FnOnce() -> Value) -> (Sample, Value) {
    let before = snapshot();
    let start = Instant::now();
    let result = f();
    let wall_ms = start.elapsed().as_secs_f64() * 1000.0;
    let after = snapshot();
    let sample = Sample {
        wall_ms,
        cpu_ms: after.cpu_ms - before.cpu_ms,
        retained_mb: (after.private_bytes - before.private_bytes) / MB,
        peak_mb: after.peak_bytes / MB,
        read_mb: (after.read_bytes - before.read_bytes) / MB,
    };
    (sample, result)
}

fn work_dir() -> PathBuf {
    let dir = std::env::temp_dir().join(format!("cu-io-bench-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn copy_if_present(from: &Path, to: &Path) {
    if from.is_file() {
        fs::copy(from, to).unwrap();
    }
}

struct Bench {
    options: Options,
    app: PathBuf,
    work: PathBuf,
    codex: Option<PathBuf>,
    claude: Option<PathBuf>,
    db: Option<StatsDb>,
    journal: fs::File,
    rev: String,
}

impl Bench {
    fn record(&mut self, scenario: &str, run: usize, sample: Sample, result: Value) {
        let round = |v: f64| (v * 10.0).round() / 10.0;
        let line = json!({
            "ts": chrono::Utc::now().to_rfc3339(),
            "label": self.options.label,
            "git": self.rev,
            "profile": if cfg!(debug_assertions) { "debug" } else { "release" },
            "scenario": scenario,
            "run": run,
            "wall_ms": round(sample.wall_ms),
            "cpu_ms": round(sample.cpu_ms),
            "retained_mb": round(sample.retained_mb),
            "peak_mb": round(sample.peak_mb),
            "read_mb": round(sample.read_mb),
            "result": result,
        });
        writeln!(self.journal, "{line}").unwrap();
        println!(
            "{scenario:<16} run {run}  wall {:>9.1} ms  cpu {:>9.1} ms  retained {:>7.1} MB  peak {:>7.1} MB  read {:>8.1} MB  {result}",
            sample.wall_ms, sample.cpu_ms, sample.retained_mb, sample.peak_mb, sample.read_mb
        );
    }

    fn wanted(&self, scenario: &str) -> bool {
        self.options.only.iter().any(|s| s == scenario)
    }

    fn db(&mut self) -> &StatsDb {
        if self.db.is_none() {
            let copy = self.work.join("usage_stats.db");
            copy_if_present(&self.app.join("usage_stats.db"), &copy);
            self.db = Some(StatsDb::open(&copy).unwrap());
        }
        self.db.as_ref().unwrap()
    }

    fn backfill_paths(&self) -> RestartBackfillPaths {
        RestartBackfillPaths {
            task_sessions: self.work.join("task-sessions.jsonl"),
            runs: self.work.join("runs.jsonl"),
            calibration: self.work.join("restart-calibration.json"),
            restart_points: self.work.join("restart-points.jsonl"),
            claude_base: self.claude.clone(),
            codex_base: self.codex.clone(),
        }
    }

    fn run(&mut self) {
        let runs = self.options.runs;
        if let Some(base) = self.codex.clone() {
            if self.wanted("limits_cold") {
                let (sample, result) = measure(|| json!(codex::latest_limits(&base).is_some()));
                self.record("limits_cold", 1, sample, json!({ "found": result }));
            }
            if self.wanted("limits_warm") {
                if !self.wanted("limits_cold") {
                    codex::latest_limits(&base);
                }
                for run in 1..=runs {
                    let (sample, result) = measure(|| json!(codex::latest_limits(&base).is_some()));
                    self.record("limits_warm", run, sample, json!({ "found": result }));
                }
            }
        }
        if self.wanted("backfill_first") || self.wanted("backfill_repeat") {
            for name in BACKFILL_FILES {
                copy_if_present(&self.app.join(name), &self.work.join(name));
            }
            let board = todos::load(&self.app.join("todos.json"));
            let numbers: HashMap<String, u32> = board
                .todos
                .iter()
                .map(|todo| (todo.id.clone(), todo.number))
                .collect();
            let paths = self.backfill_paths();
            let mut call = || {
                let r = backfill(&paths, &numbers);
                json!({ "pending_blocks": r.pending_blocks, "calculated_tasks": r.calculated_tasks })
            };
            if self.wanted("backfill_first") {
                let (sample, result) = measure(&mut call);
                self.record("backfill_first", 1, sample, result);
            }
            if self.wanted("backfill_repeat") {
                for run in 1..=runs {
                    let (sample, result) = measure(&mut call);
                    self.record("backfill_repeat", run, sample, result);
                }
            }
        }
        for (scenario, base, is_cc) in [
            ("ingest_cc", self.claude.clone(), true),
            ("ingest_codex", self.codex.clone(), false),
        ] {
            let Some(base) = base else { continue };
            if !self.wanted(scenario) {
                continue;
            }
            for run in 1..=runs {
                let db = self.db();
                let (sample, result) = measure(|| {
                    let inserted = if is_cc {
                        cc::ingest(&base, db)
                    } else {
                        codex::ingest(&base, db)
                    };
                    match inserted {
                        Ok(n) => json!({ "inserted": n }),
                        Err(e) => json!({ "error": e }),
                    }
                });
                self.record(scenario, run, sample, result);
            }
        }
    }
}

fn median(mut values: Vec<f64>) -> f64 {
    values.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let n = values.len();
    if n % 2 == 1 {
        values[n / 2]
    } else {
        (values[n / 2 - 1] + values[n / 2]) / 2.0
    }
}

fn compare(args: &[String]) {
    let (Some(before), Some(after)) = (args.first(), args.get(1)) else {
        eprintln!("usage: io_bench compare <label-before> <label-after> [--out <journal>]");
        std::process::exit(2);
    };
    let out = match args.get(2).map(String::as_str) {
        Some("--out") => PathBuf::from(args.get(3).cloned().unwrap_or_default()),
        _ => default_out(),
    };
    let raw = fs::read_to_string(&out).unwrap_or_else(|e| {
        eprintln!("cannot read {}: {e}", out.display());
        std::process::exit(1);
    });
    let mut samples: BTreeMap<(String, String, &str), Vec<f64>> = BTreeMap::new();
    for line in raw.lines() {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let label = v["label"].as_str().unwrap_or_default().to_string();
        if &label != before && &label != after {
            continue;
        }
        let scenario = v["scenario"].as_str().unwrap_or_default().to_string();
        for (key, _) in METRICS {
            if let Some(value) = v[*key].as_f64() {
                samples
                    .entry((scenario.clone(), label.clone(), *key))
                    .or_default()
                    .push(value);
            }
        }
    }
    println!(
        "{:<16} {:<12} {:>12} {:>12} {:>8}",
        "scenario", "metric", before, after, "x"
    );
    for scenario in SCENARIOS {
        for (key, title) in METRICS {
            let get = |label: &String| {
                samples
                    .get(&(scenario.to_string(), label.clone(), *key))
                    .map(|v| median(v.clone()))
            };
            let (Some(b), Some(a)) = (get(before), get(after)) else {
                continue;
            };
            let ratio = if a.abs() < 0.1 { f64::NAN } else { b / a };
            let ratio = if ratio.is_nan() {
                "-".to_string()
            } else {
                format!("{ratio:.1}")
            };
            println!("{scenario:<16} {title:<12} {b:>12.1} {a:>12.1} {ratio:>8}");
        }
    }
}

fn spawn_groups(options: &Options) {
    let exe = std::env::current_exe().unwrap();
    for group in GROUPS {
        let wanted: Vec<&str> = group
            .iter()
            .copied()
            .filter(|s| options.only.iter().any(|o| o == s))
            .collect();
        if wanted.is_empty() {
            continue;
        }
        let status = std::process::Command::new(&exe)
            .arg("--child")
            .args(["--only", &wanted.join(",")])
            .args(["--runs", &options.runs.to_string()])
            .args(["--label", &options.label])
            .arg("--out")
            .arg(&options.out)
            .status()
            .unwrap();
        if !status.success() {
            eprintln!("group {} failed: {status}", wanted.join(","));
        }
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("compare") {
        compare(&args[1..]);
        return;
    }
    let options = parse_args(&args);
    if let Some(parent) = options.out.parent() {
        fs::create_dir_all(parent).unwrap();
    }
    if !options.child {
        println!(
            "label {}  journal {}  profile {}",
            options.label,
            options.out.display(),
            if cfg!(debug_assertions) {
                "debug"
            } else {
                "release"
            }
        );
        spawn_groups(&options);
        return;
    }
    let journal = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&options.out)
        .unwrap();
    let work = work_dir();
    let mut bench = Bench {
        options,
        app: app_dir(),
        work: work.clone(),
        codex: codex::codex_dir(),
        claude: claude_base(),
        db: None,
        journal,
        rev: git_rev(),
    };
    bench.run();
    drop(bench);
    let _ = fs::remove_dir_all(work);
}
