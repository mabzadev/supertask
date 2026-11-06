import { TEMPLATE_MANIFEST, type TemplateManifestItem } from "../generated/templates-manifest";
import { unzipSync } from "fflate";
import { DoesNotExist } from "../middleware/error";
import { assertHasWorkspaceRole } from "./enterprise-permissions";
import { addFieldColumn, getOrCreateUserTable, serializeFieldValueForInsert, type FieldType } from "./dynamic-tables";
import { buildPublicUrl } from "./user-files";
import type { Env } from "../types/env";
import { disableInvalidAIAutoUpdateUser, remapAIFieldSettings } from "./ai-field-settings";
import { synchronizeFieldDependencies } from "./field-dependencies";

type IdMap = Map<number, number>;
type AssetMetaMap = Map<string, { size: number; mimeType: string; isImage: boolean }>;
type SourceTableMap = Map<number, any>;
type SelectOptionValue = { id: number; value: string; color: string };
type SelectOptionValueMap = Map<number, SelectOptionValue>;

const TEMPLATE_SOURCE_PREFIX = "templates";
const DEFAULT_TEMPLATE_SLUG = "project-management";
const BASE_FIELD_KEYS = new Set([
  "id", "type", "name", "order", "primary", "read_only", "trashed",
  "description", "db_index", "immutable_type", "immutable_properties",
]);

function now() {
  return new Date().toISOString();
}

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

function remapId(value: unknown, map: IdMap): unknown {
  const id = Number(value);
  return Number.isFinite(id) && map.has(id) ? map.get(id)! : value;
}

function mappedId(value: unknown, map: IdMap): number | null {
  if (value === null || value === undefined || value === "") return null;
  const remapped = remapId(value, map);
  const id = Number(remapped);
  return Number.isFinite(id) && id > 0 ? id : null;
}

function remapJsonReferences(value: unknown, maps: { fields?: IdMap; selectOptions?: IdMap }): unknown {
  if (Array.isArray(value)) return value.map((item) => remapJsonReferences(item, maps));
  if (!value || typeof value !== "object") return value;

  const result: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if ([
      "field",
      "field_id",
      "single_select_field",
      "single_select_field_id",
      "date_field",
      "date_field_id",
      "start_date_field",
      "start_date_field_id",
      "end_date_field",
      "end_date_field_id",
      "card_cover_image_field",
      "card_cover_image_field_id",
    ].includes(key) && maps.fields) {
      result[key] = remapId(raw, maps.fields);
    } else if (["id", "select_option_id"].includes(key) && maps.selectOptions && Number.isFinite(Number(raw))) {
      result[key] = remapId(raw, maps.selectOptions);
    } else {
      result[key] = remapJsonReferences(raw, maps);
    }
  }
  return result;
}

function remapSelectValue(value: unknown, optionMap: IdMap): unknown {
  const parsed = parseJson(value);
  if (parsed === null || parsed === undefined || parsed === "") return parsed;
  if (Array.isArray(parsed)) return parsed.map((item) => remapSelectValue(item, optionMap));
  if (typeof parsed === "object") {
    const raw = parsed as Record<string, unknown>;
    return { ...raw, id: remapId(raw.id, optionMap) };
  }
  return remapId(parsed, optionMap);
}

function viewFieldReference(view: any, baseName: string): unknown {
  return view[baseName] ?? view[`${baseName}_id`];
}

function normalizeFieldOptions(fieldOptions: unknown): any[] {
  if (Array.isArray(fieldOptions)) return fieldOptions;
  if (fieldOptions && typeof fieldOptions === "object") {
    return Object.entries(fieldOptions as Record<string, any>).map(([fieldId, options]) => ({
      ...(options || {}),
      field_id: options?.field_id ?? Number(fieldId),
    }));
  }
  return [];
}

function sourceTableMap(app: any): SourceTableMap {
  return new Map((app.tables || []).map((table: any) => [Number(table.id), table]));
}

function primarySourceField(table: any): any | null {
  const fields = Array.isArray(table?.fields) ? table.fields : [];
  return fields.find((field: any) => field.primary) || fields[0] || null;
}

function sourceRowById(table: any, rowId: number): any | null {
  return (table?.rows || []).find((row: any) => Number(row.id) === rowId) || null;
}

function sourceSelectOptionValue(field: any, optionId: unknown): string | null {
  const option = (field?.select_options || []).find((item: any) => Number(item.id) === Number(optionId));
  return option ? String(option.value ?? "") : null;
}

