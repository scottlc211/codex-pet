use crate::{clean_user_path, home_dir, is_plain_directory};
use serde::Serialize;
use serde_json::Value;
use std::{
    collections::BTreeMap,
    fs::{self, File},
    io::Read,
    path::{Component, Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};
use zip::ZipArchive;

static PET_STORAGE_MUTATION_RUNNING: AtomicBool = AtomicBool::new(false);

const MAX_ZIP_BYTES: u64 = 80 * 1024 * 1024;
const MAX_EXTRACTED_FILE_BYTES: u64 = 30 * 1024 * 1024;
const MAX_TOTAL_IMPORT_BYTES: u64 = 120 * 1024 * 1024;
const MAX_MANIFEST_BYTES: u64 = 256 * 1024;
const MAX_IMPORT_FILES: usize = 512;
const MAX_SCANNED_IMPORT_ENTRIES: usize = 4096;
const MAX_IMPORT_DEPTH: usize = 16;
const MAX_PET_SCAN_ENTRIES: usize = 5000;
const MAX_DISCOVERED_PETS: usize = 512;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PetCandidate {
    name: String,
    path: String,
    kind: String,
    can_delete: bool,
    states: BTreeMap<String, PetVisual>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PetVisual {
    kind: String,
    path: String,
    row: Option<u32>,
    frames: Option<u32>,
    total_ms: Option<u32>,
    frame_width: Option<u32>,
    frame_height: Option<u32>,
}

struct PetStorageMutationGuard;

#[derive(Default)]
struct ImportBudget {
    files: usize,
    scanned_entries: usize,
    total_bytes: u64,
}

impl PetStorageMutationGuard {
    fn try_start() -> Result<Self, String> {
        PET_STORAGE_MUTATION_RUNNING
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .map_err(|_| "已有主题正在导入或删除".to_string())?;
        Ok(Self)
    }
}

impl Drop for PetStorageMutationGuard {
    fn drop(&mut self) {
        PET_STORAGE_MUTATION_RUNNING.store(false, Ordering::SeqCst);
    }
}

#[derive(Clone, Copy)]
struct AtlasRow {
    key: &'static str,
    row: u32,
    durations: &'static [u32],
}

const ATLAS_FRAME_WIDTH: u32 = 192;
const ATLAS_FRAME_HEIGHT: u32 = 208;
const ATLAS_ROWS: &[AtlasRow] = &[
    AtlasRow {
        key: "idle",
        row: 0,
        durations: &[280, 110, 110, 140, 140, 320],
    },
    AtlasRow {
        key: "running-right",
        row: 1,
        durations: &[120, 120, 120, 120, 120, 120, 120, 220],
    },
    AtlasRow {
        key: "running-left",
        row: 2,
        durations: &[120, 120, 120, 120, 120, 120, 120, 220],
    },
    AtlasRow {
        key: "waving",
        row: 3,
        durations: &[140, 140, 140, 280],
    },
    AtlasRow {
        key: "jumping",
        row: 4,
        durations: &[140, 140, 140, 140, 280],
    },
    AtlasRow {
        key: "failed",
        row: 5,
        durations: &[140, 140, 140, 140, 140, 140, 140, 240],
    },
    AtlasRow {
        key: "waiting",
        row: 6,
        durations: &[150, 150, 150, 150, 150, 260],
    },
    AtlasRow {
        key: "running",
        row: 7,
        durations: &[120, 120, 120, 120, 120, 220],
    },
    AtlasRow {
        key: "review",
        row: 8,
        durations: &[150, 150, 150, 150, 150, 280],
    },
];

#[tauri::command]
pub(crate) fn find_pet_candidates() -> Vec<PetCandidate> {
    let mut candidates = Vec::new();
    let mut package_entries = 0;
    let mut image_entries = 0;

    for root in pet_roots() {
        collect_pet_packages(&root, 0, &mut package_entries, &mut candidates);
        collect_pet_images(&root, 0, &mut image_entries, &mut candidates);
    }

    candidates.sort_by(|a, b| a.name.cmp(&b.name).then(a.path.cmp(&b.path)));
    candidates.dedup_by(|a, b| a.path == b.path);
    candidates
}

#[tauri::command]
pub(crate) async fn import_pet_package(source_path: String) -> Result<PetCandidate, String> {
    tauri::async_runtime::spawn_blocking(move || import_pet_package_blocking(source_path))
        .await
        .map_err(|error| format!("等待导入任务失败：{error}"))?
}

fn import_pet_package_blocking(source_path: String) -> Result<PetCandidate, String> {
    let _storage_guard = PetStorageMutationGuard::try_start()?;
    let source = clean_user_path(&source_path)
        .canonicalize()
        .map_err(|error| format!("解析导入路径失败：{error}"))?;
    if source.is_dir() {
        return import_pet_directory(&source);
    }

    if source.is_file()
        && source
            .extension()
            .and_then(|value| value.to_str())
            .map(|value| value.eq_ignore_ascii_case("zip"))
            .unwrap_or(false)
    {
        let metadata = fs::metadata(&source).map_err(|error| format!("读取 zip 失败：{error}"))?;
        if metadata.len() > MAX_ZIP_BYTES {
            return Err("zip 包过大".to_string());
        }

        let target_dir = imported_package_dir(&source)?;
        let result = extract_zip_to_dir(&source, &target_dir).and_then(|()| {
            load_pet_package_from_dir(&target_dir)
                .or_else(|| find_first_pet_package(&target_dir, 0))
                .or_else(|| load_image_as_pet(&target_dir))
                .ok_or_else(|| "zip 包中未找到可识别的宠物资源".to_string())
        });
        if result.is_err() {
            let _ = fs::remove_dir_all(&target_dir);
        }
        return result;
    }

    if source.is_file() {
        return import_pet_image(&source);
    }

    Err("路径不存在".to_string())
}

#[tauri::command]
pub(crate) async fn delete_pet_package(candidate_path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || delete_pet_package_blocking(candidate_path))
        .await
        .map_err(|error| format!("等待主题删除任务失败：{error}"))?
}

fn delete_pet_package_blocking(candidate_path: String) -> Result<(), String> {
    let _storage_guard = PetStorageMutationGuard::try_start()?;
    let root = managed_pet_root().ok_or_else(|| "无法定位主题存储目录".to_string())?;
    let candidate = clean_user_path(&candidate_path);
    delete_managed_pet_candidate(&root, &candidate)
}

fn delete_managed_pet_candidate(root: &Path, candidate: &Path) -> Result<(), String> {
    let root = root
        .canonicalize()
        .map_err(|error| format!("解析主题存储目录失败：{error}"))?;
    let target = managed_pet_delete_target(&root, candidate)?;
    let metadata =
        fs::symlink_metadata(&target).map_err(|error| format!("读取待删除主题失败：{error}"))?;

    let result = if metadata.file_type().is_dir() {
        fs::remove_dir_all(&target).map_err(|error| format!("删除主题失败：{error}"))
    } else {
        fs::remove_file(&target).map_err(|error| format!("删除主题失败：{error}"))
    };
    result?;

    if let Some(parent) = target.parent() {
        prune_empty_pet_directories(parent.to_path_buf(), &root);
    }
    Ok(())
}

fn import_pet_directory(source: &Path) -> Result<PetCandidate, String> {
    let target_dir = imported_package_dir(source)?;
    if target_dir
        .canonicalize()
        .is_ok_and(|target| target.starts_with(source))
    {
        let _ = fs::remove_dir_all(&target_dir);
        return Err("不能导入包含宠物存储目录的上级目录".to_string());
    }
    let result = copy_import_directory(source, &target_dir).and_then(|()| {
        load_pet_package_from_dir(&target_dir)
            .or_else(|| find_first_pet_package(&target_dir, 0))
            .or_else(|| load_image_as_pet(&target_dir))
            .ok_or_else(|| "未找到可识别的 pet.json、theme.json 或图片资源".to_string())
    });
    if result.is_err() {
        let _ = fs::remove_dir_all(&target_dir);
    }
    result
}

fn import_pet_image(source: &Path) -> Result<PetCandidate, String> {
    if !is_supported_standalone_theme_image(source) {
        return Err("不支持的文件格式".to_string());
    }

    let target_dir = imported_package_dir(source)?;
    let result = (|| {
        let file_name = source
            .file_name()
            .ok_or_else(|| "无法识别导入文件名".to_string())?;
        let target = target_dir.join(file_name);
        let mut budget = ImportBudget::default();
        copy_import_file(source, &target, &mut budget)?;
        load_image_file_as_pet(&target).ok_or_else(|| "不支持的文件格式".to_string())
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(&target_dir);
    }
    result
}

fn pet_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();

    if let Some(home) = home_dir() {
        roots.push(home.join(".codex").join("pets"));
        roots.push(home.join(".codex-pet").join("pets"));
    }

    roots
}

fn managed_pet_root() -> Option<PathBuf> {
    home_dir().map(|home| home.join(".codex-pet").join("pets"))
}

fn can_delete_pet_candidate(path: &Path) -> bool {
    managed_pet_root().is_some_and(|root| managed_pet_delete_target(&root, path).is_ok())
}

fn managed_pet_delete_target(root: &Path, candidate: &Path) -> Result<PathBuf, String> {
    let root = root
        .canonicalize()
        .map_err(|error| format!("解析主题存储目录失败：{error}"))?;
    let candidate = candidate
        .canonicalize()
        .map_err(|error| format!("解析待删除主题失败：{error}"))?;
    let relative = candidate
        .strip_prefix(&root)
        .map_err(|_| "只能删除通过 Codex Pet 导入的主题".to_string())?;
    if relative.as_os_str().is_empty() {
        return Err("不能删除主题存储目录".to_string());
    }

    Ok(candidate)
}

fn prune_empty_pet_directories(mut directory: PathBuf, root: &Path) {
    while directory != root && directory.starts_with(root) {
        let is_empty = fs::read_dir(&directory)
            .map(|mut entries| entries.next().is_none())
            .unwrap_or(false);
        if !is_empty || fs::remove_dir(&directory).is_err() {
            break;
        }
        let Some(parent) = directory.parent() else {
            break;
        };
        directory = parent.to_path_buf();
    }
}

fn collect_pet_packages(
    root: &Path,
    depth: usize,
    scanned_entries: &mut usize,
    candidates: &mut Vec<PetCandidate>,
) {
    if depth > 5
        || !is_plain_directory(root)
        || *scanned_entries >= MAX_PET_SCAN_ENTRIES
        || candidates.len() >= MAX_DISCOVERED_PETS
    {
        return;
    }

    if let Some(candidate) = load_pet_package_from_dir(root) {
        candidates.push(candidate);
        return;
    }

    let Ok(entries) = fs::read_dir(root) else {
        return;
    };

    for entry in entries.flatten() {
        *scanned_entries += 1;
        if *scanned_entries > MAX_PET_SCAN_ENTRIES || candidates.len() >= MAX_DISCOVERED_PETS {
            return;
        }
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_symlink() {
            continue;
        }
        let path = entry.path();
        if file_type.is_dir() {
            collect_pet_packages(&path, depth + 1, scanned_entries, candidates);
        }
    }
}

fn collect_pet_images(
    root: &Path,
    depth: usize,
    scanned_entries: &mut usize,
    candidates: &mut Vec<PetCandidate>,
) {
    if depth > 3
        || !is_plain_directory(root)
        || *scanned_entries >= MAX_PET_SCAN_ENTRIES
        || candidates.len() >= MAX_DISCOVERED_PETS
    {
        return;
    }
    if load_pet_package_from_dir(root).is_some() {
        return;
    }

    let Ok(entries) = fs::read_dir(root) else {
        return;
    };

    for entry in entries.flatten() {
        *scanned_entries += 1;
        if *scanned_entries > MAX_PET_SCAN_ENTRIES || candidates.len() >= MAX_DISCOVERED_PETS {
            return;
        }
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_symlink() {
            continue;
        }
        let path = entry.path();
        if file_type.is_dir() {
            collect_pet_images(&path, depth + 1, scanned_entries, candidates);
            continue;
        }

        if file_type.is_file() {
            if let Some(candidate) = load_image_file_as_pet(&path) {
                candidates.push(candidate);
            }
        }
    }
}

fn load_pet_package_from_dir(package_dir: &Path) -> Option<PetCandidate> {
    let manifest_path = ["pet.json", "theme.json"]
        .iter()
        .map(|name| package_dir.join(name))
        .find(|path| path.is_file())?;

    let manifest = read_text_file_limited(&manifest_path, MAX_MANIFEST_BYTES)?;
    let manifest: Value = serde_json::from_str(&manifest).ok()?;
    let raw_name = manifest
        .get("displayName")
        .or_else(|| manifest.get("name"))
        .or_else(|| manifest.get("id"))
        .and_then(Value::as_str)
        .unwrap_or_else(|| {
            package_dir
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("Pet")
        });
    let name = normalize_pet_name(raw_name);

    if let Some(states) = manifest.get("states").and_then(Value::as_object) {
        let mut resolved_states = BTreeMap::new();
        for (state, value) in states {
            if let Some(visual) = parse_state_visual(package_dir, value) {
                resolved_states.insert(normalize_state_name(state), visual);
            }
        }
        resolve_missing_state_aliases(&mut resolved_states);
        if !resolved_states.is_empty() {
            return Some(PetCandidate {
                name,
                path: package_dir.to_string_lossy().to_string(),
                kind: "state-package".to_string(),
                can_delete: can_delete_pet_candidate(package_dir),
                states: resolved_states,
            });
        }
    }

    let spritesheet_path = manifest.get("spritesheetPath").and_then(Value::as_str)?;
    let spritesheet = resolve_package_file(package_dir, spritesheet_path)?;
    Some(PetCandidate {
        name,
        path: package_dir.to_string_lossy().to_string(),
        kind: "codex-pet-atlas".to_string(),
        can_delete: can_delete_pet_candidate(package_dir),
        states: codex_atlas_states(&spritesheet),
    })
}

fn parse_state_visual(package_dir: &Path, value: &Value) -> Option<PetVisual> {
    if let Some(file) = value.as_str() {
        return image_visual(package_dir, file);
    }

    if let Some(items) = value.as_array() {
        return items.iter().find_map(|item| {
            item.as_str()
                .and_then(|file| image_visual(package_dir, file))
        });
    }

    let object = value.as_object()?;
    if let Some(files) = object.get("files").and_then(Value::as_array) {
        return files.iter().find_map(|item| {
            item.as_str()
                .and_then(|file| image_visual(package_dir, file))
        });
    }
    if let Some(file) = object.get("file").and_then(Value::as_str) {
        return image_visual(package_dir, file);
    }

    None
}

fn image_visual(package_dir: &Path, relative_path: &str) -> Option<PetVisual> {
    let path = resolve_package_file(package_dir, relative_path)?;
    if !is_supported_image(&path) {
        return None;
    }

    Some(PetVisual {
        kind: "image".to_string(),
        path: path.to_string_lossy().to_string(),
        row: None,
        frames: None,
        total_ms: None,
        frame_width: None,
        frame_height: None,
    })
}

fn codex_atlas_states(spritesheet: &Path) -> BTreeMap<String, PetVisual> {
    let mut states = BTreeMap::new();
    for (state, row_key) in [
        ("idle", "idle"),
        ("thinking", "review"),
        ("working", "running"),
        ("running_command", "running"),
        ("editing_file", "running"),
        ("waiting_input", "waiting"),
        ("notification", "waiting"),
        ("success", "jumping"),
        ("attention", "jumping"),
        ("error", "failed"),
        ("dragging", "running"),
        ("dragging_left", "running-left"),
        ("dragging_right", "running-right"),
        ("sleeping", "idle"),
        ("sweeping", "running"),
        ("carrying", "running"),
    ] {
        if let Some(visual) = atlas_visual(spritesheet, row_key) {
            states.insert(state.to_string(), visual);
        }
    }
    states
}

fn atlas_visual(spritesheet: &Path, row_key: &str) -> Option<PetVisual> {
    let row = ATLAS_ROWS.iter().find(|row| row.key == row_key)?;
    Some(PetVisual {
        kind: "atlas".to_string(),
        path: spritesheet.to_string_lossy().to_string(),
        row: Some(row.row),
        frames: Some(row.durations.len() as u32),
        total_ms: Some(row.durations.iter().sum()),
        frame_width: Some(ATLAS_FRAME_WIDTH),
        frame_height: Some(ATLAS_FRAME_HEIGHT),
    })
}

fn resolve_missing_state_aliases(states: &mut BTreeMap<String, PetVisual>) {
    let aliases = [
        ("thinking", "idle"),
        ("working", "thinking"),
        ("running_command", "working"),
        ("editing_file", "working"),
        ("waiting_input", "notification"),
        ("success", "attention"),
        ("error", "idle"),
        ("dragging", "working"),
        ("dragging_left", "dragging"),
        ("dragging_right", "dragging"),
    ];

    for (state, fallback) in aliases {
        if states.contains_key(state) {
            continue;
        }
        if let Some(visual) = states
            .get(fallback)
            .cloned()
            .or_else(|| states.get("idle").cloned())
        {
            states.insert(state.to_string(), visual);
        }
    }
}

fn load_image_as_pet(dir: &Path) -> Option<PetCandidate> {
    let mut images = Vec::new();
    collect_image_paths(dir, 0, &mut images);
    images
        .into_iter()
        .next()
        .and_then(|path| load_image_file_as_pet(&path))
}

fn load_image_file_as_pet(path: &Path) -> Option<PetCandidate> {
    if !is_supported_standalone_theme_image(path) {
        return None;
    }

    let name = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("pet")
        .to_string();
    let visual = PetVisual {
        kind: "image".to_string(),
        path: path.to_string_lossy().to_string(),
        row: None,
        frames: None,
        total_ms: None,
        frame_width: None,
        frame_height: None,
    };

    let mut states = BTreeMap::new();
    for state in [
        "idle",
        "thinking",
        "working",
        "running_command",
        "editing_file",
        "waiting_input",
        "success",
        "error",
        "dragging",
    ] {
        states.insert(state.to_string(), visual.clone());
    }

    Some(PetCandidate {
        name,
        path: path.to_string_lossy().to_string(),
        kind: "image".to_string(),
        can_delete: can_delete_pet_candidate(path),
        states,
    })
}

fn find_first_pet_package(root: &Path, depth: usize) -> Option<PetCandidate> {
    if depth > MAX_IMPORT_DEPTH || !is_plain_directory(root) {
        return None;
    }
    if let Some(candidate) = load_pet_package_from_dir(root) {
        return Some(candidate);
    }
    let entries = fs::read_dir(root).ok()?;
    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_symlink() || !file_type.is_dir() {
            continue;
        }
        let path = entry.path();
        if let Some(candidate) = find_first_pet_package(&path, depth + 1) {
            return Some(candidate);
        }
    }
    None
}

