use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use chrono::Utc;
use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, State};

const FILE_CHANGED_EVENT: &str = "workspace:file-changed";
const WATCH_ERROR_EVENT: &str = "workspace:watch-error";

#[derive(Default)]
struct AppState {
    workspace: Mutex<Option<WorkspaceState>>,
}

struct WorkspaceState {
    data_path: PathBuf,
    schema_path: PathBuf,
    watcher: Option<RecommendedWatcher>,
}

impl WorkspaceState {
    fn new(data_path: PathBuf, schema_path: PathBuf) -> Self {
        Self {
            data_path,
            schema_path,
            watcher: None,
        }
    }

    fn start_watcher(&mut self, app_handle: AppHandle) -> Result<(), String> {
        let data_path = Arc::new(self.data_path.clone());
        let schema_path = Arc::new(self.schema_path.clone());
        let data_path_str = Arc::new(data_path.to_string_lossy().into_owned());
        let schema_path_str = Arc::new(schema_path.to_string_lossy().into_owned());
        let handle = app_handle.clone();

        let mut watcher = notify::recommended_watcher({
            let data_path = Arc::clone(&data_path);
            let schema_path = Arc::clone(&schema_path);
            let data_path_str = Arc::clone(&data_path_str);
            let schema_path_str = Arc::clone(&schema_path_str);
            move |res: Result<Event, notify::Error>| match res {
                Ok(event) => {
                    if !matches!(
                        event.kind,
                        EventKind::Modify(_) | EventKind::Create(_) | EventKind::Remove(_)
                    ) {
                        return;
                    }

                    let relevant = event
                        .paths
                        .iter()
                        .any(|path| path == &*data_path || path == &*schema_path);

                    if relevant {
                        let payload = WorkspaceChangePayload {
                            data_path: data_path_str.as_ref().clone(),
                            schema_path: schema_path_str.as_ref().clone(),
                        };
                        let _ = handle.emit(FILE_CHANGED_EVENT, payload);
                    }
                }
                Err(error) => {
                    let payload = WatchErrorPayload {
                        message: error.to_string(),
                    };
                    let _ = handle.emit(WATCH_ERROR_EVENT, payload);
                }
            }
        })
        .map_err(|err| err.to_string())?;

        watcher
            .configure(
                Config::default()
                    .with_compare_contents(true)
                    .with_poll_interval(Duration::from_secs(1)),
            )
            .map_err(|err| err.to_string())?;

        watcher
            .watch(&*data_path, RecursiveMode::NonRecursive)
            .map_err(|err| err.to_string())?;
        watcher
            .watch(&*schema_path, RecursiveMode::NonRecursive)
            .map_err(|err| err.to_string())?;

        self.watcher = Some(watcher);
        Ok(())
    }

    fn stop(&mut self) {
        if let Some(watcher) = self.watcher.as_mut() {
            let _ = watcher.unwatch(&self.data_path);
            let _ = watcher.unwatch(&self.schema_path);
        }
        self.watcher = None;
    }
}

impl AppState {
    fn set_workspace(&self, app_handle: &AppHandle, data_path: PathBuf) -> Result<PathBuf, String> {
        let schema_path = schema_path_for(&data_path)?;
        ensure_data_files(&data_path, &schema_path)?;

        let mut guard = self.workspace.lock();
        if let Some(existing) = guard.as_mut() {
            existing.stop();
        }

        let mut workspace = WorkspaceState::new(data_path.clone(), schema_path.clone());
        workspace.start_watcher(app_handle.clone())?;
        *guard = Some(workspace);

        Ok(schema_path)
    }

    fn paths(&self) -> Result<(PathBuf, PathBuf), String> {
        self.workspace
            .lock()
            .as_ref()
            .map(|workspace| (workspace.data_path.clone(), workspace.schema_path.clone()))
            .ok_or_else(|| "Workspace not loaded".to_string())
    }
}

#[derive(Serialize)]
struct WorkspaceInfo {
    data_path: String,
    schema_path: String,
    folder: String,
}