function mapTemplateSelectOption(oldField: any, value: unknown, selectOptionValues: SelectOptionValueMap): SelectOptionValue | null {
  if (value === null || value === undefined || value === "") return null;
  const raw = value && typeof value === "object" ? value as Record<string, unknown> : null;
  const rawId = raw?.id ?? value;
  const id = Number(rawId);
  if (Number.isFinite(id) && selectOptionValues.has(id)) return selectOptionValues.get(id)!;

  const rawValue = raw?.value ?? value;
  const sourceOption = (oldField.select_options || []).find((option: any) => String(option.value) === String(rawValue));
  if (sourceOption && selectOptionValues.has(Number(sourceOption.id))) {
    return selectOptionValues.get(Number(sourceOption.id))!;
  }

  if (raw?.value !== undefined) {
    const fallbackId = Number(raw.id || 0);
    if (Number.isInteger(fallbackId) && fallbackId > 0) {
      return {
        id: fallbackId,
        value: String(raw.value ?? ""),
        color: String(raw.color || "blue"),
      };
    }
  }
  return null;
}

function sourceCellDisplayValue(field: any, value: unknown): string {
  if (value === null || value === undefined) return "";
  if (field?.type === "single_select") {
    return sourceSelectOptionValue(field, value) ?? String(value);
  }
  if (field?.type === "multiple_select" && Array.isArray(value)) {
    return value.map((item) => sourceSelectOptionValue(field, item) ?? String(item)).join(", ");
  }
  if (field?.type === "file" && Array.isArray(value)) {
    return value.map((file) => String(file?.visible_name ?? file?.original_name ?? file?.name ?? "")).filter(Boolean).join(", ");
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function mapTemplateLinkRows(oldField: any, value: unknown, tablesByOldId: SourceTableMap): Array<{ id: number; value: string }> {
  const targetTableId = Number(oldField.link_row_table_id || oldField.link_row_table || 0);
  const targetTable = tablesByOldId.get(targetTableId);
  const targetPrimary = targetTable ? primarySourceField(targetTable) : null;
  const links: Array<{ id: number; value: string }> = [];
  const seen = new Set<number>();
  for (const raw of Array.isArray(value) ? value : [value]) {
    const id = Number(raw && typeof raw === "object" ? (raw as Record<string, unknown>).id : raw);
    if (!Number.isInteger(id) || id <= 0 || seen.has(id)) continue;
    seen.add(id);
    const existingValue = raw && typeof raw === "object" ? (raw as Record<string, unknown>).value : undefined;
    const sourceRow = targetTable ? sourceRowById(targetTable, id) : null;
    const primaryValue = targetPrimary && sourceRow ? sourceCellDisplayValue(targetPrimary, sourceRow[`field_${targetPrimary.id}`]) : String(existingValue ?? id);
    links.push({ id, value: String(existingValue ?? primaryValue ?? "") });
  }
  return links;
}

function templateVirtualWorkspaceId(templateId: number) {
  return -templateId;
}

function stableHash(value: unknown) {
  const text = JSON.stringify(value);
  let hash = 0;
  for (let i = 0; i < text.length; i++) hash = Math.imul(31, hash) + text.charCodeAt(i) | 0;
  return String(hash >>> 0);
}

function inferMimeType(name: string) {
  const ext = name.split(".").pop()?.toLowerCase() || "";
  const mimes: Record<string, string> = {
    avif: "image/avif",
    bmp: "image/bmp",
    csv: "text/csv",
    gif: "image/gif",
    jpeg: "image/jpeg",
    jpg: "image/jpeg",
    json: "application/json",
    pdf: "application/pdf",
    png: "image/png",
    svg: "image/svg+xml",
    txt: "text/plain",
    webp: "image/webp",
  };
  return mimes[ext] || "application/octet-stream";
}

function collectTemplateFileNames(source: any) {
  const names = new Set<string>();
  for (const app of source.export || []) {
    for (const table of app.tables || []) {
      const fileFieldIds = new Set(
        (table.fields || [])
          .filter((field: any) => field.type === "file")
          .map((field: any) => field.id)
      );
      for (const row of table.rows || []) {
        for (const fieldId of fileFieldIds) {
          const value = row[`field_${fieldId}`];
          if (!Array.isArray(value)) continue;
          for (const file of value) {
            if (file?.name) names.add(String(file.name));
          }
        }
      }
    }
  }
  return names;
}

async function ensureTemplateAssets(env: Env, slug: string, source: any, importedAt: string): Promise<AssetMetaMap> {
  const requiredNames = collectTemplateFileNames(source);
  const assets: AssetMetaMap = new Map();
  if (requiredNames.size === 0) return assets;

  const zip = await env.FILES.get(`${TEMPLATE_SOURCE_PREFIX}/${slug}.zip`);
  if (!zip) return assets;

  const files = unzipSync(new Uint8Array(await zip.arrayBuffer()));
  const writes: Promise<unknown>[] = [];
  for (const [name, bytes] of Object.entries(files)) {
    if (!requiredNames.has(name)) continue;
    const mimeType = inferMimeType(name);
    const isImage = mimeType.startsWith("image/");
    const key = `user_files/${name}`;
    assets.set(name, { size: bytes.byteLength, mimeType, isImage });
    writes.push(env.FILES.put(key, bytes, {
      httpMetadata: {
        contentType: mimeType,
        contentDisposition: `inline; filename="${name}"`,
      },
      customMetadata: {
        originalName: name,
        generatedName: name,
        template: slug,
      },
    }));
    writes.push(env.DB.prepare(
      `INSERT OR IGNORE INTO core_userfile
       (user_id, name, original_name, r2_key, size, mime_type, is_image, image_width, image_height, uploaded_at)
       VALUES (NULL, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)`
    ).bind(name, name, key, bytes.byteLength, mimeType, isImage ? 1 : 0, importedAt).run());
  }
  await Promise.all(writes);
  return assets;
}

export function templateById(id: number) {
  return TEMPLATE_MANIFEST.find((template) => template.id === id) || null;
}

export function templateBySlug(slug: string) {
  return TEMPLATE_MANIFEST.find((template) => template.slug === slug) || null;
}

export function isTemplateVirtualWorkspaceId(workspaceId: number) {
  return workspaceId < 0 && templateById(Math.abs(workspaceId)) !== null;
}

/**
 * SQL expression (0 or 1) telling whether the workspace in `workspaceIdColumn`
 * holds an installed template, so access checks can read it with the object
 * they load instead of a separate isTemplateWorkspace round trip. The column
 * must be qualified (`a.workspace_id`): a bare name would resolve to the
 * template's own column and match every workspace.
 */
export function templateWorkspaceSql(workspaceIdColumn: string) {
  if (!/^\w+\.\w+$/.test(workspaceIdColumn)) throw new Error(`Qualify the workspace column: ${workspaceIdColumn}`);
  return `EXISTS (SELECT 1 FROM core_template template WHERE template.workspace_id=${workspaceIdColumn})`;
}

export async function isTemplateWorkspace(db: D1Database, workspaceId: number) {
  if (workspaceId < 0) return isTemplateVirtualWorkspaceId(workspaceId);
  const row = await db.prepare("SELECT id FROM core_template WHERE workspace_id=?")
    .bind(workspaceId)
    .first<{ id: number }>();
  return Boolean(row);
}

function serializeTemplate(meta: TemplateManifestItem, row?: any) {
  return {
    id: meta.id,
    name: meta.name,
    slug: meta.slug,
    icon: meta.icon,
    keywords: meta.keywords,
    workspace_id: row?.workspace_id || templateVirtualWorkspaceId(meta.id),
    is_default: meta.slug === DEFAULT_TEMPLATE_SLUG,
    open_application: row?.open_application || null,
  };
}

export async function listTemplateCategories(db: D1Database) {
  const rows = await db.prepare("SELECT id, workspace_id, open_application FROM core_template")
    .all<any>()
    .catch(() => ({ results: [] as any[] }));
  const synced = new Map((rows.results || []).map((row: any) => [row.id, row]));
  const categoryMap = new Map<string, { id: number; name: string; templates: object[] }>();
  let categoryId = 1;
  for (const meta of TEMPLATE_MANIFEST) {
    for (const name of meta.categories) {
      if (!categoryMap.has(name)) categoryMap.set(name, { id: categoryId++, name, templates: [] });
      categoryMap.get(name)!.templates.push(serializeTemplate(meta, synced.get(meta.id)));
    }
  }
  return Array.from(categoryMap.values()).sort((a, b) => a.name.localeCompare(b.name));
}

export async function getTemplateSerialized(env: Env, slug: string) {
  const meta = templateBySlug(slug);
  if (!meta) throw new DoesNotExist("Template", slug);
  const row = await env.DB.prepare("SELECT * FROM core_template WHERE id=?").bind(meta.id).first<any>();
  return serializeTemplate(meta, row);
}

async function loadTemplateSource(env: Env, slug: string) {
  const object = await env.FILES.get(`${TEMPLATE_SOURCE_PREFIX}/${slug}.json`);
  if (!object) throw new DoesNotExist("Template file", slug);
  return JSON.parse(await object.text());
}

async function fieldSettings(
  db: D1Database,
  workspaceId: number,
  field: any,
  tableMap: IdMap,
  fieldMap: IdMap,
  selectOptionMap: IdMap
) {
  let settings: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(field)) {
    if (!BASE_FIELD_KEYS.has(key)) settings[key] = value;
  }
  if (typeof settings.link_row_table_id === "number") {
    settings.link_row_table_id = tableMap.get(settings.link_row_table_id) || settings.link_row_table_id;
  }
  if (typeof settings.link_row_related_field_id === "number") {
    settings.link_row_related_field_id = fieldMap.get(settings.link_row_related_field_id) || settings.link_row_related_field_id;
  }
  for (const key of ["through_field_id", "target_field_id"]) {
    if (typeof settings[key] === "number") settings[key] = fieldMap.get(settings[key] as number) || settings[key];
  }
  if (Array.isArray(settings.select_options)) {
    settings.select_options = settings.select_options.map((option: any) => ({
      ...option,
      id: selectOptionMap.get(option.id) || option.id,
    }));
  }
  if (field.type === "ai") {
    settings = remapAIFieldSettings(settings, fieldMap);
    settings = await disableInvalidAIAutoUpdateUser(db, workspaceId, settings);
  }
  return Object.keys(settings).length ? JSON.stringify(settings) : null;
}

function serializeTemplateFile(env: Env, file: any, assets: AssetMetaMap, importedAt: string) {
  const name = String(file.name || file.original_name || file.visible_name || "");
  if (!name) return file;
  const asset = assets.get(name);
  const mimeType = file.mime_type || asset?.mimeType || inferMimeType(name);
  const isImage = file.is_image ?? asset?.isImage ?? mimeType.startsWith("image/");
  const key = `user_files/${name}`;
  const url = file.url || buildPublicUrl(env, key);
  return {
    ...file,
    name,
    visible_name: file.visible_name || file.original_name || name,
    original_name: file.original_name || file.visible_name || name,
    url,
    thumbnails: isImage
      ? {
          tiny: { url: `${url}?thumbnail=tiny`, width: 21, height: 21 },
          small: { url: `${url}?thumbnail=small`, width: 48, height: 48 },
          card_cover: { url: `${url}?thumbnail=card_cover`, width: 300, height: 160 },
        }
      : null,
    size: file.size ?? asset?.size ?? 0,
    mime_type: mimeType,
    is_image: Boolean(isImage),
    image_width: file.image_width ?? null,
    image_height: file.image_height ?? null,
    uploaded_at: file.uploaded_at || importedAt,
  };
}

function mapFieldValue(
  env: Env,
  oldField: any,
  value: unknown,
  selectOptionValues: SelectOptionValueMap,
  assets: AssetMetaMap,
  importedAt: string,
  tablesByOldId: SourceTableMap
) {
  const type = oldField.type as FieldType;
  if (value === null || value === undefined) return null;
  if (type === "single_select") {
    return serializeFieldValueForInsert(type, mapTemplateSelectOption(oldField, value, selectOptionValues));
  }
  if (type === "multiple_select") {
    const options = (Array.isArray(value) ? value : [value])
      .map((item) => mapTemplateSelectOption(oldField, item, selectOptionValues))
      .filter((option): option is SelectOptionValue => option !== null);
    return serializeFieldValueForInsert(type, options);
  }
  if (type === "link_row") {
    return serializeFieldValueForInsert(type, mapTemplateLinkRows(oldField, value, tablesByOldId));
  }
  if (type === "file" && Array.isArray(value)) {
    return JSON.stringify(value.map((file) => serializeTemplateFile(env, file, assets, importedAt)));
  }
  return serializeFieldValueForInsert(type, value);
}

async function importDatabaseApplication(
  env: Env,
  workspaceId: number,
  app: any,
  importedAt: string,
  appId: number | undefined,
  assets: AssetMetaMap
) {
  const db = env.DB;
  const application = appId
    ? await db.prepare("SELECT * FROM core_application WHERE id=?").bind(appId).first<any>()
    : await db.prepare(
      `INSERT INTO core_application (workspace_id, name, type, [order], trashed, created_on, updated_on)
       VALUES (?, ?, 'database', ?, 0, ?, ?) RETURNING *`
    ).bind(workspaceId, app.name, app.order || 1, importedAt, importedAt).first<any>();
  if (!application) throw new Error("Failed to import database application");

  const tableMap: IdMap = new Map();
  const fieldMap: IdMap = new Map();
  const fieldTypeByOldId = new Map<number, FieldType>();
  const selectOptionMap: IdMap = new Map();
  const selectOptionValues: SelectOptionValueMap = new Map();
  const tablesByOldId = sourceTableMap(app);

  for (const oldTable of app.tables || []) {
    const table = await db.prepare(
      `INSERT INTO database_table (database_id, name, [order], version, trashed, created_on, updated_on,
       needs_background_update_column_added, last_modified_by_column_added, created_by_column_added)
       VALUES (?, ?, ?, 1, 0, ?, ?, 0, 0, 0) RETURNING *`
    ).bind(application.id, oldTable.name, oldTable.order || 1, importedAt, importedAt).first<any>();
    if (!table) throw new Error("Failed to import template table");
    tableMap.set(oldTable.id, table.id);
    await getOrCreateUserTable(db, table.id);
  }

  for (const oldTable of app.tables || []) {
    const tableId = tableMap.get(oldTable.id)!;
    for (const oldField of oldTable.fields || []) {
      const field = await db.prepare(
        `INSERT INTO database_field
         (table_id, name, type, [order], "primary", read_only, trashed, description, db_index,
          immutable_type, immutable_properties, field_settings, created_on, updated_on)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, NULL, ?, ?) RETURNING *`
      ).bind(
        tableId,
        oldField.name,
        oldField.type,
        oldField.order || 0,
        oldField.primary ? 1 : 0,
        oldField.read_only ? 1 : 0,
        oldField.description || null,
        oldField.db_index ? 1 : 0,
        oldField.immutable_type ? 1 : 0,
        oldField.immutable_properties ? 1 : 0,
        importedAt,
        importedAt
      ).first<any>();
      if (!field) throw new Error("Failed to import template field");
      fieldMap.set(oldField.id, field.id);
      fieldTypeByOldId.set(oldField.id, oldField.type);
      await addFieldColumn(db, tableId, { id: field.id, type: field.type as FieldType, primary: Boolean(field.primary) });

      for (const option of oldField.select_options || []) {
        const newOption = await db.prepare(
          "INSERT INTO database_selectoption (field_id, value, color, [order]) VALUES (?, ?, ?, ?) RETURNING id"
        ).bind(field.id, option.value, option.color || "blue", option.order || 0).first<{ id: number }>();
        if (newOption) {
          const color = option.color || "blue";
          selectOptionMap.set(option.id, newOption.id);
          selectOptionValues.set(option.id, { id: newOption.id, value: String(option.value ?? ""), color });
        }
      }
    }
  }

  for (const oldTable of app.tables || []) {
    for (const oldField of oldTable.fields || []) {
      await db.prepare("UPDATE database_field SET field_settings=? WHERE id=?")
        .bind(await fieldSettings(db, workspaceId, oldField, tableMap, fieldMap, selectOptionMap), fieldMap.get(oldField.id))
        .run();
    }
  }

  for (const oldTable of app.tables || []) {
    for (const oldField of oldTable.fields || []) {
      const fieldId = fieldMap.get(oldField.id);
      if (fieldId) await synchronizeFieldDependencies(db, fieldId);
    }
  }

  for (const oldTable of app.tables || []) {
    const tableId = tableMap.get(oldTable.id)!;
    for (const oldView of oldTable.views || []) {
      const viewType = oldView.type === "survey" ? "form" : oldView.type || "grid";
      const view = await db.prepare(
        `INSERT INTO database_view (table_id, name, type, [order], filter_type, filters_disabled, public, allow_public_export,
         public_view_password, slug, trashed, created_on, updated_on, row_identifier_type,
         ownership_type, row_height_size, card_cover_image_field, single_select_field, date_field,
         ical_public, ical_slug, start_date_field, end_date_field, timescale)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING *`
      ).bind(
        tableId,
        oldView.name,
        viewType,
        oldView.order || 1,
        oldView.filter_type || "AND",
        oldView.filters_disabled ? 1 : 0,
        oldView.public ? 1 : 0,
        oldView.allow_public_export ? 1 : 0,
        crypto.randomUUID().replace(/-/g, "").slice(0, 20),
        importedAt,
        importedAt,
        oldView.row_identifier_type || "count",
        oldView.ownership_type || "collaborative",
        oldView.row_height_size || "small",
        mappedId(viewFieldReference(oldView, "card_cover_image_field"), fieldMap),
        mappedId(viewFieldReference(oldView, "single_select_field"), fieldMap),
        mappedId(viewFieldReference(oldView, "date_field"), fieldMap),
        oldView.ical_public ? 1 : 0,
        oldView.ical_slug ? crypto.randomUUID().replace(/-/g, "").slice(0, 20) : null,
        mappedId(viewFieldReference(oldView, "start_date_field"), fieldMap),
        mappedId(viewFieldReference(oldView, "end_date_field"), fieldMap),
        oldView.timescale || "month"
      ).first<any>();
      if (!view) continue;

      const viewGroupMap = new Map<number, number>();
      for (const group of oldView.filter_groups || []) {
        const sourceId = Number(group.id || 0);
        const parentSourceId = group.parent_group_id ?? group.parent_group;
        const parentId = parentSourceId ? viewGroupMap.get(Number(parentSourceId)) ?? null : null;
        const inserted = await db.prepare(
          "INSERT INTO database_viewfiltergroup (view_id, parent_group_id, filter_type) VALUES (?, ?, ?) RETURNING id"
        ).bind(view.id, parentId, group.filter_type || "AND").first<{ id: number }>();
        if (inserted?.id && sourceId > 0) viewGroupMap.set(sourceId, inserted.id);
      }
      for (const filter of oldView.filters || []) {
        const oldFieldId = filter.field_id ?? filter.field;
        const newFieldId = mappedId(oldFieldId, fieldMap);
        if (!newFieldId) continue;
        const type = fieldTypeByOldId.get(Number(oldFieldId));
        const value = type === "single_select" || type === "multiple_select"
          ? stringifyJson(remapSelectValue(filter.value ?? "", selectOptionMap)) ?? ""
          : String(filter.value ?? "");
        const groupSourceId = filter.group_id ?? filter.group;
        await db.prepare(
          "INSERT INTO database_viewfilter (view_id, field_id, type, value, preload_values, group_id) VALUES (?, ?, ?, ?, ?, ?)"
        )
          .bind(
            view.id,
            newFieldId,
            filter.type,
            value,
            stringifyJson(remapJsonReferences(parseJson(filter.preload_values || {}), { fields: fieldMap, selectOptions: selectOptionMap })) || "{}",
            groupSourceId ? viewGroupMap.get(Number(groupSourceId)) ?? null : null
          )
          .run();
      }
      for (const sort of oldView.sortings || []) {
        const fieldId = mappedId(sort.field_id ?? sort.field, fieldMap);
        if (!fieldId) continue;
        await db.prepare("INSERT INTO database_viewsort (view_id, field_id, [order], type) VALUES (?, ?, ?, ?)")
          .bind(view.id, fieldId, sort.order || "ASC", sort.type || "default")
          .run();
      }
      for (const groupBy of oldView.group_bys || []) {
        const fieldId = mappedId(groupBy.field_id ?? groupBy.field, fieldMap);
        if (!fieldId) continue;
        await db.prepare("INSERT INTO database_viewgroupby (view_id, field_id, [order], width, type) VALUES (?, ?, ?, ?, ?)")
          .bind(view.id, fieldId, groupBy.order || "ASC", groupBy.width || 200, groupBy.type || "default")
          .run();
      }

      const fieldOptions = normalizeFieldOptions(oldView.field_options);
      if (viewType === "gallery") {
        for (const opts of fieldOptions) {
          const newFieldId = mappedId(opts.field_id ?? opts.field, fieldMap);
          if (!newFieldId) continue;
          await db.prepare(
            "INSERT OR IGNORE INTO database_galleryviewfieldoptions (gallery_view_id, field_id, hidden, [order]) VALUES (?, ?, ?, ?)"
          ).bind(view.id, newFieldId, opts.hidden ? 1 : 0, opts.order ?? 32767).run();
        }
      } else if (viewType === "form") {
        await db.prepare(
          `INSERT OR REPLACE INTO database_formview
           (view_ptr_id, title, description, submit_text, submit_action, submit_action_message,
            submit_action_redirect_url, mode, show_logo, cover_image, logo_image)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          view.id,
          oldView.title || "",
          oldView.description || "",
          oldView.submit_text || "Submit",
          oldView.submit_action || "MESSAGE",
          oldView.submit_action_message || "",
          oldView.submit_action_redirect_url || "",
          oldView.mode === "survey" || oldView.type === "survey" ? "survey" : "form",
          oldView.show_logo === false || oldView.show_logo === 0 ? 0 : 1,
          stringifyJson(oldView.cover_image) || null,
          stringifyJson(oldView.logo_image) || null
        ).run();

        const formOptionMap = new Map<number, number>();
        const formGroupMap = new Map<number, number>();
        for (const opts of fieldOptions) {
          const sourceOptionId = Number(opts.id || 0);
          const newFieldId = mappedId(opts.field_id ?? opts.field, fieldMap);
          if (!newFieldId) continue;
          const inserted = await db.prepare(
            `INSERT INTO database_formviewfieldoptions
             (form_view_id, field_id, name, description, enabled, required, [order],
              show_when_matching_conditions, condition_type, include_all_select_options, field_component)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
          ).bind(
            view.id,
            newFieldId,
            opts.name || "",
            opts.description || "",
            opts.enabled ? 1 : 0,
            opts.required ? 1 : 0,
            opts.order ?? 32767,
            opts.show_when_matching_conditions ? 1 : 0,
            opts.condition_type || "AND",
            opts.include_all_select_options === false || opts.include_all_select_options === 0 ? 0 : 1,
            opts.field_component || "default"
          ).first<{ id: number }>();
          if (inserted?.id && sourceOptionId > 0) formOptionMap.set(sourceOptionId, inserted.id);
        }

        for (const opts of fieldOptions) {
          const targetOptionId = formOptionMap.get(Number(opts.id || 0));
          if (!targetOptionId) continue;
          for (const raw of opts.allowed_select_options || []) {
            const rawId = typeof raw === "object" ? raw.select_option_id ?? raw.id : raw;
            const selectOptionId = mappedId(rawId, selectOptionMap);
            if (!selectOptionId) continue;
            await db.prepare(
              `INSERT OR IGNORE INTO database_formviewfieldoptions_allowedselectoptions
               (form_view_field_options_id, select_option_id)
               VALUES (?, ?)`
            ).bind(targetOptionId, selectOptionId).run();
          }
          for (const group of opts.condition_groups || []) {
            const sourceId = Number(group.id || 0);
            const parentSourceId = group.parent_group_id ?? group.parent_group;
            const parentId = parentSourceId ? formGroupMap.get(Number(parentSourceId)) ?? null : null;
            const inserted = await db.prepare(
              `INSERT INTO database_formviewfieldoptionsconditiongroup
               (field_option_id, filter_type, parent_group_id)
               VALUES (?, ?, ?) RETURNING id`
            ).bind(targetOptionId, group.filter_type || "AND", parentId).first<{ id: number }>();
            if (inserted?.id && sourceId > 0) formGroupMap.set(sourceId, inserted.id);
          }
        }
        for (const opts of fieldOptions) {
          const targetOptionId = formOptionMap.get(Number(opts.id || 0));
          if (!targetOptionId) continue;
          for (const condition of opts.conditions || []) {
            const oldFieldId = condition.field_id ?? condition.field;
            const newFieldId = mappedId(oldFieldId, fieldMap);
            if (!newFieldId) continue;
            const type = fieldTypeByOldId.get(Number(oldFieldId));
            const value = type === "single_select" || type === "multiple_select"
              ? stringifyJson(remapSelectValue(condition.value ?? "", selectOptionMap)) ?? ""
              : String(condition.value ?? "");
            const groupSourceId = condition.group_id ?? condition.group;
            await db.prepare(
              `INSERT INTO database_formviewfieldoptionscondition
               (field_option_id, field_id, type, value, group_id)
               VALUES (?, ?, ?, ?, ?)`
            ).bind(
              targetOptionId,
              newFieldId,
              condition.type || "contains",
              value,
              groupSourceId ? formGroupMap.get(Number(groupSourceId)) ?? null : null
            ).run();
          }
        }
      } else {
        for (const opts of fieldOptions) {
          const newFieldId = mappedId(opts.field_id ?? opts.field, fieldMap);
          if (!newFieldId) continue;
          await db.prepare(
            `INSERT OR IGNORE INTO database_gridviewfieldoptions
             (grid_view_id, field_id, width, hidden, [order], aggregation_type, aggregation_raw_type)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
          ).bind(
            view.id,
            newFieldId,
            opts.width ?? 200,
            opts.hidden ? 1 : 0,
            opts.order ?? 32767,
            opts.aggregation_type || "",
            opts.aggregation_raw_type || ""
          ).run();
        }
      }

      for (const decoration of oldView.decorations || []) {
        await db.prepare(
          `INSERT INTO database_viewdecoration (view_id, type, value_provider_type, value_provider_conf, [order])
           VALUES (?, ?, ?, ?, ?)`
        ).bind(
          view.id,
          decoration.type,
          decoration.value_provider_type || "",
          stringifyJson(remapJsonReferences(decoration.value_provider_conf || {}, { fields: fieldMap, selectOptions: selectOptionMap })) || "{}",
          decoration.order ?? 1
        ).run();
      }
    }
  }

  for (const oldTable of app.tables || []) {
    const tableId = tableMap.get(oldTable.id)!;
    for (const oldRow of oldTable.rows || []) {
      const cols = ["id", "[order]", "_created_on", "_updated_on"];
      const vals: unknown[] = [oldRow.id, Number(oldRow.order || 10000), oldRow.created_on || importedAt, oldRow.updated_on || importedAt];
      for (const oldField of oldTable.fields || []) {
        const newFieldId = fieldMap.get(oldField.id);
        if (!newFieldId) continue;
        cols.push(`"field_${newFieldId}"`);
        vals.push(mapFieldValue(env, oldField, oldRow[`field_${oldField.id}`], selectOptionValues, assets, importedAt, tablesByOldId));
      }
      await db.prepare(`INSERT INTO "database_table_${tableId}" (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`)
        .bind(...vals)
        .run();
    }
  }

  return { application, tableMap, fieldMap };
}

async function importTemplate(env: Env, meta: TemplateManifestItem, source: any, existingWorkspaceId?: number | null) {
  const db = env.DB;
  const importedAt = now();
  const workspace = existingWorkspaceId
    ? await db.prepare("SELECT * FROM core_workspace WHERE id=?").bind(existingWorkspaceId).first<any>()
    : await db.prepare("INSERT INTO core_workspace (name, created_on, storage_usage, seats_taken) VALUES (?, ?, 0, 0) RETURNING *")
      .bind(source.name, importedAt)
      .first<any>();
  if (!workspace) throw new Error("Failed to create template workspace");

  const assets = await ensureTemplateAssets(env, meta.slug, source, importedAt);
  const oldToNewApplication = new Map<number, number>();
  for (const app of source.export || []) {
    const inserted = await db.prepare(
      `INSERT INTO core_application (workspace_id, name, type, [order], trashed, created_on, updated_on)
       VALUES (?, ?, ?, ?, 0, ?, ?) RETURNING *`
    ).bind(workspace.id, app.name, app.type || "database", app.order || 1, importedAt, importedAt).first<any>();
    if (!inserted) continue;
    oldToNewApplication.set(app.id, inserted.id);
    if (app.type === "database") {
      await importDatabaseApplication(env, workspace.id, app, importedAt, inserted.id, assets);
    } else {
      await db.prepare("INSERT OR REPLACE INTO core_applicationtemplatedata (application_id, data) VALUES (?, ?)")
        .bind(inserted.id, JSON.stringify(app))
        .run();
    }
  }

  const openApplication = meta.open_application ? oldToNewApplication.get(meta.open_application) || null : null;
  const hash = stableHash(source.export || []);
  await db.prepare(
    `INSERT INTO core_template (id, name, slug, icon, keywords, workspace_id, open_application, export_hash, synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name=excluded.name, slug=excluded.slug, icon=excluded.icon,
       keywords=excluded.keywords, workspace_id=excluded.workspace_id, open_application=excluded.open_application,
       export_hash=excluded.export_hash, synced_at=excluded.synced_at`
  ).bind(meta.id, meta.name, meta.slug, meta.icon, meta.keywords, workspace.id, openApplication, hash, importedAt).run();

  let categoryId = 1;
  const categoryIds = new Map<string, number>();
  for (const item of TEMPLATE_MANIFEST) {
    for (const name of item.categories) {
      if (!categoryIds.has(name)) categoryIds.set(name, categoryId++);
    }
  }
  for (const name of meta.categories) {
    const id = categoryIds.get(name)!;
    await db.prepare("INSERT OR IGNORE INTO core_templatecategory (id, name) VALUES (?, ?)").bind(id, name).run();
    await db.prepare("INSERT OR IGNORE INTO core_template_categories (template_id, category_id) VALUES (?, ?)").bind(meta.id, id).run();
  }

  return workspace.id;
}

export async function ensureTemplatePreview(env: Env, templateId: number) {
  const meta = templateById(templateId);
  if (!meta) throw new DoesNotExist("Template", templateId);
  const existing = await env.DB.prepare("SELECT * FROM core_template WHERE id=?").bind(meta.id).first<any>();
  if (existing?.workspace_id) return existing.workspace_id as number;
  const source = await loadTemplateSource(env, meta.slug);
  return importTemplate(env, meta, source, existing?.workspace_id);
}

export async function ensureTemplatePreviewByVirtualWorkspace(env: Env, workspaceId: number) {
  if (!isTemplateVirtualWorkspaceId(workspaceId)) return workspaceId;
  return ensureTemplatePreview(env, Math.abs(workspaceId));
}

export async function installTemplateIntoWorkspace(env: Env, workspaceId: number, templateId: number, userId: number) {
  const meta = templateById(templateId);
  if (!meta) throw new DoesNotExist("Template", templateId);
  await assertHasWorkspaceRole(env.DB, userId, workspaceId, "BUILDER");
  const source = await loadTemplateSource(env, meta.slug);
  const existing = await env.DB.prepare("SELECT * FROM core_template WHERE id=?").bind(meta.id).first<any>();
  if (!existing?.workspace_id) await importTemplate(env, meta, source, null);

  const importedAt = now();
  const assets = await ensureTemplateAssets(env, meta.slug, source, importedAt);
  const applications = [];
  for (const app of source.export || []) {
    if (app.type === "database") {
      const result = await importDatabaseApplication(env, workspaceId, app, importedAt, undefined, assets);
      applications.push(result.application);
    } else {
      const inserted = await env.DB.prepare(
        `INSERT INTO core_application (workspace_id, name, type, [order], trashed, created_on, updated_on)
         VALUES (?, ?, ?, ?, 0, ?, ?) RETURNING *`
      ).bind(workspaceId, app.name, app.type || "database", app.order || 1, importedAt, importedAt).first<any>();
      if (inserted) {
        await env.DB.prepare("INSERT OR REPLACE INTO core_applicationtemplatedata (application_id, data) VALUES (?, ?)")
          .bind(inserted.id, JSON.stringify(app))
          .run();
        applications.push(inserted);
      }
    }
  }
  return applications;
}