fn collect_image_paths(root: &Path, depth: usize, out: &mut Vec<PathBuf>) {
    if depth > 4 || !root.exists() {
        return;
    }
    if root.is_file() {
        if is_supported_standalone_theme_image(root) {
            out.push(root.to_path_buf());
        }
        return;
    }
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_symlink() {
            continue;
        }
        let path = entry.path();
        if file_type.is_dir() {
            collect_image_paths(&path, depth + 1, out);
        } else if file_type.is_file() && is_supported_standalone_theme_image(&path) {
            out.push(path);
        }
    }
}

fn resolve_package_file(package_dir: &Path, relative_path: &str) -> Option<PathBuf> {
    let root = package_dir.canonicalize().ok()?;
    let relative = safe_relative_path(relative_path)?;
    for base in [root.clone(), root.join("assets")] {
        if let Ok(candidate) = base.join(&relative).canonicalize() {
            if candidate.is_file() && candidate.starts_with(&root) {
                return Some(candidate);
            }
        }
    }
    None
}

fn normalize_state_name(state: &str) -> String {
    match state {
        "attention" | "happy" => "success",
        "notification" => "waiting_input",
        "working" => "working",
        "typing" => "running_command",
        other => other,
    }
    .to_string()
}

fn is_supported_image(path: &Path) -> bool {
    let Some(extension) = path.extension().and_then(|value| value.to_str()) else {
        return false;
    };
    matches!(
        extension.to_ascii_lowercase().as_str(),
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg" | "apng"
    )
}

