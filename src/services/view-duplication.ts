import type { D1Database } from "@cloudflare/workers-types";

type DuplicateViewDependencyMaps = {
  fieldMap?: Map<number, number>;
  selectOptionMap?: Map<number, number>;
};

function parseJson(value: unknown): unknown {
  if (typeof value !== "string" || value === "") return value ?? null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function stringifyJson(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? value : JSON.stringify(value);
}

function remapId(value: unknown, map?: Map<number, number>): unknown {
  if (!map) return value;
  const id = Number(value);
  return Number.isFinite(id) && map.has(id) ? map.get(id)! : value;
}

function remapJsonReferences(value: unknown, maps: DuplicateViewDependencyMaps): unknown {
  if (Array.isArray(value)) return value.map((item) => remapJsonReferences(item, maps));
  if (!value || typeof value !== "object") return value;

  const result: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (key === "link_row_table_primary_field" && raw && typeof raw === "object") {
      const field = raw as Record<string, unknown>;
      result[key] = { ...field, id: remapId(field.id, maps.fieldMap) };
    } else if (["field", "field_id", "through_field_id", "target_field_id", "single_select_field", "date_field", "start_date_field", "end_date_field", "card_cover_image_field"].includes(key)) {
      result[key] = remapId(raw, maps.fieldMap);
    } else if (["id", "select_option_id"].includes(key) && Number.isFinite(Number(raw))) {
      result[key] = remapId(raw, maps.selectOptionMap);
    } else {
      result[key] = remapJsonReferences(raw, maps);
    }
  }
  return result;
}

function remapSelectValue(value: unknown, optionMap?: Map<number, number>): unknown {
  if (!optionMap) return value;
  const parsed = parseJson(value);
  if (parsed === null || parsed === undefined || parsed === "") return parsed;
  if (Array.isArray(parsed)) return parsed.map((item) => remapSelectValue(item, optionMap));
  if (typeof parsed === "object") {
    const raw = parsed as Record<string, unknown>;
    return { ...raw, id: remapId(raw.id, optionMap) };
  }
  return remapId(parsed, optionMap);
}

async function fieldType(db: D1Database, fieldId: unknown): Promise<string | null> {
  if (fieldId === null || fieldId === undefined) return null;
  const field = await db.prepare("SELECT type FROM database_field WHERE id=?").bind(fieldId).first<{ type: string }>();
  return field?.type || null;
}

async function duplicateViewFilterGroups(db: D1Database, sourceViewId: number, targetViewId: number): Promise<Map<number, number>> {
  const groups = await db.prepare(
    "SELECT * FROM database_viewfiltergroup WHERE view_id=? ORDER BY id ASC"
  ).bind(sourceViewId).all<any>();
  const groupIdMap = new Map<number, number>();

  for (const group of groups.results || []) {
    const parentId = group.parent_group_id ? groupIdMap.get(Number(group.parent_group_id)) || null : null;
    const inserted = await db.prepare(
      "INSERT INTO database_viewfiltergroup (view_id, parent_group_id, filter_type) VALUES (?, ?, ?) RETURNING id"
    ).bind(targetViewId, parentId, group.filter_type || "AND").first<{ id: number }>();
    if (inserted) groupIdMap.set(Number(group.id), inserted.id);
  }

  return groupIdMap;
}

async function duplicateViewFilters(
  db: D1Database,
  sourceViewId: number,
  targetViewId: number,
  groupIdMap: Map<number, number>,
  maps: DuplicateViewDependencyMaps
): Promise<void> {
  const filters = await db.prepare(
    "SELECT * FROM database_viewfilter WHERE view_id=? ORDER BY id ASC"
  ).bind(sourceViewId).all<any>();
  const statements = [];
  for (const filter of filters.results || []) {
    const type = await fieldType(db, filter.field_id);
    const value = type === "single_select" || type === "multiple_select"
      ? stringifyJson(remapSelectValue(filter.value, maps.selectOptionMap)) ?? ""
      : filter.value ?? "";
    statements.push(db.prepare(
      "INSERT INTO database_viewfilter (view_id, field_id, type, value, preload_values, group_id) VALUES (?, ?, ?, ?, ?, ?)"
    ).bind(
      targetViewId,
      remapId(filter.field_id, maps.fieldMap),
      filter.type,
      value,
      stringifyJson(remapJsonReferences(parseJson(filter.preload_values || "{}"), maps)) || "{}",
      filter.group_id ? groupIdMap.get(Number(filter.group_id)) || null : null
    ));
  }
  if (statements.length > 0) await db.batch(statements);
}

