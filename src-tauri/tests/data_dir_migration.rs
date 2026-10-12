use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use cu_lib::data_dir::{
    self, DataDirPaths, MigrationMarker, MigrationStatus, MARKER_FILE,
};
use rusqlite::Connection;

struct TempDir(PathBuf);

impl TempDir {
    fn new(tag: &str) -> Self {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "data_dir_migration_{tag}_{}_{}",
            std::process::id(),
            unique
        ));
        fs::create_dir_all(&path).unwrap();
        Self(path)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn paths(root: &Path) -> DataDirPaths {
    DataDirPaths::for_identifier(root, "com.cu.app").unwrap()
}

fn seed_source(root: &Path) -> DataDirPaths {
    let p = paths(root);
    fs::create_dir_all(p.source.join("plans")).unwrap();
    fs::write(p.source.join("todos.json"), b"{\"version\":3,\"todos\":[]}").unwrap();
    fs::write(p.source.join("settings.json"), b"{\"theme\":\"dark\"}").unwrap();
    fs::write(p.source.join("plans").join("one.md"), b"plan").unwrap();
    p
}

fn quarantine_entries(root: &Path, prefix: &str) -> Vec<PathBuf> {
    fs::read_dir(root)
        .unwrap()
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .starts_with(prefix)
        })
        .collect()
}

#[test]
fn identifier_pairs_do_not_cross_environments_and_unknown_is_untouched() {
    let root = TempDir::new("pairs");
    for (old, new) in [
        ("com.claude-usage-tracker.app", "com.cu.app"),
        ("com.claude-usage-tracker.dev", "com.cu.dev"),
        ("com.claude-usage-tracker.preview", "com.cu.preview"),
    ] {
        let p = DataDirPaths::for_identifier(root.path(), new).unwrap();
        assert_eq!(p.source, root.path().join(old));
        assert_eq!(p.destination, root.path().join(new));
    }
    let called = std::cell::Cell::new(false);
    let status = data_dir::migrate_with(root.path(), "outside.table", "1.2.3", |_, _| {
        called.set(true);
        Ok(())
    })
    .unwrap();
    assert_eq!(status, MigrationStatus::NotMapped);
    assert!(!called.get());
}

#[test]
fn migrates_files_and_plans_then_commits_marker() {
    let root = TempDir::new("files");
    let p = seed_source(root.path());
    let status = data_dir::migrate(root.path(), "com.cu.app", "9.8.7").unwrap();
    assert_eq!(status, MigrationStatus::Migrated);
    assert_eq!(
        fs::read(p.destination.join("plans/one.md")).unwrap(),
        b"plan"
    );
    assert!(
        p.source.join("todos.json").is_file(),
        "source is the backup"
    );
    assert!(!p.migrating.exists());
    let marker: MigrationMarker =
        serde_json::from_slice(&fs::read(p.destination.join(MARKER_FILE)).unwrap()).unwrap();
    assert_eq!(marker.from, p.source.to_string_lossy());
    assert_eq!(marker.version, "9.8.7");
    assert_eq!(
        data_dir::selected_data_dir(root.path(), "com.cu.app"),
        p.destination
    );
}

#[test]
fn vacuum_into_includes_committed_rows_still_in_wal() {
    let root = TempDir::new("wal");
    let p = seed_source(root.path());
    let db = p.source.join("usage_stats.db");
    let conn = Connection::open(&db).unwrap();
    conn.execute_batch(
        "PRAGMA journal_mode=WAL;
         PRAGMA wal_autocheckpoint=0;
         CREATE TABLE sample(value TEXT);
         INSERT INTO sample VALUES ('base');
         PRAGMA wal_checkpoint(TRUNCATE);
         INSERT INTO sample VALUES ('only-in-wal');",
    )
    .unwrap();
    assert!(p.source.join("usage_stats.db-wal").exists());

    data_dir::migrate(root.path(), "com.cu.app", "1").unwrap();
    let copied = Connection::open(p.destination.join("usage_stats.db")).unwrap();
    let values: Vec<String> = copied
        .prepare("SELECT value FROM sample ORDER BY rowid")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(values, ["base", "only-in-wal"]);
}

#[test]
fn failed_copy_never_publishes_a_marker_and_preserves_source() {
    let root = TempDir::new("failure");
    let p = seed_source(root.path());
    let error = data_dir::migrate_with(root.path(), "com.cu.app", "1", |_, staging| {
        fs::write(staging.join("partial"), b"partial").unwrap();
        Err("injected middle failure".into())
    })
    .unwrap_err();
    assert!(error.to_string().contains("injected middle failure"));
    assert!(p.source.join("todos.json").is_file());
    assert!(!p.destination.join(MARKER_FILE).exists());
    assert!(!p.migrating.join(MARKER_FILE).exists());
}

#[test]
fn stale_migrating_directory_is_quarantined_before_retry() {
    let root = TempDir::new("staging");
    let p = seed_source(root.path());
    fs::create_dir_all(&p.migrating).unwrap();
    fs::write(p.migrating.join("partial"), b"old attempt").unwrap();
    data_dir::migrate(root.path(), "com.cu.app", "1").unwrap();
    let quarantined = quarantine_entries(root.path(), "com.cu.app.migrating.failed-");
    assert_eq!(quarantined.len(), 1);
    assert_eq!(
        fs::read(quarantined[0].join("partial")).unwrap(),
        b"old attempt"
    );
    assert!(p.destination.join(MARKER_FILE).is_file());
}

#[test]
fn unmarked_destination_with_live_source_is_quarantined() {
    let root = TempDir::new("unmarked");
    let p = seed_source(root.path());
    fs::create_dir_all(&p.destination).unwrap();
    fs::write(p.destination.join("split-brain"), b"not authoritative").unwrap();
    data_dir::migrate(root.path(), "com.cu.app", "1").unwrap();
    let quarantined = quarantine_entries(root.path(), "com.cu.app.failed-");
    assert_eq!(quarantined.len(), 1);
    assert!(quarantined[0].join("split-brain").is_file());
    assert!(p.destination.join(MARKER_FILE).is_file());
}

#[test]
fn clean_install_uses_new_directory_without_copying() {
    let root = TempDir::new("clean");
    let p = paths(root.path());
    let called = std::cell::Cell::new(false);
    let status = data_dir::migrate_with(root.path(), "com.cu.app", "1", |_, _| {
        called.set(true);
        Ok(())
    })
    .unwrap();
    assert_eq!(status, MigrationStatus::CleanInstall);
    assert!(!called.get());
    assert_eq!(
        data_dir::selected_data_dir(root.path(), "com.cu.app"),
        p.destination
    );
}