fn is_supported_standalone_theme_image(path: &Path) -> bool {
    let Some(extension) = path.extension().and_then(|value| value.to_str()) else {
        return false;
    };
    matches!(
        extension.to_ascii_lowercase().as_str(),
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg" | "apng"
    )
}

fn imported_package_dir(source: &Path) -> Result<PathBuf, String> {
    let home = home_dir().ok_or_else(|| "无法定位用户目录".to_string())?;
    let root = home.join(".codex-pet").join("pets");
    fs::create_dir_all(&root).map_err(|error| format!("创建导入目录失败：{error}"))?;
    let stem = source
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("pet");
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_nanos())
        .unwrap_or(0);
    let base_name = format!("{}-{timestamp}", slugify(stem));
    for suffix in 0..100 {
        let name = if suffix == 0 {
            base_name.clone()
        } else {
            format!("{base_name}-{suffix}")
        };
        let candidate = root.join(name);
        match fs::create_dir(&candidate) {
            Ok(()) => return Ok(candidate),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("创建导入目录失败：{error}")),
        }
    }
    Err("无法创建唯一的导入目录".to_string())
}

fn extract_zip_to_dir(source: &Path, target_dir: &Path) -> Result<(), String> {
    let file = File::open(source).map_err(|error| format!("打开 zip 失败：{error}"))?;
    let mut archive = ZipArchive::new(file).map_err(|error| format!("读取 zip 失败：{error}"))?;
    if archive.len() > MAX_IMPORT_FILES {
        return Err(format!("zip 条目数不能超过 {MAX_IMPORT_FILES}"));
    }
    let mut budget = ImportBudget::default();

    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|error| format!("读取 zip 条目失败：{error}"))?;
        if entry.is_dir() {
            continue;
        }

        let relative = safe_relative_path(entry.name())
            .ok_or_else(|| format!("zip 包含不安全路径：{}", entry.name()))?;

        if !is_allowed_import_file(&relative) {
            continue;
        }

        let out_path = target_dir.join(relative);
        if let Some(parent) = out_path.parent() {
            fs::create_dir_all(parent).map_err(|error| format!("创建目录失败：{error}"))?;
        }
        copy_import_reader(&mut entry, &out_path, &mut budget)?;
    }

    if budget.files == 0 {
        return Err("zip 包中没有可导入的文件".to_string());
    }
    Ok(())
}

