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

#[cfg(windows)]
fn cpu_ms() -> f64 {
    use windows_sys::Win32::Foundation::FILETIME;
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, GetProcessTimes};
    let zero = FILETIME {
        dwLowDateTime: 0,
        dwHighDateTime: 0,
    };
    let (mut created, mut exited, mut kernel, mut user) = (zero, zero, zero, zero);
    let ok = unsafe {
        GetProcessTimes(
            GetCurrentProcess(),
            &mut created,
            &mut exited,
            &mut kernel,
            &mut user,
        )
    };
    if ok == 0 {
        return f64::NAN;
    }
    let ticks = |t: FILETIME| ((t.dwHighDateTime as u64) << 32) | t.dwLowDateTime as u64;
    (ticks(kernel) + ticks(user)) as f64 / 10_000.0
}

#[cfg(not(windows))]
fn cpu_ms() -> f64 {
    f64::NAN
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

fn measure(f: impl FnOnce() -> Value) -> (f64, f64, Value) {
    let cpu = cpu_ms();
    let start = Instant::now();
    let result = f();
    let wall = start.elapsed().as_secs_f64() * 1000.0;
    (wall, cpu_ms() - cpu, result)
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
    fn record(&mut self, scenario: &str, run: usize, wall: f64, cpu: f64, result: Value) {
        let line = json!({
            "ts": chrono::Utc::now().to_rfc3339(),
            "label": self.options.label,
            "git": self.rev,
            "profile": if cfg!(debug_assertions) { "debug" } else { "release" },
            "scenario": scenario,
            "run": run,
            "wall_ms": (wall * 10.0).round() / 10.0,
            "cpu_ms": (cpu * 10.0).round() / 10.0,
            "result": result,
        });
        writeln!(self.journal, "{line}").unwrap();
        println!("{scenario:<16} run {run}  wall {wall:>10.1} ms  cpu {cpu:>10.1} ms  {result}");
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
                let (wall, cpu, result) = measure(|| json!(codex::latest_limits(&base).is_some()));
                self.record("limits_cold", 1, wall, cpu, json!({ "found": result }));
            }
            if self.wanted("limits_warm") {
                if !self.wanted("limits_cold") {
                    codex::latest_limits(&base);
                }
                for run in 1..=runs {
                    let (wall, cpu, result) =
                        measure(|| json!(codex::latest_limits(&base).is_some()));
                    self.record("limits_warm", run, wall, cpu, json!({ "found": result }));
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
                let (wall, cpu, result) = measure(&mut call);
                self.record("backfill_first", 1, wall, cpu, result);
            }
            if self.wanted("backfill_repeat") {
                for run in 1..=runs {
                    let (wall, cpu, result) = measure(&mut call);
                    self.record("backfill_repeat", run, wall, cpu, result);
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
                let (wall, cpu, result) = measure(|| {
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
                self.record(scenario, run, wall, cpu, result);
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
    let mut samples: BTreeMap<(String, String), (Vec<f64>, Vec<f64>)> = BTreeMap::new();
    for line in raw.lines() {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let label = v["label"].as_str().unwrap_or_default().to_string();
        if &label != before && &label != after {
            continue;
        }
        let scenario = v["scenario"].as_str().unwrap_or_default().to_string();
        let entry = samples.entry((scenario, label)).or_default();
        entry.0.push(v["wall_ms"].as_f64().unwrap_or(f64::NAN));
        entry.1.push(v["cpu_ms"].as_f64().unwrap_or(f64::NAN));
    }
    println!(
        "{:<16} {:>12} {:>12} {:>8}   {:>12} {:>12} {:>8}",
        "scenario", "wall before", "wall after", "x", "cpu before", "cpu after", "x"
    );
    for scenario in SCENARIOS {
        let get = |label: &String| samples.get(&(scenario.to_string(), label.clone()));
        let (Some(b), Some(a)) = (get(before), get(after)) else {
            continue;
        };
        let (wb, wa) = (median(b.0.clone()), median(a.0.clone()));
        let (cb, ca) = (median(b.1.clone()), median(a.1.clone()));
        println!(
            "{scenario:<16} {wb:>12.1} {wa:>12.1} {:>8.1}   {cb:>12.1} {ca:>12.1} {:>8.1}",
            wb / wa.max(0.1),
            cb / ca.max(0.1)
        );
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
    let journal = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&options.out)
        .unwrap();
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
