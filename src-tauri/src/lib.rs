// 標準ライブラリからファイルシステムとI/O操作に必要なモジュールをインポート
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

// 外部クレート
use chrono::Utc;
use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, State};

// ファイル変更イベントの名前
const FILE_CHANGED_EVENT: &str = "workspace:file-changed";
// ファイル監視エラーイベントの名前
const WATCH_ERROR_EVENT: &str = "workspace:watch-error";

/// アプリケーション全体の状態を管理する構造体
/// 複数のスレッドから安全にアクセスできるようにMutexで保護されている
#[derive(Default)]
struct AppState {
    workspace: Mutex<Option<WorkspaceState>>,
}

/// ワークスペースの状態を保持する構造体
/// データファイルとスキーマファイルのパス、およびファイル監視機能を含む
struct WorkspaceState {
    /// データファイル(.json)のパス
    data_path: PathBuf,
    /// スキーマファイル(.schema.json)のパス
    schema_path: PathBuf,
    /// ファイル変更を監視するウォッチャー
    watcher: Option<RecommendedWatcher>,
}

impl WorkspaceState {
    /// 新しいWorkspaceStateインスタンスを作成する
    ///
    /// # 引数
    /// * `data_path` - データファイルのパス
    /// * `schema_path` - スキーマファイルのパス
    fn new(data_path: PathBuf, schema_path: PathBuf) -> Self {
        Self {
            data_path,
            schema_path,
            watcher: None,
        }
    }

    /// ファイル監視を開始する
    /// データファイルとスキーマファイルの変更を監視し、変更があればフロントエンドにイベントを送信する
    ///
    /// # 引数
    /// * `app_handle` - Tauriアプリケーションハンドル（イベント送信に使用）
    ///
    /// # 戻り値
    /// 成功時は`Ok(())`、失敗時はエラーメッセージを含む`Err(String)`
    fn start_watcher(&mut self, app_handle: AppHandle) -> Result<(), String> {
        // Arc（原子参照カウント）でパスを共有可能にする（クロージャ内で使用するため）
        let data_path = Arc::new(self.data_path.clone());
        let schema_path = Arc::new(self.schema_path.clone());
        let data_path_str = Arc::new(data_path.to_string_lossy().into_owned());
        let schema_path_str = Arc::new(schema_path.to_string_lossy().into_owned());
        let handle = app_handle.clone();

        // ファイル監視ウォッチャーを作成し、イベントハンドラを設定
        let mut watcher = notify::recommended_watcher({
            let data_path = Arc::clone(&data_path);
            let schema_path = Arc::clone(&schema_path);
            let data_path_str = Arc::clone(&data_path_str);
            let schema_path_str = Arc::clone(&schema_path_str);
            move |res: Result<Event, notify::Error>| match res {
                Ok(event) => {
                    // 変更、作成、削除イベントのみを処理
                    if !matches!(
                        event.kind,
                        EventKind::Modify(_) | EventKind::Create(_) | EventKind::Remove(_)
                    ) {
                        return;
                    }

                    // 監視対象のファイルが変更されたかチェック
                    let relevant = event
                        .paths
                        .iter()
                        .any(|path| path == &*data_path || path == &*schema_path);

                    if relevant {
                        // フロントエンドにファイル変更イベントを送信
                        let payload = WorkspaceChangePayload {
                            data_path: data_path_str.as_ref().clone(),
                            schema_path: schema_path_str.as_ref().clone(),
                        };
                        let _ = handle.emit(FILE_CHANGED_EVENT, payload);
                    }
                }
                Err(error) => {
                    // エラーが発生した場合、フロントエンドにエラーイベントを送信
                    let payload = WatchErrorPayload {
                        message: error.to_string(),
                    };
                    let _ = handle.emit(WATCH_ERROR_EVENT, payload);
                }
            }
        })
        .map_err(|err| err.to_string())?;

        // ウォッチャーの設定：ファイル内容の比較を有効化し、1秒間隔でポーリング
        watcher
            .configure(
                Config::default()
                    .with_compare_contents(true)
                    .with_poll_interval(Duration::from_secs(1)),
            )
            .map_err(|err| err.to_string())?;

        // データファイルとスキーマファイルの監視を開始
        watcher
            .watch(&*data_path, RecursiveMode::NonRecursive)
            .map_err(|err| err.to_string())?;
        watcher
            .watch(&*schema_path, RecursiveMode::NonRecursive)
            .map_err(|err| err.to_string())?;

        self.watcher = Some(watcher);
        Ok(())
    }