fn safe_relative_path(name: &str) -> Option<PathBuf> {
    let normalized = name.replace('\\', "/");
    let path = Path::new(&normalized);
    let mut out = PathBuf::new();
    let mut depth = 0;
    for component in path.components() {
        match component {
            Component::Normal(part) => {
                depth += 1;
                if depth > MAX_IMPORT_DEPTH {
                    return None;
                }
                out.push(part);
            }
            _ => return None,
        }
    }
    if out.as_os_str().is_empty() {
        None
    } else {
        Some(out)
    }
}

fn copy_import_directory(source: &Path, target: &Path) -> Result<(), String> {
    let mut budget = ImportBudget::default();
    copy_import_directory_inner(source, source, target, 0, &mut budget)?;
    if budget.files == 0 {
        return Err("目录中没有可导入的文件".to_string());
    }
    Ok(())
}

fn copy_import_directory_inner(
    root: &Path,
    current: &Path,
    target: &Path,
    depth: usize,
    budget: &mut ImportBudget,
) -> Result<(), String> {
    if depth > MAX_IMPORT_DEPTH {
        return Err(format!("导入目录层级不能超过 {MAX_IMPORT_DEPTH}"));
    }

    let mut entries = Vec::new();
    for entry in fs::read_dir(current).map_err(|error| format!("读取导入目录失败：{error}"))?
    {
        budget.scanned_entries += 1;
        if budget.scanned_entries > MAX_SCANNED_IMPORT_ENTRIES {
            return Err(format!(
                "导入目录条目数不能超过 {MAX_SCANNED_IMPORT_ENTRIES}"
            ));
        }
        entries.push(entry.map_err(|error| format!("读取导入目录条目失败：{error}"))?);
    }
    entries.sort_by_key(|entry| entry.file_name());

    for entry in entries {
        let file_type = entry
            .file_type()
            .map_err(|error| format!("读取导入条目类型失败：{error}"))?;
        if file_type.is_symlink() {
            return Err(format!(
                "导入目录不能包含符号链接：{}",
                entry.path().display()
            ));
        }

        let path = entry.path();
        let relative = path
            .strip_prefix(root)
            .map_err(|_| "导入路径越过源目录边界".to_string())?;
        if file_type.is_dir() {
            copy_import_directory_inner(root, &path, target, depth + 1, budget)?;
        } else if file_type.is_file() && is_allowed_import_file(relative) {
            let out_path = target.join(relative);
            if let Some(parent) = out_path.parent() {
                fs::create_dir_all(parent).map_err(|error| format!("创建导入目录失败：{error}"))?;
            }
            copy_import_file(&path, &out_path, budget)?;
        }
    }
    Ok(())
}

