import type { D1Database } from "@cloudflare/workers-types";
import { serializeFieldValueForInsert, type FieldMeta } from "./dynamic-tables";
import { serializeFieldValueForStorage } from "./field-values";

export type CreateUser = {
  id: number;
  email?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
} | null;

export function fieldDefaultInputValue(field: FieldMeta): unknown {
  const settings = field.settings || {};
  switch (field.type) {
    case "text":
      return settings.text_default !== undefined && settings.text_default !== "" ? settings.text_default : undefined;
    case "number":
      return settings.number_default !== undefined && settings.number_default !== null && settings.number_default !== ""
        ? settings.number_default
        : undefined;
    case "rating":
      return 0;
    case "boolean":
      return settings.boolean_default === true;
    case "single_select":
      return settings.single_select_default !== undefined && settings.single_select_default !== null
        ? settings.single_select_default
        : undefined;
    case "multiple_select":
      return Array.isArray(settings.multiple_select_default) && settings.multiple_select_default.length > 0
        ? settings.multiple_select_default
        : undefined;
    default:
      return undefined;
  }
}

export async function resolveCreateUser(db: D1Database, user: CreateUser | number | null | undefined): Promise<CreateUser> {
  if (!user) return null;
  if (typeof user !== "number") return user;
  return db.prepare(
    `SELECT id, email, username, first_name, last_name
     FROM auth_user
     WHERE id=?`
  ).bind(user).first<NonNullable<CreateUser>>();
}

export function createUserCell(user: CreateUser): object | null {
  if (!user) return null;
  const fullName = `${user.first_name || ""} ${user.last_name || ""}`.trim();
  return {
    id: user.id,
    name: fullName || user.username || user.email || String(user.id),
    email: user.email || "",
  };
}

export async function missingCreateFieldValues(
  db: D1Database,
  fields: FieldMeta[],
  existingFieldIds: Set<number>,
  options: {
    now: string;
    user?: CreateUser | number | null;
    fileContext?: unknown;
    workspaceId?: number | null;
  }
): Promise<Map<number, unknown>> {
  const values = new Map<number, unknown>();
  const resolvedUser = await resolveCreateUser(db, options.user);
  for (const field of fields) {
    if (existingFieldIds.has(field.id) || field.type === "autonumber" || field.type === "auto_number") continue;
    let value: unknown = undefined;
    if (field.type === "uuid") value = crypto.randomUUID();
    if (field.type === "created_on" || field.type === "last_modified") value = options.now;
    if (field.type === "created_by" || field.type === "last_modified_by") value = createUserCell(resolvedUser);
    if (value !== undefined) {
      values.set(field.id, serializeFieldValueForInsert(field.type, value));
      continue;
    }
    const defaultValue = fieldDefaultInputValue(field);
    if (defaultValue !== undefined) {
      values.set(field.id, await serializeFieldValueForStorage(
        db,
        field,
        defaultValue,
        options.fileContext as any,
        options.workspaceId
      ));
    }
  }
  return values;
}