async function duplicateSortsAndGroups(db: D1Database, sourceViewId: number, targetViewId: number, maps: DuplicateViewDependencyMaps): Promise<void> {
  const sorts = await db.prepare(
    "SELECT * FROM database_viewsort WHERE view_id=? ORDER BY id ASC"
  ).bind(sourceViewId).all<any>();
  const sortStatements = (sorts.results || []).map((sort) => db.prepare(
    "INSERT INTO database_viewsort (view_id, field_id, [order], type) VALUES (?, ?, ?, ?)"
  ).bind(targetViewId, remapId(sort.field_id, maps.fieldMap), sort.order || "ASC", sort.type || "default"));

  const groupBys = await db.prepare(
    "SELECT * FROM database_viewgroupby WHERE view_id=? ORDER BY id ASC"
  ).bind(sourceViewId).all<any>();
  const groupStatements = (groupBys.results || []).map((group) => db.prepare(
    "INSERT INTO database_viewgroupby (view_id, field_id, [order], width, type) VALUES (?, ?, ?, ?, ?)"
  ).bind(targetViewId, remapId(group.field_id, maps.fieldMap), group.order || "ASC", group.width ?? 200, group.type || "default"));

  const statements = [...sortStatements, ...groupStatements];
  if (statements.length > 0) await db.batch(statements);
}

async function duplicateDecorations(db: D1Database, sourceViewId: number, targetViewId: number, maps: DuplicateViewDependencyMaps): Promise<void> {
  const decorations = await db.prepare(
    "SELECT * FROM database_viewdecoration WHERE view_id=? ORDER BY [order] ASC, id ASC"
  ).bind(sourceViewId).all<any>();
  const statements = (decorations.results || []).map((decoration) => db.prepare(
    "INSERT INTO database_viewdecoration (view_id, type, value_provider_type, value_provider_conf, [order]) VALUES (?, ?, ?, ?, ?)"
  ).bind(
    targetViewId,
    decoration.type,
    decoration.value_provider_type || "",
    stringifyJson(remapJsonReferences(parseJson(decoration.value_provider_conf || "{}"), maps)) || "{}",
    decoration.order ?? 1
  ));
  if (statements.length > 0) await db.batch(statements);
}

