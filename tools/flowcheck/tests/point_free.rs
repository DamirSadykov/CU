#[path = "../src/flow.rs"]
mod flow;

use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};

static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

fn repo() -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "flowcheck-point-free-{}-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos(),
        NEXT.fetch_add(1, std::sync::atomic::Ordering::SeqCst)
    ));
    fs::create_dir_all(path.join("src")).unwrap();
    Command::new("git")
        .args(["init", "-q"])
        .current_dir(&path)
        .status()
        .unwrap();
    path
}

fn commit(repo: &Path) -> String {
    Command::new("git")
        .args(["add", "."])
        .current_dir(repo)
        .status()
        .unwrap();
    Command::new("git")
        .args([
            "-c",
            "user.name=test",
            "-c",
            "user.email=test@example.invalid",
            "commit",
            "-qm",
            "base",
        ])
        .current_dir(repo)
        .status()
        .unwrap();
    String::from_utf8(
        Command::new("git")
            .args(["rev-parse", "HEAD"])
            .current_dir(repo)
            .output()
            .unwrap()
            .stdout,
    )
    .unwrap()
    .trim()
    .into()
}

fn fixture(name: &str) -> String {
    fs::read_to_string(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixture/js")
            .join(name),
    )
    .unwrap()
}

fn check(file: &str, base: &str, head: &str, spec: &str) -> flow::ResultRow {
    let repo = repo();
    fs::write(repo.join(file), base).unwrap();
    let rev = commit(&repo);
    fs::write(repo.join(file), head).unwrap();
    let spec: flow::Spec = serde_yaml::from_str(&format!("file: {file}\n{spec}")).unwrap();
    let row = flow::check_method(&spec, &repo, &rev, None, true);
    let _ = fs::remove_dir_all(repo);
    row
}

fn head_steps(row: &flow::ResultRow) -> Vec<String> {
    row.head_steps.clone().unwrap_or_default()
}

#[test]
fn point_free_function_counts_as_inserted_call() {
    let row = check(
        "src/flow-problems.mjs",
        &fixture("flow-problems.base.mjs"),
        &fixture("flow-problems.head.mjs"),
        "method: flowProblems\nchange:\n  - insert: normalizeProblem\n",
    );
    assert_eq!(row.status, "pass", "{:?}", row.problems);
    assert!(row.problems.is_empty(), "{:?}", row.problems);
    let steps = head_steps(&row);
    let at = steps
        .iter()
        .position(|x| x == "call:normalizeProblem")
        .expect("point-free call step");
    assert_eq!(steps.get(at + 1).map(String::as_str), Some("call:String"));
    assert!(steps.contains(&"call:replace".to_string()), "{steps:?}");
    let tree = serde_json::to_string(&row.head_tree).unwrap();
    assert!(tree.contains("\"text\":\"normalizeProblem\""), "{tree}");
}

#[test]
fn lambda_wrapped_function_still_counts_as_inserted_call() {
    let row = check(
        "src/flow-problems.mjs",
        &fixture("flow-problems.base.mjs"),
        &fixture("flow-problems.lambda.mjs"),
        "method: flowProblems\nchange:\n  - insert: normalizeProblem\n",
    );
    assert_eq!(row.status, "pass", "{:?}", row.problems);
    assert!(row.problems.is_empty(), "{:?}", row.problems);
}

#[test]
fn point_free_and_lambda_give_the_same_head_flow() {
    let spec = "method: flowProblems\nchange:\n  - insert: normalizeProblem\n";
    let point_free = check(
        "src/flow-problems.mjs",
        &fixture("flow-problems.base.mjs"),
        &fixture("flow-problems.head.mjs"),
        spec,
    );
    let lambda = check(
        "src/flow-problems.mjs",
        &fixture("flow-problems.base.mjs"),
        &fixture("flow-problems.lambda.mjs"),
        spec,
    );
    assert_eq!(head_steps(&point_free), head_steps(&lambda));
}

#[test]
fn data_arguments_are_not_calls() {
    let base = fixture("flow-problems.base.mjs");
    for name in ["item", "config", "out"] {
        let row = check(
            "src/flow-problems.mjs",
            &base,
            &base,
            &format!("method: collectItems\nchange:\n  - insert: {name}\n"),
        );
        assert_eq!(
            row.problems,
            vec![format!("call {name} not inserted")],
            "{name}"
        );
        assert!(
            !head_steps(&row).contains(&format!("call:{name}")),
            "{:?}",
            row.head_steps
        );
    }
}

#[test]
fn parameter_shadowing_a_file_function_is_not_a_call() {
    let source = "function send(payload) {\n  return payload;\n}\n\nexport function apply(send, items) {\n  return items.map(send);\n}\n";
    let row = check(
        "src/apply.mjs",
        source,
        source,
        "method: apply\nchange:\n  - insert: send\n",
    );
    assert_eq!(row.problems, vec!["call send not inserted".to_string()]);
    assert!(!head_steps(&row).contains(&"call:send".to_string()));
}

#[test]
fn member_access_argument_is_not_a_call() {
    let source = "function normalize(x) {\n  return x;\n}\n\nexport function collect(items, helpers) {\n  return items.map(helpers.normalize);\n}\n";
    let row = check(
        "src/collect.mjs",
        source,
        source,
        "method: collect\nchange:\n  - insert: normalize\n",
    );
    assert_eq!(
        row.problems,
        vec!["call normalize not inserted".to_string()]
    );
}

