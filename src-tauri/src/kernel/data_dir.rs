use std::fmt;
use std::fs;
use std::path::{Path, PathBuf};

use chrono::SecondsFormat;
use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};

use super::board_lock;

pub const MARKER_FILE: &str = "migrated-from";

const IDENTIFIER_PAIRS: [(&str, &str); 3] = [
    ("com.claude-usage-tracker.app", "com.cu.app"),
    ("com.claude-usage-tracker.dev", "com.cu.dev"),
    ("com.claude-usage-tracker.preview", "com.cu.preview"),
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DataDirPaths {
    pub source: PathBuf,
    pub destination: PathBuf,
    pub migrating: PathBuf,
}

impl DataDirPaths {
    pub fn for_identifier(roaming: &Path, identifier: &str) -> Option<Self> {
        let (old, new) = IDENTIFIER_PAIRS
            .iter()
            .find(|(_, new)| *new == identifier)?;
        let destination = roaming.join(new);
        let migrating = destination.with_file_name(format!("{new}.migrating"));
        Some(Self {
            source: roaming.join(old),
            destination,
            migrating,
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MigrationMarker {
    pub from: String,
    pub migrated_at: String,
    pub version: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MigrationStatus {
    NotMapped,
    AlreadyMigrated,
    CleanInstall,
    Migrated,
}

#[derive(Debug)]
pub struct MigrationError {
    pub source: PathBuf,
    pub destination: PathBuf,
    message: String,
}

impl MigrationError {
    fn new(paths: &DataDirPaths, message: impl Into<String>) -> Self {
        Self {
            source: paths.source.clone(),
            destination: paths.destination.clone(),
            message: message.into(),
        }
    }

    pub fn startup(source: PathBuf, destination: PathBuf, message: impl Into<String>) -> Self {
        Self {
            source,
            destination,
            message: message.into(),
        }
    }
}

impl fmt::Display for MigrationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for MigrationError {}

pub fn has_marker(dir: &Path) -> bool {
    dir.join(MARKER_FILE).is_file()
}

pub fn selected_data_dir(roaming: &Path, identifier: &str) -> PathBuf {
    let Some(paths) = DataDirPaths::for_identifier(roaming, identifier) else {
        return roaming.join(identifier);
    };
    if has_marker(&paths.destination) || !paths.source.exists() {
        paths.destination
    } else {
        paths.source
    }
}

fn quarantine(path: &Path) -> std::io::Result<Option<PathBuf>> {
    if !path.exists() {
        return Ok(None);
    }
    let stamp = chrono::Utc::now().format("%Y%m%dT%H%M%S%.3fZ");
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy())
        .unwrap_or_default();
    for suffix in 0..1000u16 {
        let extra = if suffix == 0 {
            String::new()
        } else {
            format!("-{suffix}")
        };
        let failed = path.with_file_name(format!("{name}.failed-{stamp}{extra}"));
        if failed.exists() {
            continue;
        }
        fs::rename(path, &failed)?;
        return Ok(Some(failed));
    }
    Err(std::io::Error::new(
        std::io::ErrorKind::AlreadyExists,
        format!("could not allocate quarantine name for {}", path.display()),
    ))
}

fn write_marker(paths: &DataDirPaths, version: &str) -> Result<(), String> {
    let marker = MigrationMarker {
        from: paths.source.to_string_lossy().into_owned(),
        migrated_at: chrono::Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
        version: version.to_string(),
    };
    let bytes = serde_json::to_vec_pretty(&marker).map_err(|e| e.to_string())?;
    fs::write(paths.migrating.join(MARKER_FILE), bytes).map_err(|e| e.to_string())
}

pub fn migrate_with<F>(
    roaming: &Path,
    identifier: &str,
    version: &str,
    copy: F,
) -> Result<MigrationStatus, MigrationError>
where
    F: FnOnce(&Path, &Path) -> Result<(), String>,
{
    let Some(paths) = DataDirPaths::for_identifier(roaming, identifier) else {
        return Ok(MigrationStatus::NotMapped);
    };
    if has_marker(&paths.destination) {
        return Ok(MigrationStatus::AlreadyMigrated);
    }

    if !paths.source.exists() {
        quarantine(&paths.migrating).map_err(|e| {
            MigrationError::new(
                &paths,
                format!("cannot quarantine {}: {e}", paths.migrating.display()),
            )
        })?;
        return Ok(MigrationStatus::CleanInstall);
    }

    let board = paths.source.join("todos.json");
    let _lock = board_lock::acquire(&board).map_err(|e| {
        MigrationError::new(&paths, format!("cannot lock {}: {e}", board.display()))
    })?;

    if has_marker(&paths.destination) {
        return Ok(MigrationStatus::AlreadyMigrated);
    }
    if !paths.source.exists() {
        return Ok(MigrationStatus::CleanInstall);
    }

    quarantine(&paths.migrating).map_err(|e| {
        MigrationError::new(
            &paths,
            format!("cannot quarantine {}: {e}", paths.migrating.display()),
        )
    })?;
    if paths.destination.exists() {
        quarantine(&paths.destination).map_err(|e| {
            MigrationError::new(
                &paths,
                format!("cannot quarantine {}: {e}", paths.destination.display()),
            )
        })?;
    }

    fs::create_dir_all(&paths.migrating).map_err(|e| {
        MigrationError::new(
            &paths,
            format!("cannot create {}: {e}", paths.migrating.display()),
        )
    })?;
    copy(&paths.source, &paths.migrating).map_err(|e| {
        MigrationError::new(
            &paths,
            format!(
                "snapshot {} -> {} failed: {e}",
                paths.source.display(),
                paths.migrating.display()
            ),
        )
    })?;
    write_marker(&paths, version)
        .map_err(|e| MigrationError::new(&paths, format!("cannot write migration marker: {e}")))?;
    fs::rename(&paths.migrating, &paths.destination).map_err(|e| {
        MigrationError::new(
            &paths,
            format!(
                "cannot commit {} -> {}: {e}",
                paths.migrating.display(),
                paths.destination.display()
            ),
        )
    })?;
    Ok(MigrationStatus::Migrated)
}

pub fn migrate(
    roaming: &Path,
    identifier: &str,
    version: &str,
) -> Result<MigrationStatus, MigrationError> {
    migrate_with(roaming, identifier, version, copy_snapshot)
}

fn copy_snapshot(source: &Path, destination: &Path) -> Result<(), String> {
    copy_tree(source, destination)?;
    let db = source.join("usage_stats.db");
    if db.is_file() {
        let target = destination.join("usage_stats.db");
        let conn = Connection::open_with_flags(&db, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|e| format!("open {}: {e}", db.display()))?;
        conn.execute("VACUUM INTO ?1", [target.to_string_lossy().as_ref()])
            .map_err(|e| format!("VACUUM INTO {}: {e}", target.display()))?;
    }
    Ok(())
}

fn copy_tree(source: &Path, destination: &Path) -> Result<(), String> {
    fs::create_dir_all(destination).map_err(|e| e.to_string())?;
    for entry in fs::read_dir(source).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name();
        let name_text = name.to_string_lossy();
        if matches!(
            name_text.as_ref(),
            "usage_stats.db" | "usage_stats.db-wal" | "usage_stats.db-shm" | "todos.json.lock"
        ) {
            continue;
        }
        let from = entry.path();
        let to = destination.join(name);
        if entry.file_type().map_err(|e| e.to_string())?.is_dir() {
            copy_tree(&from, &to)?;
        } else {
            fs::copy(&from, &to)
                .map_err(|e| format!("copy {} -> {}: {e}", from.display(), to.display()))?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn data_dir_identifier_table_is_explicit() {
        let root = Path::new("roaming");
        for (old, new) in IDENTIFIER_PAIRS {
            let paths = DataDirPaths::for_identifier(root, new).expect("mapped identifier");
            assert_eq!(paths.source, root.join(old));
            assert_eq!(paths.destination, root.join(new));
            assert_eq!(paths.migrating, root.join(format!("{new}.migrating")));
        }
        assert!(DataDirPaths::for_identifier(root, "com.example.unknown").is_none());
        assert_eq!(
            selected_data_dir(root, "com.example.unknown"),
            root.join("com.example.unknown")
        );
    }
}