async function duplicateGridFieldOptions(db: D1Database, sourceViewId: number, targetViewId: number, maps: DuplicateViewDependencyMaps): Promise<void> {
  const options = await db.prepare(
    "SELECT field_id, width, hidden, [order], aggregation_type, aggregation_raw_type FROM database_gridviewfieldoptions WHERE grid_view_id=?"
  ).bind(sourceViewId).all<any>();
  const statements = (options.results || []).map((option) => db.prepare(
    `INSERT OR IGNORE INTO database_gridviewfieldoptions
     (grid_view_id, field_id, width, hidden, [order], aggregation_type, aggregation_raw_type)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    targetViewId,
    remapId(option.field_id, maps.fieldMap),
    option.width ?? 200,
    option.hidden ? 1 : 0,
    option.order ?? 32767,
    option.aggregation_type || "",
    option.aggregation_raw_type || ""
  ));
  if (statements.length > 0) await db.batch(statements);
}

async function duplicateGalleryFieldOptions(db: D1Database, sourceViewId: number, targetViewId: number, maps: DuplicateViewDependencyMaps): Promise<void> {
  const options = await db.prepare(
    "SELECT field_id, hidden, [order] FROM database_galleryviewfieldoptions WHERE gallery_view_id=?"
  ).bind(sourceViewId).all<any>();
  const statements = (options.results || []).map((option) => db.prepare(
    `INSERT OR IGNORE INTO database_galleryviewfieldoptions
     (gallery_view_id, field_id, hidden, [order])
     VALUES (?, ?, ?, ?)`
  ).bind(targetViewId, remapId(option.field_id, maps.fieldMap), option.hidden ? 1 : 0, option.order ?? 32767));
  if (statements.length > 0) await db.batch(statements);
}

async function duplicateFormView(db: D1Database, sourceViewId: number, targetViewId: number, maps: DuplicateViewDependencyMaps): Promise<Map<number, number>> {
  const form = await db.prepare(
    "SELECT * FROM database_formview WHERE view_ptr_id=?"
  ).bind(sourceViewId).first<any>();
  if (form) {
    await db.prepare(
      `INSERT OR REPLACE INTO database_formview
       (view_ptr_id, title, description, submit_text, submit_action, submit_action_message,
        submit_action_redirect_url, mode, show_logo, cover_image, logo_image)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      targetViewId,
      form.title || "",
      form.description || "",
      form.submit_text || "Submit",
      form.submit_action || "MESSAGE",
      form.submit_action_message || "",
      form.submit_action_redirect_url || "",
      form.mode || "form",
      form.show_logo === 0 ? 0 : 1,
      form.cover_image ?? null,
      form.logo_image ?? null
    ).run();
  }

  const options = await db.prepare(
    "SELECT * FROM database_formviewfieldoptions WHERE form_view_id=? ORDER BY [order] ASC, id ASC"
  ).bind(sourceViewId).all<any>();
  const optionIdMap = new Map<number, number>();
  for (const option of options.results || []) {
    const inserted = await db.prepare(
      `INSERT INTO database_formviewfieldoptions
       (form_view_id, field_id, name, description, enabled, required, [order],
        show_when_matching_conditions, condition_type, include_all_select_options, field_component)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING id`
    ).bind(
      targetViewId,
      remapId(option.field_id, maps.fieldMap),
      option.name || "",
      option.description || "",
      option.enabled ? 1 : 0,
      option.required ? 1 : 0,
      option.order ?? 32767,
      option.show_when_matching_conditions ? 1 : 0,
      option.condition_type || "AND",
      option.include_all_select_options === 0 ? 0 : 1,
      option.field_component || "default"
    ).first<{ id: number }>();
    if (inserted) optionIdMap.set(Number(option.id), inserted.id);
  }
  return optionIdMap;
}

async function duplicateFormSubmitSubscribers(
  db: D1Database,
  sourceViewId: number,
  targetViewId: number
): Promise<void> {
  const subscribers = await db.prepare(
    `SELECT user_id
     FROM database_formview_users_to_notify_on_submit
     WHERE formview_id=?
     ORDER BY user_id ASC`
  ).bind(sourceViewId).all<{ user_id: number }>();
  const statements = (subscribers.results || []).map((subscriber) => db.prepare(
    `INSERT OR IGNORE INTO database_formview_users_to_notify_on_submit (formview_id, user_id)
     VALUES (?, ?)`
  ).bind(targetViewId, subscriber.user_id));
  if (statements.length > 0) await db.batch(statements);
}

async function duplicateFormAllowedSelectOptions(db: D1Database, optionIdMap: Map<number, number>, maps: DuplicateViewDependencyMaps): Promise<void> {
  if (optionIdMap.size === 0) return;
  const sourceIds = [...optionIdMap.keys()];
  const marks = sourceIds.map(() => "?").join(",");
  const rows = await db.prepare(
    `SELECT form_view_field_options_id, select_option_id
     FROM database_formviewfieldoptions_allowedselectoptions
     WHERE form_view_field_options_id IN (${marks})
     ORDER BY id ASC`
  ).bind(...sourceIds).all<any>();
  const statements = (rows.results || []).flatMap((row) => {
    const targetOptionId = optionIdMap.get(Number(row.form_view_field_options_id));
    return targetOptionId
      ? [db.prepare(
        `INSERT OR IGNORE INTO database_formviewfieldoptions_allowedselectoptions
         (form_view_field_options_id, select_option_id)
         VALUES (?, ?)`
      ).bind(targetOptionId, remapId(row.select_option_id, maps.selectOptionMap))]
      : [];
  });
  if (statements.length > 0) await db.batch(statements);
}

