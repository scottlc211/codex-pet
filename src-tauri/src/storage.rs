use serde::Serialize;
use std::{
    fs::{self, File},
    io::Write,
    path::{Path, PathBuf},
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum RecoverySource {
    Primary,
    Backup,
    Missing,
    Invalid,
}

pub(crate) struct RecoveryRead<T> {
    pub(crate) value: Option<T>,
    pub(crate) source: RecoverySource,
}

pub(crate) fn read_with_backup_status<T>(
    path: &Path,
    parser: impl Fn(&str) -> Option<T>,
) -> RecoveryRead<T> {
    let primary = fs::read_to_string(path).ok();
    if let Some(value) = primary.as_deref().and_then(&parser) {
        return RecoveryRead {
            value: Some(value),
            source: RecoverySource::Primary,
        };
    }

    let backup = fs::read_to_string(backup_path(path)).ok();
    if let Some(value) = backup.as_deref().and_then(&parser) {
        return RecoveryRead {
            value: Some(value),
            source: RecoverySource::Backup,
        };
    }

    RecoveryRead {
        value: None,
        source: if primary.is_none() && backup.is_none() {
            RecoverySource::Missing
        } else {
            RecoverySource::Invalid
        },
    }
}

pub(crate) fn write_json_atomically_with_backup_policy<T: Serialize>(
    path: &Path,
    value: &T,
    backup_current: bool,
) -> Result<(), String> {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent).map_err(|error| format!("创建配置目录失败：{error}"))?;

    let mut temp = tempfile::NamedTempFile::new_in(parent)
        .map_err(|error| format!("创建配置临时文件失败：{error}"))?;
    serde_json::to_writer_pretty(&mut temp, value)
        .map_err(|error| format!("序列化配置失败：{error}"))?;
    temp.write_all(b"\n")
        .map_err(|error| format!("写入配置临时文件失败：{error}"))?;
    temp.as_file_mut()
        .sync_all()
        .map_err(|error| format!("同步配置临时文件失败：{error}"))?;

    if backup_current && path.exists() {
        let backup = backup_path(path);
        fs::copy(path, &backup).map_err(|error| format!("备份现有配置失败：{error}"))?;
        File::open(&backup)
            .and_then(|file| file.sync_all())
            .map_err(|error| format!("同步配置备份失败：{error}"))?;
    }

    temp.persist(path)
        .map_err(|error| format!("替换配置文件失败：{}", error.error))?;
    sync_parent_directory(parent)?;
    Ok(())
}

fn backup_path(path: &Path) -> PathBuf {
    let backup_extension = path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| format!("{value}.bak"))
        .unwrap_or_else(|| "bak".to_string());
    path.with_extension(backup_extension)
}

#[cfg(unix)]
fn sync_parent_directory(parent: &Path) -> Result<(), String> {
    File::open(parent)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| format!("同步配置目录失败：{error}"))
}

#[cfg(not(unix))]
fn sync_parent_directory(_parent: &Path) -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::{Deserialize, Serialize};

    #[derive(Debug, Deserialize, PartialEq, Serialize)]
    struct TestConfig {
        value: u32,
    }

    #[test]
    fn atomic_write_keeps_previous_value_as_backup() {
        let directory = tempfile::tempdir().expect("create temp directory");
        let path = directory.path().join("config.json");

        write_json_atomically_with_backup_policy(&path, &TestConfig { value: 1 }, true)
            .expect("write first config");
        write_json_atomically_with_backup_policy(&path, &TestConfig { value: 2 }, true)
            .expect("write second config");

        let current: TestConfig =
            serde_json::from_str(&fs::read_to_string(&path).expect("read current config"))
                .expect("parse current config");
        let backup: TestConfig = serde_json::from_str(
            &fs::read_to_string(backup_path(&path)).expect("read backup config"),
        )
        .expect("parse backup config");
        assert_eq!(current, TestConfig { value: 2 });
        assert_eq!(backup, TestConfig { value: 1 });
    }

    #[test]
    fn read_uses_backup_when_current_value_is_invalid() {
        let directory = tempfile::tempdir().expect("create temp directory");
        let path = directory.path().join("config.json");
        fs::write(&path, "invalid").expect("write invalid current config");
        fs::write(backup_path(&path), r#"{"value":7}"#).expect("write backup config");

        let config = read_with_backup_status(&path, |text| serde_json::from_str(text).ok());
        assert_eq!(config.value, Some(TestConfig { value: 7 }));
    }

    #[test]
    fn read_reports_backup_and_invalid_sources() {
        let directory = tempfile::tempdir().expect("create temp directory");
        let path = directory.path().join("config.json");
        fs::write(&path, "invalid").expect("write invalid current config");
        fs::write(backup_path(&path), r#"{"value":9}"#).expect("write backup config");

        let recovered = read_with_backup_status(&path, |text| serde_json::from_str(text).ok());
        assert_eq!(recovered.source, RecoverySource::Backup);
        assert_eq!(recovered.value, Some(TestConfig { value: 9 }));

        fs::write(backup_path(&path), "invalid").expect("write invalid backup config");
        let invalid =
            read_with_backup_status::<TestConfig>(&path, |text| serde_json::from_str(text).ok());
        assert_eq!(invalid.source, RecoverySource::Invalid);
        assert!(invalid.value.is_none());
    }

    #[test]
    fn write_can_preserve_recovery_backup() {
        let directory = tempfile::tempdir().expect("create temp directory");
        let path = directory.path().join("config.json");
        let backup = backup_path(&path);
        fs::write(&path, "invalid").expect("write invalid current config");
        fs::write(&backup, r#"{"value":4}"#).expect("write valid backup config");

        write_json_atomically_with_backup_policy(&path, &TestConfig { value: 5 }, false)
            .expect("repair current config");

        let preserved: TestConfig = serde_json::from_str(
            &fs::read_to_string(&backup).expect("read preserved backup config"),
        )
        .expect("parse preserved backup config");
        assert_eq!(preserved, TestConfig { value: 4 });
    }
}
