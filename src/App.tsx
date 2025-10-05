import type { JSX } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
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

type ColumnType = "text" | "number" | "checkbox" | "multiselect" | "relation";

type TableRow = Record<string, unknown>;

interface ColumnDefinition {
  id: string;
  name: string;
  type: ColumnType;
  width?: number;
  required?: boolean;
  hidden?: boolean;
  system?: boolean;
  format?: string;
}

interface TableSchema {
  version?: string;
  table_name?: string;
  columns: ColumnDefinition[];
  metadata?: Record<string, unknown>;
  extensions?: Record<string, unknown>;
}

interface WorkspaceInfoPayload {
  data_path: string;
  schema_path: string;
  folder: string;
}

interface TablePayload {
  data: TableRow[];
  schema: TableSchema;
  workspace: WorkspaceInfoPayload;
}

interface WorkspaceInfo {
  dataPath: string;
  schemaPath: string;
  folder: string;
}

interface SaveResult {
  row_count: number;
  updated_at: string;
}

interface ConflictState {
  snapshot: TablePayload;
  detectedAt: string;
}

const LOCAL_COLUMN_TYPES: ColumnType[] = ["text", "number", "checkbox"];

const SYSTEM_COLUMN_PREFIX = "_";

function toColumnId(name: string, existingIds: string[]): string {
  const base = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  let candidate = base || `col_${Date.now()}`;
  let counter = 1;
  while (existingIds.includes(candidate)) {
    candidate = `${base}_${counter}`;
    counter += 1;
  }
  return candidate;
}

function createEmptyRow(columns: ColumnDefinition[], order: number): TableRow {
  const now = new Date().toISOString();
  const row: TableRow = {
    _id: `row_${crypto.randomUUID().slice(0, 8)}`,
    _created: now,
    _updated: now,
    _order: order,
  };

  columns.forEach((column) => {
    if (column.id.startsWith(SYSTEM_COLUMN_PREFIX)) {
      return;
    }
    if (row[column.id] !== undefined) {
      return;
    }

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

function moveItem<T>(items: T[], fromIndex: number, toIndex: number): T[] {
  if (fromIndex === toIndex) return items;
  const next = [...items];
  const [moved] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, moved);
  return next;
}

function normaliseNumber(value: string): number {
  if (value.trim() === "") {
    return 0;
  }
  const parsed = Number(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function isSystemColumn(column: ColumnDefinition): boolean {
  return column.system ?? column.id.startsWith(SYSTEM_COLUMN_PREFIX);
}

function cloneRows(rows: TableRow[]): TableRow[] {
  return rows.map((row) => ({ ...row }));
}

export default function App(): JSX.Element {
  const [rows, setRows] = useState<TableRow[]>([]);
  const [schema, setSchema] = useState<TableSchema | null>(null);
  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null);
  const [statusMessage, setStatusMessage] = useState<string>("ワークスペースを選択してください");
  const [isSaving, setIsSaving] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [conflict, setConflict] = useState<ConflictState | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [columnDialog, setColumnDialog] = useState<{
    open: boolean;
    name: string;
    type: ColumnType;
  }>({ open: false, name: "", type: "text" });

  const saveTimerRef = useRef<number | null>(null);
  const latestPayloadRef = useRef<{ rows: TableRow[]; schema: TableSchema } | null>(null);
  const ignoreEventsUntilRef = useRef<number>(0);
  const suspendAutoSaveRef = useRef<boolean>(false);
  const unlistenRef = useRef<Promise<UnlistenFn> | null>(null);
  const draggedColumnIdRef = useRef<string | null>(null);

  const userColumns = useMemo(() => {
    if (!schema) return [] as ColumnDefinition[];
    return schema.columns.filter((column) => !column.hidden);
  }, [schema]);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8,
      },
    })
  );

  const performSave = useCallback(async () => {
    if (!latestPayloadRef.current || !schema) return;
    if (!workspace) return;

    const payload = latestPayloadRef.current;
    if (saveTimerRef.current) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    setIsSaving(true);
    setStatusMessage("保存中…");
    setErrorMessage(null);
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

  const scheduleSave = useCallback(
    (nextRows: TableRow[], nextSchema: TableSchema) => {
      if (suspendAutoSaveRef.current) {
        latestPayloadRef.current = { rows: cloneRows(nextRows), schema: { ...nextSchema } };
        return;
      }

      latestPayloadRef.current = { rows: cloneRows(nextRows), schema: { ...nextSchema } };
      setDirty(true);
      setStatusMessage("編集中…");
      if (saveTimerRef.current) {
        window.clearTimeout(saveTimerRef.current);
      }
      saveTimerRef.current = window.setTimeout(() => {
        void performSave();
      }, 1000);
    },
    [performSave]
  );

  const flushPendingSave = useCallback(async () => {
    if (!dirty) return;
    await performSave();
  }, [dirty, performSave]);

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

  const applySnapshot = useCallback((snapshot: TablePayload) => {
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

  const handleCreateWorkspace = useCallback(async () => {
    await flushPendingSave();

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

  const handleAddRow = useCallback(() => {
    if (!schema) return;
    const nextRows = [...rows, createEmptyRow(schema.columns, rows.length)];
    setRows(nextRows);
    scheduleSave(nextRows, schema);
  }, [rows, schema, scheduleSave]);

  const handleDeleteRow = useCallback(
    (rowId: string) => {
      if (!schema) return;
      const nextRows = rows.filter((row) => row._id !== rowId);
      setRows(nextRows);
      scheduleSave(nextRows, schema);
    },
    [rows, schema, scheduleSave]
  );


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

  const handleResolveKeep = useCallback(async () => {
    await performSave();
    setConflict(null);
  }, [performSave]);

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

interface SortableRowProps {
  row: TableRow;
  userColumns: ColumnDefinition[];
  onCellChange: (rowId: string, column: ColumnDefinition, value: unknown) => void;
  onDelete: (rowId: string) => void;
}

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

interface EditableCellProps {
  column: ColumnDefinition;
  value: unknown;
  onChange: (value: unknown) => void;
}

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

function renderDisplayValue(column: ColumnDefinition, value: unknown): string {
  if (value === null || value === undefined) return "";
  if (column.type === "number") {
    return String(value ?? 0);
  }
  return String(value);
}

interface WorkspaceChangePayload {
  data_path: string;
  schema_path: string;
}