async function duplicateFormConditionGroups(db: D1Database, optionIdMap: Map<number, number>): Promise<Map<number, number>> {
  const groupIdMap = new Map<number, number>();
  for (const [sourceOptionId, targetOptionId] of optionIdMap) {
    const groups = await db.prepare(
      `SELECT * FROM database_formviewfieldoptionsconditiongroup
       WHERE field_option_id=?
       ORDER BY id ASC`
    ).bind(sourceOptionId).all<any>();
    for (const group of groups.results || []) {
      const parentId = group.parent_group_id ? groupIdMap.get(Number(group.parent_group_id)) || null : null;
      const inserted = await db.prepare(
        `INSERT INTO database_formviewfieldoptionsconditiongroup
         (field_option_id, filter_type, parent_group_id)
         VALUES (?, ?, ?)
         RETURNING id`
      ).bind(targetOptionId, group.filter_type || "AND", parentId).first<{ id: number }>();
      if (inserted) groupIdMap.set(Number(group.id), inserted.id);
    }
  }
  return groupIdMap;
}

async function duplicateFormConditions(
  db: D1Database,
  optionIdMap: Map<number, number>,
  groupIdMap: Map<number, number>,
  maps: DuplicateViewDependencyMaps
): Promise<void> {
  for (const [sourceOptionId, targetOptionId] of optionIdMap) {
    const conditions = await db.prepare(
      `SELECT * FROM database_formviewfieldoptionscondition
       WHERE field_option_id=?
       ORDER BY id ASC`
    ).bind(sourceOptionId).all<any>();
    const statements = [];
    for (const condition of conditions.results || []) {
      const type = await fieldType(db, condition.field_id);
      const value = type === "single_select" || type === "multiple_select"
        ? stringifyJson(remapSelectValue(condition.value, maps.selectOptionMap)) ?? ""
        : condition.value ?? "";
      statements.push(db.prepare(
        `INSERT INTO database_formviewfieldoptionscondition
         (field_option_id, field_id, type, value, group_id)
         VALUES (?, ?, ?, ?, ?)`
      ).bind(
        targetOptionId,
        remapId(condition.field_id, maps.fieldMap),
        condition.type,
        value,
        condition.group_id ? groupIdMap.get(Number(condition.group_id)) || null : null
      ));
    }
    if (statements.length > 0) await db.batch(statements);
  }
}

export async function duplicateViewDependencies(
  db: D1Database,
  sourceViewId: number,
  targetViewId: number,
  viewType: string,
  maps: DuplicateViewDependencyMaps = {}
): Promise<void> {
  const groupIdMap = await duplicateViewFilterGroups(db, sourceViewId, targetViewId);
  await duplicateViewFilters(db, sourceViewId, targetViewId, groupIdMap, maps);
  await duplicateSortsAndGroups(db, sourceViewId, targetViewId, maps);
  await duplicateDecorations(db, sourceViewId, targetViewId, maps);

  if (viewType === "gallery") {
    await duplicateGalleryFieldOptions(db, sourceViewId, targetViewId, maps);
  } else if (viewType === "form") {
    const optionIdMap = await duplicateFormView(db, sourceViewId, targetViewId, maps);
    await duplicateFormSubmitSubscribers(db, sourceViewId, targetViewId);
    await duplicateFormAllowedSelectOptions(db, optionIdMap, maps);
    const formGroupIdMap = await duplicateFormConditionGroups(db, optionIdMap);
    await duplicateFormConditions(db, optionIdMap, formGroupIdMap, maps);
  } else {
    await duplicateGridFieldOptions(db, sourceViewId, targetViewId, maps);
  }
}