#[derive(Serialize)]
struct TablePayload {
    data: Vec<Value>,
    schema: Value,
    workspace: WorkspaceInfo,
}

#[derive(Serialize, Clone)]
struct WorkspaceChangePayload {
    data_path: String,
    schema_path: String,
}

#[derive(Serialize, Clone)]
struct WatchErrorPayload {
    message: String,
}

#[derive(Deserialize)]
struct SavePayload {
    data: Vec<Value>,
    schema: Value,
}

#[derive(Serialize)]
struct SaveResult {
    row_count: usize,
    updated_at: String,
}

#[tauri::command]
async fn load_table(
    app_handle: AppHandle,
    state: State<'_, AppState>,
    data_path: String,
) -> Result<TablePayload, String> {
    let data_path = PathBuf::from(data_path);
    if !data_path.exists() {
        return Err("指定されたデータファイルが存在しません".to_string());
    }

    let schema_path = state.set_workspace(&app_handle, data_path.clone())?;
    build_table_payload(&data_path, &schema_path)
}

#[tauri::command]
async fn save_table(
    state: State<'_, AppState>,
    payload: SavePayload,
) -> Result<SaveResult, String> {
    let (data_path, schema_path) = state.paths()?;
    let (mut data, mut schema) = (payload.data, payload.schema);
    let now = Utc::now();

    let row_count = normalise_rows(&mut data, now.to_rfc3339());
    update_schema_metadata(&mut schema, row_count, &now.to_rfc3339());

    write_with_backup(
        &data_path,
        serde_json::to_string_pretty(&data).map_err(|e| e.to_string())?,
    )?;
    write_with_backup(
        &schema_path,
        serde_json::to_string_pretty(&schema).map_err(|e| e.to_string())?,
    )?;

    Ok(SaveResult {
        row_count,
        updated_at: now.to_rfc3339(),
    })
}

#[tauri::command]
async fn fetch_workspace(state: State<'_, AppState>) -> Result<TablePayload, String> {
    let (data_path, schema_path) = state.paths()?;
    build_table_payload(&data_path, &schema_path)
}

#[tauri::command]
async fn create_workspace(
    app_handle: AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> Result<TablePayload, String> {
    let mut data_path = PathBuf::from(path.trim());
    if data_path.to_string_lossy().trim().is_empty() {
        return Err("ファイルパスを指定してください".into());
    }

    if data_path.extension().and_then(|ext| ext.to_str()) != Some("json") {
        data_path.set_extension("json");
    }

    let stem = data_path
        .file_stem()
        .and_then(|s| s.to_str())
        .ok_or_else(|| "ファイル名を取得できません".to_string())?
        .trim();

    if stem.is_empty() {
        return Err("ファイル名を入力してください".into());
    }

    let schema_path = data_path
        .parent()
        .ok_or_else(|| "保存先フォルダを取得できません".to_string())?
        .join(format!("{stem}.schema.json"));

    if let Some(parent) = data_path.parent() {
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }

    if data_path.exists() || schema_path.exists() {
        return Err("同名のファイルが既に存在します".into());
    }

    ensure_data_files(&data_path, &schema_path)?;
    state.set_workspace(&app_handle, data_path.clone())?;
    build_table_payload(&data_path, &schema_path)
}

fn normalise_rows(rows: &mut [Value], timestamp: String) -> usize {
    rows.iter_mut().enumerate().for_each(|(index, row)| {
        if let Value::Object(ref mut obj) = row {
            let id_entry = obj.entry("_id".to_string());
            if matches!(id_entry, serde_json::map::Entry::Vacant(_)) {
                let id = nanoid::nanoid!(10);
                obj.insert("_id".into(), Value::String(format!("row_{id}")));
            }

            if !obj.contains_key("_created") {
                obj.insert("_created".into(), Value::String(timestamp.clone()));
            }
            obj.insert("_updated".into(), Value::String(timestamp.clone()));

            if !obj.contains_key("_order") {
                obj.insert(
                    "_order".into(),
                    Value::Number(serde_json::Number::from(index as u64)),
                );
            } else if let Some(order_value) = obj.get_mut("_order") {
                if let Value::Number(_) = order_value {
                    // keep user-defined number
                } else {
                    *order_value = Value::Number(serde_json::Number::from(index as u64));
                }
            }
        }
    });

    rows.len()
}

fn update_schema_metadata(schema: &mut Value, row_count: usize, updated_at: &str) {
    if let Some(metadata) = schema
        .get_mut("metadata")
        .and_then(|value| value.as_object_mut())
    {
        metadata.insert("row_count".into(), json!(row_count));
        metadata.insert("updated_at".into(), json!(updated_at));
    } else {
        schema.as_object_mut().map(|object| {
            object.insert(
                "metadata".into(),
                json!({
                    "row_count": row_count,
                    "updated_at": updated_at,
                }),
            );
        });
    }
}

fn write_with_backup(path: &Path, contents: String) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }

    if path.exists() {
        let backup_path = path.with_extension("json.bak");
        fs::copy(path, &backup_path).map_err(|err| err.to_string())?;
    }

    let tmp_path = path.with_extension("json.tmp");
    let mut file = File::create(&tmp_path).map_err(|err| err.to_string())?;
    file.write_all(contents.as_bytes())
        .map_err(|err| err.to_string())?;
    file.flush().map_err(|err| err.to_string())?;

    fs::rename(&tmp_path, path).map_err(|err| err.to_string())
}

