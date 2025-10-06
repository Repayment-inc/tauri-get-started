// Reactと必要なフックをインポート
import type { JSX } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
// Tauri APIをインポート（バックエンドとの通信用）
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
// ドラッグ&ドロップライブラリをインポート
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

import type { UnlistenFn } from "@tauri-apps/api/event";

// カラムのデータ型
type ColumnType = "text" | "number" | "checkbox" | "multiselect" | "relation";

// テーブルの1行を表す型（キーは列ID、値は任意の型）
type TableRow = Record<string, unknown>;

/** カラム定義を表すインターフェース */
interface ColumnDefinition {
  id: string;           // カラムの一意なID
  name: string;         // 表示名
  type: ColumnType;     // データ型
  width?: number;       // 列の幅（ピクセル）
  required?: boolean;   // 必須かどうか
  hidden?: boolean;     // 非表示かどうか
  system?: boolean;     // システム列かどうか（_id, _created等）
  format?: string;      // フォーマット指定（将来の拡張用）
}

/** テーブルスキーマを表すインターフェース */
interface TableSchema {
  version?: string;                     // スキーマバージョン
  table_name?: string;                  // テーブル名
  columns: ColumnDefinition[];          // カラム定義の配列
  metadata?: Record<string, unknown>;   // メタデータ（行数、更新日時等）
  extensions?: Record<string, unknown>; // 拡張情報
}

/** バックエンドから受け取るワークスペース情報 */
interface WorkspaceInfoPayload {
  data_path: string;
  schema_path: string;
  folder: string;
}

/** バックエンドから受け取るテーブルデータのペイロード */
interface TablePayload {
  data: TableRow[];
  schema: TableSchema;
  workspace: WorkspaceInfoPayload;
}

/** フロントエンドで管理するワークスペース情報 */
interface WorkspaceInfo {
  dataPath: string;
  schemaPath: string;
  folder: string;
}

/** 保存結果を表すインターフェース */
interface SaveResult {
  row_count: number;
  updated_at: string;
}

/** 外部変更検出時の競合状態を表すインターフェース */
interface ConflictState {
  snapshot: TablePayload;  // 外部で変更された最新のデータ
  detectedAt: string;      // 変更を検出した日時
}

// ローカルで使用可能なカラムタイプ（将来的に拡張可能）
const LOCAL_COLUMN_TYPES: ColumnType[] = ["text", "number", "checkbox"];

// システム列のプレフィックス（_id, _created, _updated等）
const SYSTEM_COLUMN_PREFIX = "_";

/**
 * カラム名から一意なIDを生成する
 * @param name カラム名
 * @param existingIds 既存のID一覧
 * @returns 一意なカラムID
 */
function toColumnId(name: string, existingIds: string[]): string {
  // 名前を小文字に変換し、英数字以外をアンダースコアに置換
  const base = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  let candidate = base || `col_${Date.now()}`;
  let counter = 1;
  // 重複がなくなるまでサフィックスを追加
  while (existingIds.includes(candidate)) {
    candidate = `${base}_${counter}`;
    counter += 1;
  }
  return candidate;
}

/**
 * 空の行を作成する
 * @param columns カラム定義の配列
 * @param order 行の順序
 * @returns 新しい空の行
 */
function createEmptyRow(columns: ColumnDefinition[], order: number): TableRow {
  const now = new Date().toISOString();
  // システム列を初期化
  const row: TableRow = {
    _id: `row_${crypto.randomUUID().slice(0, 8)}`,
    _created: now,
    _updated: now,
    _order: order,
  };

  // 各カラムにデフォルト値を設定
  columns.forEach((column) => {
    // システム列はスキップ
    if (column.id.startsWith(SYSTEM_COLUMN_PREFIX)) {
      return;
    }
    if (row[column.id] !== undefined) {
      return;
    }

    // カラムのタイプに応じたデフォルト値を設定
    switch (column.type) {
      case "number":
        row[column.id] = 0;
        break;
      case "checkbox":
        row[column.id] = false;
        break;
      default:
        row[column.id] = "";
    }
  });

  return row;
}