fn copy_import_file(source: &Path, target: &Path, budget: &mut ImportBudget) -> Result<(), String> {
    let mut input = File::open(source).map_err(|error| format!("打开导入文件失败：{error}"))?;
    copy_import_reader(&mut input, target, budget)
}

fn copy_import_reader(
    input: &mut impl Read,
    target: &Path,
    budget: &mut ImportBudget,
) -> Result<(), String> {
    if budget.files >= MAX_IMPORT_FILES {
        return Err(format!("导入文件数不能超过 {MAX_IMPORT_FILES}"));
    }

    let file_limit = if target
        .file_name()
        .and_then(|value| value.to_str())
        .is_some_and(|name| matches!(name, "pet.json" | "theme.json"))
    {
        MAX_MANIFEST_BYTES
    } else {
        MAX_EXTRACTED_FILE_BYTES
    };
    let remaining = MAX_TOTAL_IMPORT_BYTES.saturating_sub(budget.total_bytes);
    let limit = file_limit.min(remaining);
    if limit == 0 {
        return Err("导入文件总大小超出限制".to_string());
    }

    let mut output = File::create(target).map_err(|error| format!("创建导入文件失败：{error}"))?;
    let copied = std::io::copy(&mut input.take(limit + 1), &mut output)
        .map_err(|error| format!("复制导入文件失败：{error}"))?;
    if copied > limit {
        return Err(if file_limit <= remaining {
            if file_limit == MAX_MANIFEST_BYTES {
                format!("宠物清单不能超过 {} KiB", file_limit / 1024)
            } else {
                format!("单个导入文件不能超过 {} MiB", file_limit / 1024 / 1024)
            }
        } else {
            format!(
                "导入文件总大小不能超过 {} MiB",
                MAX_TOTAL_IMPORT_BYTES / 1024 / 1024
            )
        });
    }

    budget.files += 1;
    budget.total_bytes += copied;
    Ok(())
}

