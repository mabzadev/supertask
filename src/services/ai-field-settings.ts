function remapId(value: unknown, fieldMap: Map<number, number>): unknown {
  const id = Number(value);
  return Number.isFinite(id) && fieldMap.has(id) ? fieldMap.get(id) : value;
}

export function remapRuntimeFieldReferences(value: unknown, fieldMap: Map<number, number>): unknown {
  if (typeof value === "string") {
    return value.replace(/\bfields\.field_(\d+)\b/g, (match, rawId) => {
      const fieldId = Number(rawId);
      return fieldMap.has(fieldId) ? `fields.field_${fieldMap.get(fieldId)}` : match;
    });
  }
  if (Array.isArray(value)) return value.map((item) => remapRuntimeFieldReferences(item, fieldMap));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [
    key,
    remapRuntimeFieldReferences(item, fieldMap),
  ]));
}

export function remapAIFieldSettings(
  settings: Record<string, unknown>,
  fieldMap: Map<number, number>
): Record<string, unknown> {
  const remapped = remapRuntimeFieldReferences(settings, fieldMap) as Record<string, unknown>;
  if (remapped.ai_file_field_id !== null && remapped.ai_file_field_id !== undefined) {
    remapped.ai_file_field_id = remapId(remapped.ai_file_field_id, fieldMap);
  }
  return remapped;
}

export async function disableInvalidAIAutoUpdateUser(
  db: D1Database,
  workspaceId: number,
  settings: Record<string, unknown>
): Promise<Record<string, unknown>> {
  if (settings.ai_auto_update !== true) return settings;
  const userId = Number(settings.ai_auto_update_user_id || 0);
  const member = userId > 0
    ? await db.prepare(
      `SELECT 1 AS allowed
       FROM core_workspaceuser wu
       JOIN auth_user u ON u.id=wu.user_id
       LEFT JOIN core_userprofile p ON p.user_id=u.id
       WHERE wu.workspace_id=? AND wu.user_id=? AND wu.to_be_deleted=0
         AND u.is_active=1 AND COALESCE(p.to_be_deleted, 0)=0`
    ).bind(workspaceId, userId).first<{ allowed: number }>()
    : null;
  if (member) return settings;
  return { ...settings, ai_auto_update: false, ai_auto_update_user_id: null };
}