    /// ファイル監視を停止する
    fn stop(&mut self) {
        if let Some(watcher) = self.watcher.as_mut() {
            let _ = watcher.unwatch(&self.data_path);
            let _ = watcher.unwatch(&self.schema_path);
        }
        self.watcher = None;
    }
}

impl AppState {
    /// ワークスペースを設定し、ファイル監視を開始する
    ///
    /// # 引数
    /// * `app_handle` - Tauriアプリケーションハンドル
    /// * `data_path` - データファイルのパス
    ///
    /// # 戻り値
    /// 成功時はスキーマファイルのパス、失敗時はエラーメッセージ
    fn set_workspace(&self, app_handle: &AppHandle, data_path: PathBuf) -> Result<PathBuf, String> {
        let schema_path = schema_path_for(&data_path)?;
        ensure_data_files(&data_path, &schema_path)?;

        // 既存のワークスペースがあれば監視を停止
        let mut guard = self.workspace.lock();
        if let Some(existing) = guard.as_mut() {
            existing.stop();
        }

        // 新しいワークスペースを作成し、監視を開始
        let mut workspace = WorkspaceState::new(data_path.clone(), schema_path.clone());
        workspace.start_watcher(app_handle.clone())?;
        *guard = Some(workspace);

        Ok(schema_path)
    }

    /// 現在のワークスペースのデータファイルとスキーマファイルのパスを取得する
    ///
    /// # 戻り値
    /// 成功時は(データパス, スキーマパス)のタプル、ワークスペースが読み込まれていない場合はエラー
    fn paths(&self) -> Result<(PathBuf, PathBuf), String> {
        self.workspace
            .lock()
            .as_ref()
            .map(|workspace| (workspace.data_path.clone(), workspace.schema_path.clone()))
            .ok_or_else(|| "Workspace not loaded".to_string())
    }
}

/// ワークスペース情報を表す構造体（フロントエンドに送信）
#[derive(Serialize)]
struct WorkspaceInfo {
    data_path: String,
    schema_path: String,
    folder: String,
}

/// テーブルデータとスキーマをまとめたペイロード（フロントエンドに送信）
#[derive(Serialize)]
struct TablePayload {
    data: Vec<Value>,
    schema: Value,
    workspace: WorkspaceInfo,
}

/// ワークスペースファイル変更イベントのペイロード
#[derive(Serialize, Clone)]
struct WorkspaceChangePayload {
    data_path: String,
    schema_path: String,
}

/// ファイル監視エラーイベントのペイロード
#[derive(Serialize, Clone)]
struct WatchErrorPayload {
    message: String,
}

/// フロントエンドから保存リクエストを受け取るペイロード
#[derive(Deserialize)]
struct SavePayload {
    data: Vec<Value>,
    schema: Value,
}

/// 保存結果をフロントエンドに返すペイロード
#[derive(Serialize)]
struct SaveResult {
    row_count: usize,
    updated_at: String,
}

/// テーブルデータを読み込むTauriコマンド
///
/// # 引数
/// * `app_handle` - Tauriアプリケーションハンドル
/// * `state` - アプリケーション状態
/// * `data_path` - 読み込むデータファイルのパス
///
/// # 戻り値
/// 成功時はTablePayload、失敗時はエラーメッセージ
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

