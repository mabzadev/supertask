import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";

export type TrashItemType =
  | "application"
  | "table"
  | "field"
  | "view"
  | "row"
  | "row_comment"
  | "rows"
  | "workspace"
  | "team"
  | "automation_workflow"
  | "automation_node";

export interface RecordTrashEntryOptions {
  userId: number;
  workspaceId: number;
  applicationId?: number | null;
  trashItemType: TrashItemType;
  trashItemId: number;
  parentTrashItemId?: number | null;
  name?: string | null;
  names?: string[];
  parentName?: string | null;
  extra?: Record<string, unknown>;
  trashedAt?: string;
}

export function parseTrashDescription(value: string | null | undefined): Record<string, any> {
  try {
    return value ? JSON.parse(value) : {};
  } catch {
    return {};
  }
}

/** The statements that (re)record a trash entry, for callers that batch them with the trashing write. */
export function trashEntryStatements(
  db: D1Database,
  options: RecordTrashEntryOptions
): D1PreparedStatement[] {
  const parentTrashItemId = options.parentTrashItemId ?? null;
  const trashedAt = options.trashedAt || new Date().toISOString();
  const description = {
    ...(options.extra || {}),
    name: options.name || "",
    names: options.names || [],
    parent_name: options.parentName || "",
  };

  const removePrevious = parentTrashItemId === null
    ? db.prepare(
      "DELETE FROM core_trasheditem WHERE trash_item_type=? AND trash_item_id=?"
    ).bind(options.trashItemType, options.trashItemId)
    : db.prepare(
      `DELETE FROM core_trasheditem
       WHERE trash_item_type=?
         AND trash_item_id=?
         AND parent_trash_item_id=?`
    ).bind(options.trashItemType, options.trashItemId, parentTrashItemId);

  const insert = db.prepare(
    `INSERT INTO core_trasheditem
     (user_id, trash_item_type, trash_item_id, parent_trash_item_id,
      trashed_at, should_be_permanently_deleted, extra_description,
      application_id, workspace_id)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)`
  ).bind(
    options.userId,
    options.trashItemType,
    options.trashItemId,
    parentTrashItemId,
    trashedAt,
    JSON.stringify(description),
    options.applicationId ?? null,
    options.workspaceId
  );
  return [removePrevious, insert];
}

export async function recordTrashEntry(
  db: D1Database,
  options: RecordTrashEntryOptions
): Promise<void> {
  for (const statement of trashEntryStatements(db, options)) await statement.run();
}

export async function deleteTrashEntry(
  db: D1Database,
  trashItemType: TrashItemType,
  trashItemId: number,
  parentTrashItemId: number | null = null
): Promise<void> {
  if (parentTrashItemId === null) {
    await db.prepare(
      "DELETE FROM core_trasheditem WHERE trash_item_type=? AND trash_item_id=?"
    ).bind(trashItemType, trashItemId).run();
    return;
  }
  await db.prepare(
    "DELETE FROM core_trasheditem WHERE trash_item_type=? AND trash_item_id=? AND parent_trash_item_id=?"
  ).bind(trashItemType, trashItemId, parentTrashItemId).run();
}