const ORDER_BASE: &str = "function validate(items) {\n  return items;\n}\n\nfunction normalize(x) {\n  return x;\n}\n\nfunction send(x) {\n  return x;\n}\n\nexport function collect(items) {\n  validate(items);\n  const out = items.map((x) => x);\n  send(out);\n  return out;\n}\n";

fn order_head(argument: &str) -> String {
    ORDER_BASE.replace(
        "const out = items.map((x) => x);",
        &format!("const out = items.map({argument});"),
    )
}

#[test]
fn after_and_before_work_for_point_free_like_for_lambda() {
    let after = check(
        "src/collect.mjs",
        ORDER_BASE,
        &order_head("normalize"),
        "method: collect\nchange:\n  - insert: normalize\n    after: validate\n",
    );
    assert_eq!(after.status, "pass", "{:?}", after.problems);
    for argument in ["normalize", "(x) => normalize(x)"] {
        let head = order_head(argument);
        let before = check(
            "src/collect.mjs",
            ORDER_BASE,
            &head,
            "method: collect\nchange:\n  - insert: normalize\n    before: send\n",
        );
        assert_eq!(before.status, "pass", "{argument}: {:?}", before.problems);
        let reversed = check(
            "src/collect.mjs",
            ORDER_BASE,
            &head,
            "method: collect\nchange:\n  - insert: normalize\n    before: validate\n",
        );
        assert!(
            reversed
                .problems
                .iter()
                .any(|p| p.contains("not preceded by normalize")),
            "{argument}: {:?}",
            reversed.problems
        );
    }
}

#[test]
fn csharp_method_group_counts_as_call() {
    let base = "using System.Linq;\nclass Problems {\n    static string Normalize(string p) {\n        return p.Trim();\n    }\n    public string[] Collect(string[] items) {\n        return items.Select((string p) => p.Trim()).ToArray();\n    }\n}\n";
    let head = base.replace("Select((string p) => p.Trim())", "Select(Normalize)");
    let row = check(
        "src/Problems.cs",
        base,
        &head,
        "method: Collect\nchange:\n  - insert: Normalize\n",
    );
    assert_eq!(row.status, "pass", "{:?}", row.problems);
    assert!(head_steps(&row).contains(&"call:Normalize".to_string()));
    let data = base.replace(
        "Select((string p) => p.Trim())",
        "Select((string p) => p.Trim()).Concat(items)",
    );
    let row = check(
        "src/Problems.cs",
        base,
        &data,
        "method: Collect\nchange:\n  - insert: items\n",
    );
    assert_eq!(row.problems, vec!["call items not inserted".to_string()]);
}

#[test]
fn csharp_after_and_before_agree_for_method_group_and_lambda() {
    let base = "using System.Linq;\nclass Problems {\n    static void Validate(string[] items) {\n    }\n    static string Normalize(string p) {\n        return p;\n    }\n    static void Send(string[] items) {\n    }\n    public string[] Collect(string[] items) {\n        Validate(items);\n        var outs = items.Select((string p) => p).ToArray();\n        Send(outs);\n        return outs;\n    }\n}\n";
    for argument in ["Normalize", "(string p) => Normalize(p)"] {
        let head = base.replace("Select((string p) => p)", &format!("Select({argument})"));
        for (anchor, expected) in [
            ("after: Validate", "pass"),
            ("before: Send", "pass"),
            ("before: Validate", "fail"),
        ] {
            let row = check(
                "src/Problems.cs",
                base,
                &head,
                &format!("method: Collect\nchange:\n  - insert: Normalize\n    {anchor}\n"),
            );
            assert_eq!(
                row.status, expected,
                "{argument} {anchor}: {:?}",
                row.problems
            );
        }
    }
}

#[test]
fn rust_function_path_counts_as_call() {
    let base = "fn normalize(p: &str) -> String {\n    p.trim().to_string()\n}\n\npub fn collect(items: &[&str]) -> Vec<String> {\n    items.iter().map(|p| p.trim().to_string()).collect()\n}\n";
    let head = base.replace("map(|p| p.trim().to_string())", "map(|p| normalize(p))");
    let point_free = base.replace("map(|p| p.trim().to_string())", "map(normalize)");
    let lambda = check(
        "src/lib.rs",
        base,
        &head,
        "method: collect\nchange:\n  - insert: normalize\n",
    );
    let row = check(
        "src/lib.rs",
        base,
        &point_free,
        "method: collect\nchange:\n  - insert: normalize\n",
    );
    assert_eq!(row.status, "pass", "{:?}", row.problems);
    assert_eq!(lambda.status, "pass", "{:?}", lambda.problems);
    assert!(head_steps(&row).contains(&"call:normalize".to_string()));
}

#[test]
fn typescript_point_free_counts_as_call() {
    let base = "function normalize(p: string): string {\n  return p.trim();\n}\n\nexport function collect(items: string[]): string[] {\n  return items.map((p: string) => p.trim());\n}\n";
    let head = base.replace("map((p: string) => p.trim())", "map(normalize)");
    let row = check(
        "src/collect.ts",
        base,
        &head,
        "method: collect\nchange:\n  - insert: normalize\n",
    );
    assert_eq!(row.status, "pass", "{:?}", row.problems);
    assert!(head_steps(&row).contains(&"call:normalize".to_string()));
}