/// テーブルデータを保存するTauriコマンド
///
/// # 引数
/// * `state` - アプリケーション状態
/// * `payload` - 保存するデータとスキーマ
///
/// # 戻り値
/// 成功時は保存結果、失敗時はエラーメッセージ
#[tauri::command]
async fn save_table(
    state: State<'_, AppState>,
    payload: SavePayload,
) -> Result<SaveResult, String> {
    let (data_path, schema_path) = state.paths()?;
    let (mut data, mut schema) = (payload.data, payload.schema);
    let now = Utc::now();

    // 行データの正規化（ID、タイムスタンプ、順序の更新）
    let row_count = normalise_rows(&mut data, now.to_rfc3339());
    // スキーマメタデータの更新
    update_schema_metadata(&mut schema, row_count, &now.to_rfc3339());

    // バックアップを作成してからファイルに書き込む
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

/// 現在のワークスペースのデータを再読み込みするTauriコマンド
///
/// # 引数
/// * `state` - アプリケーション状態
///
/// # 戻り値
/// 成功時はTablePayload、失敗時はエラーメッセージ
#[tauri::command]
async fn fetch_workspace(state: State<'_, AppState>) -> Result<TablePayload, String> {
    let (data_path, schema_path) = state.paths()?;
    build_table_payload(&data_path, &schema_path)
}

/// 新しいワークスペースを作成するTauriコマンド
///
/// # 引数
/// * `app_handle` - Tauriアプリケーションハンドル
/// * `state` - アプリケーション状態
/// * `path` - 新しいデータファイルのパス
///
/// # 戻り値
/// 成功時はTablePayload、失敗時はエラーメッセージ
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

    // .json拡張子がない場合は追加
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

    // スキーマファイルのパスを生成（data.json → data.schema.json）
    let schema_path = data_path
        .parent()
        .ok_or_else(|| "保存先フォルダを取得できません".to_string())?
        .join(format!("{stem}.schema.json"));

    // 親ディレクトリが存在しない場合は作成
    if let Some(parent) = data_path.parent() {
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }

    // ファイルが既に存在する場合はエラー
    if data_path.exists() || schema_path.exists() {
        return Err("同名のファイルが既に存在します".into());
    }

    // 空のデータファイルとデフォルトスキーマを作成
    ensure_data_files(&data_path, &schema_path)?;
    state.set_workspace(&app_handle, data_path.clone())?;
    build_table_payload(&data_path, &schema_path)
}

/// 行データを正規化する（ID、タイムスタンプ、順序の追加・更新）
///
/// # 引数
/// * `rows` - 正規化する行データの可変参照
/// * `timestamp` - 更新タイムスタンプ
///
/// # 戻り値
/// 行数
fn normalise_rows(rows: &mut [Value], timestamp: String) -> usize {
    rows.iter_mut().enumerate().for_each(|(index, row)| {
        if let Value::Object(ref mut obj) = row {
            // _idが存在しない場合は生成して追加
            let id_entry = obj.entry("_id".to_string());
            if matches!(id_entry, serde_json::map::Entry::Vacant(_)) {
                let id = nanoid::nanoid!(10);
                obj.insert("_id".into(), Value::String(format!("row_{id}")));
            }

            // _createdが存在しない場合のみ追加（作成日時は不変）
            if !obj.contains_key("_created") {
                obj.insert("_created".into(), Value::String(timestamp.clone()));
            }
            // _updatedは常に最新のタイムスタンプで更新
            obj.insert("_updated".into(), Value::String(timestamp.clone()));

            // _orderが存在しない場合は追加、または無効な値の場合は修正
            if !obj.contains_key("_order") {
                obj.insert(
                    "_order".into(),
                    Value::Number(serde_json::Number::from(index as u64)),
                );
            } else if let Some(order_value) = obj.get_mut("_order") {
                if let Value::Number(_) = order_value {
                    // ユーザー定義の数値をそのまま保持
                } else {
                    *order_value = Value::Number(serde_json::Number::from(index as u64));
                }
            }
        }
    });

    rows.len()
}

