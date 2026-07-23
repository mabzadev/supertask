const DEFAULT_PUBLIC_URL = "https://opentabl.mbza.workers.dev";

type SnapshotRecord = Record<string, unknown>;

async function rows<T extends SnapshotRecord>(
  db: D1Database,
  sql: string,
  bindings: unknown[] = []
): Promise<T[]> {
  const result = await db.prepare(sql).bind(...bindings).all<T>();
  return result.results || [];
}

async function optionalRows<T extends SnapshotRecord>(
  db: D1Database,
  sql: string,
  bindings: unknown[] = []
): Promise<T[]> {
  try {
    return await rows<T>(db, sql, bindings);
  } catch (error: any) {
    const message = String(error?.message || error);
    if (message.includes("no such table") || message.includes("no such column")) return [];
    throw error;
  }
}

function normalizePublicUrl(publicUrl?: string): string {
  return String(publicUrl || DEFAULT_PUBLIC_URL).replace(/\/+$/, "");
}

function calendarIcalFeedUrl(view: any, publicUrl?: string): string | null {
  if (!view.ical_public || !view.ical_slug) return null;
  return `${normalizePublicUrl(publicUrl)}/api/database/views/calendar/${encodeURIComponent(String(view.ical_slug))}.ics`;
}

function parseJsonObject(value: unknown): unknown {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function serializeFilter(row: any): object {
  let preloadValues = {};
  if (row.preload_values) {
    try {
      preloadValues = JSON.parse(row.preload_values);
    } catch {
      preloadValues = {};
    }
  }

  return {
    id: row.id,
    view: row.view_id,
    field: row.field_id,
    type: row.type,
    value: row.value ?? "",
    group: row.group_id ?? null,
    preload_values: preloadValues,
  };
}

function serializeFilterGroup(row: any): object {
  return {
    id: row.id,
    view: row.view_id,
    parent_group: row.parent_group_id ?? null,
    filter_type: row.filter_type || "AND",
  };
}

function serializeSort(row: any): object {
  return {
    id: row.id,
    view: row.view_id,
    field: row.field_id,
    order: row.order || "ASC",
    type: row.type || "default",
  };
}

function serializeGroupBy(row: any): object {
  return {
    id: row.id,
    view: row.view_id,
    field: row.field_id,
    order: row.order || "ASC",
    width: row.width ?? 200,
    type: row.type || "default",
  };
}

function serializeDecoration(row: any): object {
  let valueProviderConf = {};
  try {
    valueProviderConf = row.value_provider_conf ? JSON.parse(row.value_provider_conf) : {};
  } catch {
    valueProviderConf = {};
  }
  return {
    id: row.id,
    view: row.view_id,
    type: row.type,
    value_provider_type: row.value_provider_type || "",
    value_provider_conf: valueProviderConf,
    order: row.order ?? 1,
  };
}

async function hydrateFormView(db: D1Database, view: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (view.type !== "form") return view;
  const form = await db.prepare(
    `SELECT title, description AS form_description, submit_text,
            submit_action, submit_action_message, submit_action_redirect_url,
            mode, show_logo AS form_show_logo, cover_image, logo_image
     FROM database_formview
     WHERE view_ptr_id=?`
  ).bind(view.id).first<any>();
  return {
    ...view,
    title: form?.title ?? "",
    form_description: form?.form_description ?? "",
    submit_text: form?.submit_text ?? "Submit",
    submit_action: form?.submit_action ?? "MESSAGE",
    submit_action_message: form?.submit_action_message ?? "",
    submit_action_redirect_url: form?.submit_action_redirect_url ?? "",
    mode: form?.mode === "survey" ? "survey" : "form",
    form_show_logo: form?.form_show_logo ?? 1,
    cover_image: form?.cover_image ?? null,
    logo_image: form?.logo_image ?? null,
  };
}

export async function serializeViewForUndoRedo(db: D1Database, view: Record<string, unknown>, publicUrl?: string) {
  const hydrated = await hydrateFormView(db, view);
  const serialized: Record<string, unknown> = {
    id: hydrated.id,
    table_id: hydrated.table_id,
    name: hydrated.name,
    type: hydrated.type,
    order: hydrated.order,
    filter_type: hydrated.filter_type || "AND",
    filters_disabled: Boolean(hydrated.filters_disabled),
    public: Boolean(hydrated.public),
    public_view_password: Boolean(hydrated.public_view_password),
    allow_public_export: Boolean(hydrated.allow_public_export),
    slug: hydrated.slug,
    row_identifier_type: hydrated.row_identifier_type || "count",
    ownership_type: hydrated.ownership_type || "collaborative",
    owned_by_id: hydrated.owned_by_id ?? null,
    row_height_size: hydrated.row_height_size || "small",
    created_on: hydrated.created_on,
    updated_on: hydrated.updated_on,
    filters: [],
    filter_groups: [],
    sortings: [],
    group_bys: [],
    decorations: [],
  };

  if (hydrated.type === "form") {
    serialized.title = hydrated.title || hydrated.name || "";
    serialized.description = hydrated.form_description ?? hydrated.description ?? "";
    serialized.submit_text = hydrated.submit_text || "Submit";
    serialized.submit_action = hydrated.submit_action || "MESSAGE";
    serialized.submit_action_message = hydrated.submit_action_message || "";
    serialized.submit_action_redirect_url = hydrated.submit_action_redirect_url || "";
    serialized.mode = hydrated.mode === "survey" ? "survey" : "form";
    serialized.show_logo = hydrated.form_show_logo === null || hydrated.form_show_logo === undefined ? true : Boolean(hydrated.form_show_logo);
    serialized.cover_image = parseJsonObject(hydrated.cover_image);
    serialized.logo_image = parseJsonObject(hydrated.logo_image);
  }

  if (hydrated.type === "gallery") {
    serialized.card_cover_image_field = hydrated.card_cover_image_field ?? null;
  }
  if (hydrated.type === "kanban") {
    serialized.single_select_field = hydrated.single_select_field ?? hydrated.single_select_field_id ?? null;
    serialized.card_cover_image_field = hydrated.card_cover_image_field ?? null;
  }
  if (hydrated.type === "calendar") {
    serialized.date_field = hydrated.date_field ?? hydrated.date_field_id ?? null;
    serialized.ical_public = Boolean(hydrated.ical_public);
    serialized.ical_slug = hydrated.ical_slug ?? null;
    serialized.ical_feed_url = calendarIcalFeedUrl(hydrated, publicUrl);
  }
  if (hydrated.type === "timeline") {
    serialized.start_date_field = hydrated.start_date_field ?? hydrated.start_date_field_id ?? null;
    serialized.end_date_field = hydrated.end_date_field ?? hydrated.end_date_field_id ?? null;
    serialized.timescale = hydrated.timescale || "month";
  }

  const [filters, filterGroups, sortings, groupBys, decorations] = await Promise.all([
    optionalRows(db, "SELECT * FROM database_viewfilter WHERE view_id=? ORDER BY id ASC", [hydrated.id]),
    optionalRows(db, "SELECT * FROM database_viewfiltergroup WHERE view_id=? ORDER BY id ASC", [hydrated.id]),
    optionalRows(db, "SELECT * FROM database_viewsort WHERE view_id=? ORDER BY id ASC", [hydrated.id]),
    optionalRows(db, "SELECT * FROM database_viewgroupby WHERE view_id=? ORDER BY id ASC", [hydrated.id]),
    optionalRows(db, "SELECT * FROM database_viewdecoration WHERE view_id=? ORDER BY [order] ASC, id ASC", [hydrated.id]),
  ]);
  serialized.filters = filters.map(serializeFilter);
  serialized.filter_groups = filterGroups.map(serializeFilterGroup);
  serialized.sortings = sortings.map(serializeSort);
  serialized.group_bys = groupBys.map(serializeGroupBy);
  serialized.decorations = decorations.map(serializeDecoration);

  return serialized;
}

function inClause(values: unknown[]) {
  return values.map(() => "?").join(",");
}

async function formOptionIdsForView(db: D1Database, viewId: number) {
  const optionRows = await optionalRows<{ id: number }>(
    db,
    "SELECT id FROM database_formviewfieldoptions WHERE form_view_id=? ORDER BY id ASC",
    [viewId]
  );
  return optionRows.map((option) => Number(option.id)).filter((id) => Number.isFinite(id));
}

async function formChildRowsForView(db: D1Database, viewId: number) {
  const optionIds = await formOptionIdsForView(db, viewId);
  if (optionIds.length === 0) {
    return {
      form_allowed_select_options: [],
      form_condition_groups: [],
      form_conditions: [],
    };
  }
  const optionMarks = inClause(optionIds);
  const groups = await optionalRows(
    db,
    `SELECT *
     FROM database_formviewfieldoptionsconditiongroup
     WHERE field_option_id IN (${optionMarks})
     ORDER BY id ASC`,
    optionIds
  );
  const groupIds = groups.map((group) => Number(group.id)).filter((id) => Number.isFinite(id));
  return {
    form_allowed_select_options: await optionalRows(
      db,
      `SELECT *
       FROM database_formviewfieldoptions_allowedselectoptions
       WHERE form_view_field_options_id IN (${optionMarks})
       ORDER BY id ASC`,
      optionIds
    ),
    form_condition_groups: groups,
    form_conditions: await optionalRows(
      db,
      groupIds.length > 0
        ? `SELECT *
           FROM database_formviewfieldoptionscondition
           WHERE field_option_id IN (${optionMarks}) OR group_id IN (${inClause(groupIds)})
           ORDER BY id ASC`
        : `SELECT *
           FROM database_formviewfieldoptionscondition
           WHERE field_option_id IN (${optionMarks})
           ORDER BY id ASC`,
      groupIds.length > 0 ? [...optionIds, ...groupIds] : optionIds
    ),
  };
}

export async function snapshotViewForUndoRedo(db: D1Database, viewId: number) {
  const view = await db.prepare("SELECT * FROM database_view WHERE id=?")
    .bind(viewId)
    .first<Record<string, unknown>>();
  if (!view) return null;
  const formView = await db.prepare("SELECT * FROM database_formview WHERE view_ptr_id=?")
    .bind(viewId)
    .first<Record<string, unknown>>();
  const formChildren = await formChildRowsForView(db, viewId);
  return {
    view,
    form_view: formView || null,
    filters: await optionalRows(db, "SELECT * FROM database_viewfilter WHERE view_id=? ORDER BY id ASC", [viewId]),
    filter_groups: await optionalRows(db, "SELECT * FROM database_viewfiltergroup WHERE view_id=? ORDER BY id ASC", [viewId]),
    sortings: await optionalRows(db, "SELECT * FROM database_viewsort WHERE view_id=? ORDER BY id ASC", [viewId]),
    group_bys: await optionalRows(db, "SELECT * FROM database_viewgroupby WHERE view_id=? ORDER BY id ASC", [viewId]),
    decorations: await optionalRows(db, "SELECT * FROM database_viewdecoration WHERE view_id=? ORDER BY [order] ASC, id ASC", [viewId]),
    grid_field_options: await optionalRows(db, "SELECT * FROM database_gridviewfieldoptions WHERE grid_view_id=? ORDER BY [order] ASC, id ASC", [viewId]),
    gallery_field_options: await optionalRows(db, "SELECT * FROM database_galleryviewfieldoptions WHERE gallery_view_id=? ORDER BY [order] ASC, id ASC", [viewId]),
    form_field_options: await optionalRows(db, "SELECT * FROM database_formviewfieldoptions WHERE form_view_id=? ORDER BY [order] ASC, id ASC", [viewId]),
    form_users_to_notify: await optionalRows(db, "SELECT * FROM database_formview_users_to_notify_on_submit WHERE formview_id=? ORDER BY user_id ASC", [viewId]),
    ...formChildren,
  };
}

function snapshotArray(snapshot: SnapshotRecord, key: string): SnapshotRecord[] {
  const value = snapshot[key];
  return Array.isArray(value)
    ? value.filter((item): item is SnapshotRecord => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    : [];
}

function recordColumns(record: SnapshotRecord) {
  return Object.keys(record);
}

async function insertRecord(
  db: D1Database,
  table: string,
  record: SnapshotRecord
) {
  const columns = recordColumns(record);
  if (columns.length === 0) return;
  const bindMarks = columns.map(() => "?").join(", ");
  await db.prepare(
    `INSERT OR IGNORE INTO ${table} (${columns.map((column) => `"${column}"`).join(", ")}) VALUES (${bindMarks})`
  ).bind(...columns.map((column) => record[column])).run();
}

async function upsertRecord(
  db: D1Database,
  table: string,
  idColumn: string,
  record: SnapshotRecord
) {
  await insertRecord(db, table, record);
  const columns = recordColumns(record).filter((column) => column !== idColumn);
  if (columns.length === 0) return;
  await db.prepare(
    `UPDATE ${table} SET ${columns.map((column) => `"${column}"=?`).join(", ")} WHERE "${idColumn}"=?`
  ).bind(...columns.map((column) => record[column]), record[idColumn]).run();
}

async function deleteCurrentFormChildren(db: D1Database, viewId: number) {
  const optionIds = await formOptionIdsForView(db, viewId);
  if (optionIds.length === 0) return;
  const optionMarks = inClause(optionIds);
  await db.prepare(`DELETE FROM database_formviewfieldoptions_allowedselectoptions WHERE form_view_field_options_id IN (${optionMarks})`)
    .bind(...optionIds)
    .run();
  await db.prepare(`DELETE FROM database_formviewfieldoptionscondition WHERE field_option_id IN (${optionMarks})`)
    .bind(...optionIds)
    .run();
  await db.prepare(`DELETE FROM database_formviewfieldoptionsconditiongroup WHERE field_option_id IN (${optionMarks})`)
    .bind(...optionIds)
    .run();
}

async function restoreSelfReferencingRows(
  db: D1Database,
  table: string,
  idColumn: string,
  parentColumn: string,
  records: SnapshotRecord[]
) {
  for (const record of records) {
    await insertRecord(db, table, { ...record, [parentColumn]: null });
  }
  for (const record of records) {
    await upsertRecord(db, table, idColumn, record);
  }
}

export async function restoreViewStateForUndoRedo(db: D1Database, snapshot: SnapshotRecord) {
  const view = snapshot.view;
  if (!view || typeof view !== "object" || Array.isArray(view)) {
    throw new Error("View snapshot is missing.");
  }
  const viewRecord = view as SnapshotRecord;
  const viewId = Number(viewRecord.id);
  if (!Number.isInteger(viewId) || viewId <= 0) throw new Error("View snapshot id is invalid.");

  await upsertRecord(db, "database_view", "id", viewRecord);

  const formView = snapshot.form_view;
  if (formView && typeof formView === "object" && !Array.isArray(formView)) {
    await upsertRecord(db, "database_formview", "view_ptr_id", formView as SnapshotRecord);
  } else {
    await db.prepare("DELETE FROM database_formview WHERE view_ptr_id=?").bind(viewId).run();
  }

  await deleteCurrentFormChildren(db, viewId);
  await db.prepare("DELETE FROM database_viewfilter WHERE view_id=?").bind(viewId).run();
  await db.prepare("DELETE FROM database_viewfiltergroup WHERE view_id=?").bind(viewId).run();
  await db.prepare("DELETE FROM database_viewsort WHERE view_id=?").bind(viewId).run();
  await db.prepare("DELETE FROM database_viewgroupby WHERE view_id=?").bind(viewId).run();
  await db.prepare("DELETE FROM database_viewdecoration WHERE view_id=?").bind(viewId).run();
  await db.prepare("DELETE FROM database_gridviewfieldoptions WHERE grid_view_id=?").bind(viewId).run();
  await db.prepare("DELETE FROM database_galleryviewfieldoptions WHERE gallery_view_id=?").bind(viewId).run();
  await db.prepare("DELETE FROM database_formviewfieldoptions WHERE form_view_id=?").bind(viewId).run();
  await db.prepare("DELETE FROM database_formview_users_to_notify_on_submit WHERE formview_id=?").bind(viewId).run();

  await restoreSelfReferencingRows(db, "database_viewfiltergroup", "id", "parent_group_id", snapshotArray(snapshot, "filter_groups"));
  for (const filter of snapshotArray(snapshot, "filters")) {
    await insertRecord(db, "database_viewfilter", filter);
  }
  for (const sort of snapshotArray(snapshot, "sortings")) {
    await insertRecord(db, "database_viewsort", sort);
  }
  for (const groupBy of snapshotArray(snapshot, "group_bys")) {
    await insertRecord(db, "database_viewgroupby", groupBy);
  }
  for (const option of snapshotArray(snapshot, "grid_field_options")) {
    await insertRecord(db, "database_gridviewfieldoptions", option);
  }
  for (const option of snapshotArray(snapshot, "gallery_field_options")) {
    await insertRecord(db, "database_galleryviewfieldoptions", option);
  }
  for (const option of snapshotArray(snapshot, "form_field_options")) {
    await insertRecord(db, "database_formviewfieldoptions", option);
  }
  for (const subscriber of snapshotArray(snapshot, "form_users_to_notify")) {
    await insertRecord(db, "database_formview_users_to_notify_on_submit", subscriber);
  }
  for (const option of snapshotArray(snapshot, "form_allowed_select_options")) {
    await insertRecord(db, "database_formviewfieldoptions_allowedselectoptions", option);
  }
  await restoreSelfReferencingRows(
    db,
    "database_formviewfieldoptionsconditiongroup",
    "id",
    "parent_group_id",
    snapshotArray(snapshot, "form_condition_groups")
  );
  for (const condition of snapshotArray(snapshot, "form_conditions")) {
    await insertRecord(db, "database_formviewfieldoptionscondition", condition);
  }
  for (const decoration of snapshotArray(snapshot, "decorations")) {
    await insertRecord(db, "database_viewdecoration", decoration);
  }
}