/**
 * 配列内のアイテムを移動する
 * @param items 配列
 * @param fromIndex 移動元のインデックス
 * @param toIndex 移動先のインデックス
 * @returns 移動後の新しい配列
 */
function moveItem<T>(items: T[], fromIndex: number, toIndex: number): T[] {
  if (fromIndex === toIndex) return items;
  const next = [...items];
  const [moved] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, moved);
  return next;
}

/**
 * 文字列を数値に正規化する
 * @param value 入力文字列
 * @returns 数値（パース失敗時は0）
 */
function normaliseNumber(value: string): number {
  if (value.trim() === "") {
    return 0;
  }
  const parsed = Number(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * システム列かどうかを判定する
 * @param column カラム定義
 * @returns システム列の場合true
 */
function isSystemColumn(column: ColumnDefinition): boolean {
  return column.system ?? column.id.startsWith(SYSTEM_COLUMN_PREFIX);
}

/**
 * 行データの配列をディープコピーする
 * @param rows 行データの配列
 * @returns コピーされた配列
 */
function cloneRows(rows: TableRow[]): TableRow[] {
  return rows.map((row) => ({ ...row }));
}

/**
 * メインアプリケーションコンポーネント
 * テーブルエディタのUI全体を管理
 */
export default function App(): JSX.Element {
  // ========== State管理 ==========
  const [rows, setRows] = useState<TableRow[]>([]);                      // テーブルの行データ
  const [schema, setSchema] = useState<TableSchema | null>(null);         // テーブルスキーマ
  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null); // ワークスペース情報
  const [statusMessage, setStatusMessage] = useState<string>("ワークスペースを選択してください");
  const [isSaving, setIsSaving] = useState(false);                        // 保存中フラグ
  const [isLoading, setIsLoading] = useState(false);                      // 読み込み中フラグ
  const [dirty, setDirty] = useState(false);                              // 未保存の変更があるか
  const [conflict, setConflict] = useState<ConflictState | null>(null);   // 外部変更の競合状態
  const [errorMessage, setErrorMessage] = useState<string | null>(null);  // エラーメッセージ
  const [columnDialog, setColumnDialog] = useState<{
    open: boolean;
    name: string;
    type: ColumnType;
  }>({ open: false, name: "", type: "text" });                            // カラム追加ダイアログの状態

  // ========== Ref管理 ==========
  const saveTimerRef = useRef<number | null>(null);                       // 自動保存タイマー
  const latestPayloadRef = useRef<{ rows: TableRow[]; schema: TableSchema } | null>(null); // 最新の保存予定データ
  const ignoreEventsUntilRef = useRef<number>(0);                         // ファイル変更イベントを無視する期限
  const suspendAutoSaveRef = useRef<boolean>(false);                      // 自動保存を一時停止するフラグ
  const unlistenRef = useRef<Promise<UnlistenFn> | null>(null);           // イベントリスナーの解除関数
  const draggedColumnIdRef = useRef<string | null>(null);                 // ドラッグ中のカラムID

  // ユーザーに表示するカラム（非表示カラムを除外）
  const userColumns = useMemo(() => {
    if (!schema) return [] as ColumnDefinition[];
    return schema.columns.filter((column) => !column.hidden);
  }, [schema]);

  // ドラッグ&ドロップのセンサー設定（8pxの移動で反応）
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8,
      },
    })
  );

  /**
   * データを保存する処理
   * バックエンドのsave_tableコマンドを呼び出す
   */
  const performSave = useCallback(async () => {
    if (!latestPayloadRef.current || !schema) return;
    if (!workspace) return;

    const payload = latestPayloadRef.current;
    // 既存のタイマーをクリア
    if (saveTimerRef.current) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    setIsSaving(true);
    setStatusMessage("保存中…");
    setErrorMessage(null);
    // 保存後2秒間はファイル変更イベントを無視（自分の変更を検出しないため）
    ignoreEventsUntilRef.current = Date.now() + 2000;

    try {
      const result = await invoke<SaveResult>("save_table", {
        payload: {
          data: payload.rows,
          schema: payload.schema,
        },
      });
      setDirty(false);
      setStatusMessage(`保存完了 (${new Date(result.updated_at).toLocaleTimeString()})`);
      // 保存成功したデータを記録
      latestPayloadRef.current = {
        rows: cloneRows(payload.rows),
        schema: { ...payload.schema },
      };
    } catch (error) {
      console.error(error);
      const message =
        error instanceof Error
          ? error.message
          : typeof error === "string"
          ? error
          : JSON.stringify(error);
      setErrorMessage(`保存中にエラーが発生しました: ${message}`);
      setStatusMessage(`保存失敗 (${message})`);
    } finally {
      setIsSaving(false);
    }
  }, [schema, workspace]);

  /**
   * 保存をスケジュールする（1秒後に自動保存）
   * @param nextRows 次の行データ
   * @param nextSchema 次のスキーマ
   */
  const scheduleSave = useCallback(
    (nextRows: TableRow[], nextSchema: TableSchema) => {
      // 自動保存が停止されている場合はデータのみ保存
      if (suspendAutoSaveRef.current) {
        latestPayloadRef.current = { rows: cloneRows(nextRows), schema: { ...nextSchema } };
        return;
      }

      latestPayloadRef.current = { rows: cloneRows(nextRows), schema: { ...nextSchema } };
      setDirty(true);
      setStatusMessage("編集中…");
      // 既存のタイマーをクリアして新しくスケジュール
      if (saveTimerRef.current) {
        window.clearTimeout(saveTimerRef.current);
      }
      saveTimerRef.current = window.setTimeout(() => {
        void performSave();
      }, 1000);
    },
    [performSave]
  );

  /**
   * 保留中の保存を即座に実行する
   */
  const flushPendingSave = useCallback(async () => {
    if (!dirty) return;
    await performSave();
  }, [dirty, performSave]);

  /**
   * 行のドラッグ&ドロップ終了時の処理
   * @param event ドラッグイベント
   */
  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;

      if (!over || !schema) return;
      if (active.id === over.id) return;

      const oldIndex = rows.findIndex((row) => row._id === active.id);
      const newIndex = rows.findIndex((row) => row._id === over.id);

      if (oldIndex === -1 || newIndex === -1) return;

      const reordered = arrayMove(rows, oldIndex, newIndex).map((row, index) => ({
        ...row,
        _order: index,
        _updated: new Date().toISOString(),
      }));

      setRows(reordered);
      scheduleSave(reordered, schema);
    },
    [rows, schema, scheduleSave]
  );

  /**
   * スナップショット（外部データ）を現在の状態に適用する
   * @param snapshot テーブルペイロード
   */
  const applySnapshot = useCallback((snapshot: TablePayload) => {
    // 自動保存を一時停止してデータを反映
    suspendAutoSaveRef.current = true;
    setRows(cloneRows(snapshot.data));
    setSchema({ ...snapshot.schema });
    setWorkspace({
      dataPath: snapshot.workspace.data_path,
      schemaPath: snapshot.workspace.schema_path,
      folder: snapshot.workspace.folder,
    });
    latestPayloadRef.current = {
      rows: cloneRows(snapshot.data),
      schema: { ...snapshot.schema },
    };
    setDirty(false);
    setStatusMessage("最新の内容を読み込みました");
    setConflict(null);
    suspendAutoSaveRef.current = false;
  }, []);

  /**
   * ワークスペースを開く処理
   * ファイルダイアログを表示し、選択されたファイルを読み込む
   */
  const handleOpenWorkspace = useCallback(async () => {
    await flushPendingSave();

    const selected = await open({
      directory: false,
      multiple: false,
      filters: [{ name: "JSON", extensions: ["json"] }],
    });

    if (!selected || Array.isArray(selected)) {
      return;
    }

    setIsLoading(true);
    setStatusMessage("読み込み中…");
    setErrorMessage(null);

    try {
      const payload = await invoke<TablePayload>("load_table", { dataPath: selected });
      applySnapshot(payload);
    } catch (error) {
      console.error(error);
      const message =
        error instanceof Error
          ? error.message
          : typeof error === "string"
          ? error
          : JSON.stringify(error);
      setErrorMessage(`ワークスペースの読み込みに失敗しました: ${message}`);
      setStatusMessage(`読み込み失敗 (${message})`);
    } finally {
      setIsLoading(false);
    }
  }, [applySnapshot, flushPendingSave]);

  /**
   * 新しいワークスペースを作成する処理
   * ファイル保存ダイアログを表示し、新しいテーブルを作成
   */
  const handleCreateWorkspace = useCallback(async () => {
    await flushPendingSave();

    // タイムスタンプを使ったデフォルトファイル名を生成
    const timestamp = new Date().toISOString().replace(/[:T.-]/g, "").slice(0, 14);
    const suggestedName = `table_${timestamp}.json`;

    const targetPath = await save({
      defaultPath: suggestedName,
      filters: [{ name: "JSON", extensions: ["json"] }],
    });

    if (!targetPath) {
      return;
    }

    setIsLoading(true);
    setStatusMessage("テーブルを作成中…");
    setErrorMessage(null);

    try {
      const payload = await invoke<TablePayload>("create_workspace", {
        path: targetPath,
      });
      applySnapshot(payload);
      setStatusMessage("新しいテーブルを読み込みました");
    } catch (error) {
      console.error(error);
      const message =
        error instanceof Error
          ? error.message
          : typeof error === "string"
          ? error
          : JSON.stringify(error);
      setErrorMessage(`テーブルの作成に失敗しました: ${message}`);
      setStatusMessage(`作成失敗 (${message})`);
    } finally {
      setIsLoading(false);
    }
  }, [applySnapshot, flushPendingSave]);

  /**
   * ワークスペースのファイル変更イベントリスナーを登録
   * バックエンドからのファイル変更通知を受け取る
   */
  const registerWorkspaceListeners = useCallback(() => {
    if (unlistenRef.current) {
      unlistenRef.current.then((unlisten) => unlisten());
    }

    unlistenRef.current = listen<WorkspaceChangePayload>("workspace:file-changed", async () => {
      if (!workspace) return;
      if (Date.now() < ignoreEventsUntilRef.current) return;

      try {
        const snapshot = await invoke<TablePayload>("fetch_workspace");
        setConflict({ snapshot, detectedAt: new Date().toISOString() });
        setStatusMessage("外部変更を検出しました");
      } catch (error) {
        console.error(error);
      }
    });
  }, [workspace]);

  useEffect(() => {
    registerWorkspaceListeners();
    return () => {
      if (unlistenRef.current) {
        unlistenRef.current.then((unlisten) => unlisten());
      }
      void flushPendingSave();
    };
  }, [registerWorkspaceListeners, flushPendingSave]);

  /**
   * 新しい行を追加する
   */
  const handleAddRow = useCallback(() => {
    if (!schema) return;
    const nextRows = [...rows, createEmptyRow(schema.columns, rows.length)];
    setRows(nextRows);
    scheduleSave(nextRows, schema);
  }, [rows, schema, scheduleSave]);

  /**
   * 指定した行を削除する
   * @param rowId 削除する行のID
   */
  const handleDeleteRow = useCallback(
    (rowId: string) => {
      if (!schema) return;
      const nextRows = rows.filter((row) => row._id !== rowId);
      setRows(nextRows);
      scheduleSave(nextRows, schema);
    },
    [rows, schema, scheduleSave]
  );

  /**
   * カラムを追加する内部関数
   * @param name カラム名
   * @param type カラムのデータ型
   */
  const addColumn = useCallback(
    (name: string, type: ColumnType) => {
      if (!schema) return;
      const columnId = toColumnId(name, schema.columns.map((column) => column.id));
      const newColumn: ColumnDefinition = {
        id: columnId,
        name,
        type,
        width: 160,
      };

      const nextSchema: TableSchema = {
        ...schema,
        columns: [...schema.columns, newColumn],
      };

      const nextRows = rows.map((row, index) => {
        if (row[columnId] !== undefined) return row;
        const updated: TableRow = { ...row };
        switch (newColumn.type) {
          case "number":
            updated[columnId] = 0;
            break;
          case "checkbox":
            updated[columnId] = false;
            break;
          default:
            updated[columnId] = "";
        }
        updated._order = index;
        return updated;
      });

      setSchema(nextSchema);
      setRows(nextRows);
      scheduleSave(nextRows, nextSchema);
    },
    [rows, schema, scheduleSave]
  );

  const handleAddColumn = useCallback(() => {
    if (!schema) return;
    const existingColumns = schema.columns.filter((column) => !isSystemColumn(column)).length;
    setColumnDialog({
      open: true,
      name: `Column ${existingColumns + 1}`,
      type: "text",
    });
  }, [schema]);

  const handleColumnDialogSubmit = useCallback(() => {
    if (!schema) {
      setColumnDialog({ open: false, name: "", type: "text" });
      return;
    }
    const trimmedName = columnDialog.name.trim() || `Column ${schema.columns.length}`;
    addColumn(trimmedName, columnDialog.type);
    setColumnDialog({ open: false, name: "", type: "text" });
  }, [addColumn, columnDialog.name, columnDialog.type, schema]);

  const handleColumnDialogCancel = useCallback(() => {
    setColumnDialog({ open: false, name: "", type: "text" });
  }, []);

  /**
   * カラムを削除する
   * @param columnId 削除するカラムのID
   */
  const handleDeleteColumn = useCallback(
    (columnId: string) => {
      if (!schema) return;
      const column = schema.columns.find((col) => col.id === columnId);
      if (!column) return;
      if (isSystemColumn(column)) {
        alert("システム列は削除できません");
        return;
      }

      if (!confirm(`列 "${column.name}" を削除しますか?`)) {
        return;
      }

      const nextSchema: TableSchema = {
        ...schema,
        columns: schema.columns.filter((col) => col.id !== columnId),
      };

      // 全行からそのカラムのデータを削除
      const nextRows = rows.map((row) => {
        if (!(columnId in row)) return row;
        const updated: TableRow = { ...row };
        delete updated[columnId];
        return updated;
      });

      setSchema(nextSchema);
      setRows(nextRows);
      scheduleSave(nextRows, nextSchema);
    },
    [rows, schema, scheduleSave]
  );

  /**
   * カラムのドロップ処理（カラムの並び替え）
   * @param targetColumnId ドロップ先のカラムID
   */
  const handleColumnDrop = useCallback(
    (targetColumnId: string) => {
      if (!schema) return;
      const sourceId = draggedColumnIdRef.current;
      draggedColumnIdRef.current = null;
      if (!sourceId || sourceId === targetColumnId) return;

      const fromIndex = schema.columns.findIndex((column) => column.id === sourceId);
      const toIndex = schema.columns.findIndex((column) => column.id === targetColumnId);
      if (fromIndex === -1 || toIndex === -1) return;

      const nextColumns = moveItem(schema.columns, fromIndex, toIndex);
      const nextSchema = { ...schema, columns: nextColumns };
      setSchema(nextSchema);
      scheduleSave(rows, nextSchema);
    },
    [rows, schema, scheduleSave]
  );

  /**
   * セルの値を更新する
   * @param rowId 行のID
   * @param column カラム定義
   * @param value 新しい値
   */
  const updateCell = useCallback(
    (rowId: string, column: ColumnDefinition, value: unknown) => {
      if (!schema) return;
      const nextRows = rows.map((row, index) => {
        if (row._id !== rowId) return row;
        const updated: TableRow = {
          ...row,
          _updated: new Date().toISOString(),
          _order: index,
        };
        updated[column.id] = value;
        return updated;
      });
      setRows(nextRows);
      scheduleSave(nextRows, schema);
    },
    [rows, schema, scheduleSave]
  );

  /**
   * 競合解決: 自分の変更を保持する
   */
  const handleResolveKeep = useCallback(async () => {
    await performSave();
    setConflict(null);
  }, [performSave]);

  /**
   * 競合解決: 外部の変更を読み込む
   */
  const handleResolveReload = useCallback(() => {
    if (!conflict) return;
    applySnapshot(conflict.snapshot);
  }, [conflict, applySnapshot]);

  return (
    <div className="app-shell">
      <header className="app-toolbar">
        <div className="toolbar-left">
          <button type="button" onClick={handleOpenWorkspace} disabled={isLoading}>
            ワークスペースを選択
          </button>
          <button type="button" onClick={handleCreateWorkspace} disabled={isLoading}>
            新規ワークスペース作成
          </button>
          <div className="workspace-info">
            {workspace ? (
              <>
                <span className="workspace-label">データ:</span>
                <span className="workspace-path">{workspace.dataPath}</span>
              </>
            ) : (
              <span>未選択</span>
            )}
          </div>
        </div>
        <div className="toolbar-right">
          <span className={`status-text ${isSaving ? "saving" : ""}`}>
            {statusMessage}
          </span>
          {dirty && <span className="dirty-indicator">● 未保存の変更</span>}
        </div>
      </header>

      {errorMessage && <div className="banner error">{errorMessage}</div>}
      {conflict && (
        <div className="banner warning">
          <div>
            <strong>外部変更を検出:</strong> {new Date(conflict.detectedAt).toLocaleTimeString()} 時点
          </div>
          <div className="conflict-actions">
            <button type="button" onClick={handleResolveReload}>
              外部の変更を読み込む
            </button>
            <button type="button" onClick={handleResolveKeep}>
              自分の変更を保存
            </button>
          </div>
        </div>
      )}

      <main className="app-main">
        {schema ? (
          <>
            <div className="table-actions">
              <button type="button" onClick={handleAddRow} disabled={isSaving}>
                + 行を追加
              </button>
              <button type="button" onClick={handleAddColumn} disabled={isSaving}>
                + 列を追加
              </button>
            </div>
            <div className="table-wrapper">
              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                onDragEnd={handleDragEnd}
              >
                <table>
                  <thead>
                    <tr>
                      <th className="row-handle-column" aria-label="行の並び替えハンドル" />
                      {userColumns.map((column) => (
                        <th
                          key={column.id}
                          style={column.width ? { width: `${column.width}px` } : undefined}
                          draggable
                          onDragStart={() => {
                            draggedColumnIdRef.current = column.id;
                          }}
                          onDragOver={(event) => event.preventDefault()}
                          onDrop={() => handleColumnDrop(column.id)}
                        >
                          <div className="column-header">
                            <span>{column.name}</span>
                            {!isSystemColumn(column) && (
                              <button
                                type="button"
                                className="icon-button"
                                onClick={() => handleDeleteColumn(column.id)}
                                title="列を削除"
                              >
                                ×
                              </button>
                            )}
                          </div>
                        </th>
                      ))}
                      <th className="actions-column">操作</th>
                    </tr>
                  </thead>
                  <SortableContext
                    items={rows.map((row) => row._id as string)}
                    strategy={verticalListSortingStrategy}
                  >
                    <tbody>
                      {rows.map((row) => (
                        <SortableRow
                          key={row._id as string}
                          row={row}
                          userColumns={userColumns}
                          onCellChange={updateCell}
                          onDelete={handleDeleteRow}
                        />
                      ))}
                    </tbody>
                  </SortableContext>
                </table>
              </DndContext>
            </div>
          </>
        ) : (
          <div className="empty-state">
            <p>ワークスペースを選択してテーブルを表示してください。</p>
          </div>
        )}
      </main>

      {columnDialog.open && (
        <div className="modal-backdrop">
          <div className="modal-card">
            <h2>新しい列を追加</h2>
            <label className="modal-label">
              列名
              <input
                type="text"
                value={columnDialog.name}
                onChange={(event) =>
                  setColumnDialog((prev) => ({ ...prev, name: event.target.value }))
                }
              />
            </label>
            <label className="modal-label">
              データ型
              <select
                value={columnDialog.type}
                onChange={(event) =>
                  setColumnDialog((prev) => ({
                    ...prev,
                    type: event.target.value as ColumnType,
                  }))
                }
              >
                {LOCAL_COLUMN_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {type}
                  </option>
                ))}
              </select>
            </label>
            <div className="modal-actions">
              <button type="button" onClick={handleColumnDialogCancel}>
                キャンセル
              </button>
              <button type="button" onClick={handleColumnDialogSubmit}>
                追加
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * SortableRowコンポーネントのプロパティ
 */
interface SortableRowProps {
  row: TableRow;
  userColumns: ColumnDefinition[];
  onCellChange: (rowId: string, column: ColumnDefinition, value: unknown) => void;
  onDelete: (rowId: string) => void;
}

/**
 * ドラッグ&ドロップ可能な行コンポーネント
 */
function SortableRow({ row, userColumns, onCellChange, onDelete }: SortableRowProps): JSX.Element {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: row._id as string,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <tr ref={setNodeRef} style={style}>
      <td className="row-handle-cell">
        <div className="drag-handle" {...attributes} {...listeners}>
          ⋮⋮
        </div>
      </td>
      {userColumns.map((column) => (
        <td key={`${row._id}_${column.id}`}>
          <EditableCell
            column={column}
            value={row[column.id]}
            onChange={(value) => onCellChange(row._id as string, column, value)}
          />
        </td>
      ))}
      <td className="actions-cell">
        <button type="button" onClick={() => onDelete(row._id as string)}>
          削除
        </button>
      </td>
    </tr>
  );
}