fn ensure_data_files(data_path: &Path, schema_path: &Path) -> Result<(), String> {
    if let Some(parent) = data_path.parent() {
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }

    if !data_path.exists() {
        fs::write(data_path, "[]").map_err(|err| err.to_string())?;
    }

    if !schema_path.exists() {
        let now = Utc::now().to_rfc3339();
        let default_schema = json!({
            "version": "1.0",
            "table_name": data_path
                .file_stem()
                .and_then(|stem| stem.to_str())
                .unwrap_or("Untitled"),
            "columns": [
                { "id": "_id", "name": "ID", "type": "text", "hidden": true, "system": true },
            ],
            "metadata": {
                "created_at": now,
                "updated_at": now,
                "row_count": 0
            },
            "extensions": {
                "available_types": ["text", "number", "checkbox", "multiselect", "relation"],
                "future": "拡張型を追加できる設計とする"
            }
        });
        fs::write(
            schema_path,
            serde_json::to_string_pretty(&default_schema).map_err(|err| err.to_string())?,
        )
        .map_err(|err| err.to_string())?;
    }

    Ok(())
}

fn read_data_file(path: &Path) -> Result<Vec<Value>, String> {
    let contents = fs::read_to_string(path).map_err(|err| err.to_string())?;
    let value: Value = serde_json::from_str(&contents).map_err(|err| err.to_string())?;
    match value {
        Value::Array(array) => Ok(array),
        _ => Err("データファイルの形式が正しくありません".to_string()),
    }
}

fn read_schema_file(path: &Path) -> Result<Value, String> {
    let contents = fs::read_to_string(path).map_err(|err| err.to_string())?;
    serde_json::from_str(&contents).map_err(|err| err.to_string())
}

fn schema_path_for(data_path: &Path) -> Result<PathBuf, String> {
    let stem = data_path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .ok_or_else(|| "データファイル名を取得できません".to_string())?;

    let parent = data_path
        .parent()
        .ok_or_else(|| "親ディレクトリを取得できません".to_string())?;

    Ok(parent.join(format!("{stem}.schema.json")))
}

fn build_table_payload(data_path: &Path, schema_path: &Path) -> Result<TablePayload, String> {
    let data = read_data_file(data_path)?;
    let schema = read_schema_file(schema_path)?;

    let workspace = WorkspaceInfo {
        data_path: data_path.to_string_lossy().into_owned(),
        schema_path: schema_path.to_string_lossy().into_owned(),
        folder: data_path
            .parent()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default(),
    };

    Ok(TablePayload {
        data,
        schema,
        workspace,
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState::default())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            load_table,
            save_table,
            fetch_workspace,
            create_workspace
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