fn read_text_file_limited(path: &Path, limit: u64) -> Option<String> {
    let file = File::open(path).ok()?;
    if file.metadata().ok()?.len() > limit {
        return None;
    }
    let mut text = String::new();
    file.take(limit + 1).read_to_string(&mut text).ok()?;
    (text.len() as u64 <= limit).then_some(text)
}

fn normalize_pet_name(value: &str) -> String {
    let name: String = value
        .trim()
        .chars()
        .filter(|value| !value.is_control())
        .take(64)
        .collect();
    if name.is_empty() {
        "Pet".to_string()
    } else {
        name
    }
}

fn is_allowed_import_file(path: &Path) -> bool {
    if let Some(file_name) = path.file_name().and_then(|value| value.to_str()) {
        if matches!(file_name, "pet.json" | "theme.json") {
            return true;
        }
    }
    is_supported_image(path)
}

fn slugify(value: &str) -> String {
    let slug: String = value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() {
                ch.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect();
    let slug = slug.trim_matches('-');
    if slug.is_empty() {
        "pet".to_string()
    } else {
        slug.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new(name: &str) -> Self {
            let unique = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|value| value.as_nanos())
                .unwrap_or(0);
            let path =
                env::temp_dir().join(format!("codex-pet-{name}-{}-{unique}", std::process::id()));
            fs::create_dir_all(&path).expect("create test directory");
            Self(path)
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn safe_relative_path_rejects_traversal_and_excessive_depth() {
        assert_eq!(
            safe_relative_path("states/idle.webp"),
            Some(PathBuf::from("states/idle.webp"))
        );
        assert_eq!(
            safe_relative_path("states\\idle.webp"),
            Some(PathBuf::from("states/idle.webp"))
        );
        assert!(safe_relative_path("../secret.png").is_none());
        assert!(safe_relative_path("/etc/passwd").is_none());
        assert!(safe_relative_path(".").is_none());

        let too_deep = (0..=MAX_IMPORT_DEPTH)
            .map(|index| format!("level-{index}"))
            .collect::<Vec<_>>()
            .join("/");
        assert!(safe_relative_path(&too_deep).is_none());
    }

    #[test]
    fn package_resources_must_stay_inside_package_directory() {
        let temp = TestDirectory::new("package-boundary");
        let package = temp.0.join("package");
        fs::create_dir_all(&package).expect("create package");
        fs::write(package.join("idle.png"), b"inside").expect("write inside image");
        fs::write(temp.0.join("outside.png"), b"outside").expect("write outside image");

        let resolved = resolve_package_file(&package, "idle.png").expect("resolve package image");
        assert_eq!(
            resolved,
            package
                .join("idle.png")
                .canonicalize()
                .expect("canonical image")
        );
        assert!(resolve_package_file(&package, "../outside.png").is_none());
    }

    #[test]
    fn managed_theme_deletion_removes_only_the_selected_candidate() {
        let temp = TestDirectory::new("managed-delete-target");
        let root = temp.0.join("pets");
        let import = root.join("theme-123");
        let nested_package = import.join("package");
        let sibling = import.join("keep.png");
        let outside = temp.0.join("outside");
        fs::create_dir_all(&nested_package).expect("create managed theme");
        fs::write(&sibling, b"keep").expect("create sibling theme");
        fs::create_dir_all(&outside).expect("create outside directory");

        let target = managed_pet_delete_target(&root, &nested_package)
            .expect("resolve managed theme candidate");
        assert_eq!(
            target,
            nested_package.canonicalize().expect("canonical theme")
        );
        assert!(managed_pet_delete_target(&root, &root).is_err());
        assert!(managed_pet_delete_target(&root, &outside).is_err());

        delete_managed_pet_candidate(&root, &nested_package).expect("delete managed theme");
        assert!(!nested_package.exists());
        assert!(sibling.exists());
    }

    #[cfg(unix)]
    #[test]
    fn package_resources_cannot_escape_through_symlinks() {
        use std::os::unix::fs::symlink;

        let temp = TestDirectory::new("package-symlink");
        let package = temp.0.join("package");
        fs::create_dir_all(&package).expect("create package");
        let outside = temp.0.join("outside.png");
        fs::write(&outside, b"outside").expect("write outside image");
        symlink(&outside, package.join("idle.png")).expect("create image symlink");

        assert!(resolve_package_file(&package, "idle.png").is_none());
    }

    #[test]
    fn import_reader_enforces_manifest_and_file_count_limits() {
        let temp = TestDirectory::new("import-limits");
        let oversized_manifest = vec![b'x'; MAX_MANIFEST_BYTES as usize + 1];
        let mut input = oversized_manifest.as_slice();
        let mut budget = ImportBudget::default();
        assert!(copy_import_reader(&mut input, &temp.0.join("pet.json"), &mut budget).is_err());

        let mut input = b"x".as_slice();
        let mut full_budget = ImportBudget {
            files: MAX_IMPORT_FILES,
            ..ImportBudget::default()
        };
        assert!(
            copy_import_reader(&mut input, &temp.0.join("idle.png"), &mut full_budget).is_err()
        );
    }
}