/**
 * EditableCellコンポーネントのプロパティ
 */
interface EditableCellProps {
  column: ColumnDefinition;
  value: unknown;
  onChange: (value: unknown) => void;
}

/**
 * 編集可能なセルコンポーネント
 * ダブルクリックで編集モードに入る
 */
function EditableCell({ column, value, onChange }: EditableCellProps): JSX.Element {
  const [draft, setDraft] = useState<string>(String(value ?? ""));
  const [isEditing, setIsEditing] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!isEditing) {
      setDraft(String(value ?? ""));
    }
  }, [value, isEditing]);

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  if (column.type === "checkbox") {
    const checked = Boolean(value);
    return (
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
    );
  }

  const commit = () => {
    setIsEditing(false);
    if (column.type === "number") {
      onChange(normaliseNumber(draft));
    } else {
      onChange(draft);
    }
  };

  const cancel = () => {
    setDraft(String(value ?? ""));
    setIsEditing(false);
  };

  return isEditing ? (
    <input
      ref={inputRef}
      type={column.type === "number" ? "number" : "text"}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          commit();
        }
        if (event.key === "Escape") {
          cancel();
        }
      }}
    />
  ) : (
    <span className="cell-display" onDoubleClick={() => setIsEditing(true)}>
      {renderDisplayValue(column, value)}
    </span>
  );
}

/**
 * セルの表示値をレンダリングする
 * @param column カラム定義
 * @param value 値
 * @returns 表示用の文字列
 */
function renderDisplayValue(column: ColumnDefinition, value: unknown): string {
  if (value === null || value === undefined) return "";
  if (column.type === "number") {
    return String(value ?? 0);
  }
  return String(value);
}

/** バックエンドからのワークスペース変更イベントペイロード */
interface WorkspaceChangePayload {
  data_path: string;
  schema_path: string;
}