/// スキーマのメタデータを更新する
///
/// # 引数
/// * `schema` - 更新するスキーマの可変参照
/// * `row_count` - 行数
/// * `updated_at` - 更新日時
fn update_schema_metadata(schema: &mut Value, row_count: usize, updated_at: &str) {
    // metadataが存在する場合は更新
    if let Some(metadata) = schema
        .get_mut("metadata")
        .and_then(|value| value.as_object_mut())
    {
        metadata.insert("row_count".into(), json!(row_count));
        metadata.insert("updated_at".into(), json!(updated_at));
    } else {
        // metadataが存在しない場合は新規作成
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

/// ファイルをバックアップしてから書き込む
/// 既存ファイルは.bakとして保存され、一時ファイル経由で安全に書き込まれる
///
/// # 引数
/// * `path` - 書き込み先のファイルパス
/// * `contents` - 書き込む内容
///
/// # 戻り値
/// 成功時は`Ok(())`、失敗時はエラーメッセージ
fn write_with_backup(path: &Path, contents: String) -> Result<(), String> {
    // 親ディレクトリが存在しない場合は作成
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }

    // 既存ファイルがあればバックアップを作成
    if path.exists() {
        let backup_path = path.with_extension("json.bak");
        fs::copy(path, &backup_path).map_err(|err| err.to_string())?;
    }

    // 一時ファイルに書き込んでからリネーム（アトミック操作）
    let tmp_path = path.with_extension("json.tmp");
    let mut file = File::create(&tmp_path).map_err(|err| err.to_string())?;
    file.write_all(contents.as_bytes())
        .map_err(|err| err.to_string())?;
    file.flush().map_err(|err| err.to_string())?;

    fs::rename(&tmp_path, path).map_err(|err| err.to_string())
}

/// データファイルとスキーマファイルが存在することを保証する
/// 存在しない場合は空のデータファイルとデフォルトスキーマを作成
///
/// # 引数
/// * `data_path` - データファイルのパス
/// * `schema_path` - スキーマファイルのパス
///
/// # 戻り値
/// 成功時は`Ok(())`、失敗時はエラーメッセージ
fn ensure_data_files(data_path: &Path, schema_path: &Path) -> Result<(), String> {
    // 親ディレクトリが存在しない場合は作成
    if let Some(parent) = data_path.parent() {
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }

    // データファイルが存在しない場合は空の配列を作成
    if !data_path.exists() {
        fs::write(data_path, "[]").map_err(|err| err.to_string())?;
    }

    // スキーマファイルが存在しない場合はデフォルトスキーマを作成
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

/// データファイルを読み込む
///
/// # 引数
/// * `path` - データファイルのパス
///
/// # 戻り値
/// 成功時はJSON配列、失敗時はエラーメッセージ
fn read_data_file(path: &Path) -> Result<Vec<Value>, String> {
    let contents = fs::read_to_string(path).map_err(|err| err.to_string())?;
    let value: Value = serde_json::from_str(&contents).map_err(|err| err.to_string())?;
    match value {
        Value::Array(array) => Ok(array),
        _ => Err("データファイルの形式が正しくありません".to_string()),
    }
}

/// スキーマファイルを読み込む
///
/// # 引数
/// * `path` - スキーマファイルのパス
///
/// # 戻り値
/// 成功時はJSONオブジェクト、失敗時はエラーメッセージ
fn read_schema_file(path: &Path) -> Result<Value, String> {
    let contents = fs::read_to_string(path).map_err(|err| err.to_string())?;
    serde_json::from_str(&contents).map_err(|err| err.to_string())
}

/// データファイルパスからスキーマファイルパスを生成する
/// 例: data.json → data.schema.json
///
/// # 引数
/// * `data_path` - データファイルのパス
///
/// # 戻り値
/// 成功時はスキーマファイルのパス、失敗時はエラーメッセージ
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

/// テーブルペイロードを構築する
/// データとスキーマを読み込み、ワークスペース情報と共にまとめる
///
/// # 引数
/// * `data_path` - データファイルのパス
/// * `schema_path` - スキーマファイルのパス
///
/// # 戻り値
/// 成功時はTablePayload、失敗時はエラーメッセージ
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

/// Tauriアプリケーションのエントリーポイント
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
