import type { D1Database } from "@cloudflare/workers-types";
import type { FieldType } from "./dynamic-tables";
import { parseFieldSettings } from "./computed-fields";
import { extractFormulaFieldReferences, extractLookupReferences } from "./formula-types";

type DependencyField = {
  id: number;
  table_id: number;
  name: string;
  type: FieldType;
  is_primary: number | boolean;
  field_settings: string | null;
};

type Dependency = {
  dependencyId: number | null;
  viaId: number | null;
  brokenName: string | null;
};

const DEPENDANT_FIELD_TYPES = new Set<FieldType>(["formula", "count", "lookup", "rollup", "ai"]);

export async function synchronizeFieldDependencies(db: D1Database, fieldId: number): Promise<void> {
  await db.prepare("DELETE FROM database_fielddependency WHERE dependant_id=?").bind(fieldId).run();
  const dependant = await db.prepare(
    `SELECT id, table_id, name, type, "primary" AS is_primary, field_settings
     FROM database_field
     WHERE id=? AND trashed=0`
  ).bind(fieldId).first<DependencyField>();
  if (!dependant || !DEPENDANT_FIELD_TYPES.has(dependant.type)) return;

  const table = await db.prepare("SELECT database_id FROM database_table WHERE id=?")
    .bind(dependant.table_id)
    .first<{ database_id: number }>();
  if (!table) return;
  const fields = await db.prepare(
    `SELECT f.id, f.table_id, f.name, f.type, f."primary" AS is_primary, f.field_settings
     FROM database_field f
     JOIN database_table t ON t.id=f.table_id
     WHERE t.database_id=? AND f.trashed=0
     ORDER BY f.table_id ASC, f.[order] ASC, f.id ASC`
  ).bind(table.database_id).all<DependencyField>();
  const activeFields = fields.results || [];
  const settings = parseFieldSettings(dependant.field_settings);
  const dependencies: Dependency[] = [];

  if (dependant.type === "formula" || dependant.type === "ai") {
    const prompt = settings.ai_prompt && typeof settings.ai_prompt === "object" && !Array.isArray(settings.ai_prompt)
      ? (settings.ai_prompt as Record<string, unknown>).formula
      : settings.ai_prompt;
    const formula = dependant.type === "ai" ? String(prompt || "") : String(settings.formula || "");
    for (const reference of extractFormulaFieldReferences(formula)) {
      const referenced = reference.kind === "id"
        ? activeFields.find((field) => field.id === reference.value && field.table_id === dependant.table_id)
        : activeFields.find((field) => field.table_id === dependant.table_id && field.name.toLowerCase() === reference.value.toLowerCase());
      if (!referenced) {
        dependencies.push({ dependencyId: null, viaId: null, brokenName: String(reference.value) });
      } else {
        dependencies.push(resolveDirectDependency(referenced, activeFields));
      }
    }
    if (dependant.type === "ai") {
      const runtimeReference = /\bget\s*\(\s*(['"])fields\.field_(\d+)\1\s*\)/gi;
      let match: RegExpExecArray | null;
      while ((match = runtimeReference.exec(formula))) {
        const referenced = activeFields.find((field) => field.id === Number(match![2]));
        if (referenced) dependencies.push(resolveDirectDependency(referenced, activeFields));
      }
      const fileFieldId = Number(settings.ai_file_field_id || 0);
      const fileField = activeFields.find((field) => field.id === fileFieldId && field.table_id === dependant.table_id);
      if (fileField) dependencies.push(resolveDirectDependency(fileField, activeFields));
    }
    for (const reference of dependant.type === "formula" ? extractLookupReferences(formula) : []) {
      dependencies.push(resolveLinkedDependency(
        dependant.table_id,
        reference.throughFieldName,
        reference.targetFieldName,
        activeFields
      ));
    }
  } else {
    const throughFieldId = Number(settings.through_field_id || 0);
    const through = activeFields.find((field) => field.id === throughFieldId && field.table_id === dependant.table_id);
    if (!through || through.type !== "link_row") {
      dependencies.push({ dependencyId: null, viaId: null, brokenName: String(settings.through_field_name || "") || null });
    } else if (dependant.type === "count") {
      dependencies.push(resolveDirectDependency(through, activeFields));
    } else {
      const targetFieldId = Number(settings.target_field_id || 0);
      const target = activeFields.find((field) => field.id === targetFieldId);
      dependencies.push(target
        ? { dependencyId: target.id, viaId: through.id, brokenName: null }
        : { dependencyId: null, viaId: through.id, brokenName: String(settings.target_field_name || "") || null });
    }
  }

  const unique = new Map<string, Dependency>();
  for (const dependency of dependencies) {
    if (dependency.dependencyId === null && !dependency.brokenName) continue;
    unique.set(`${dependency.dependencyId ?? ""}:${dependency.viaId ?? ""}:${dependency.brokenName ?? ""}`, dependency);
  }
  const statements = [...unique.values()].map((dependency) => db.prepare(
    `INSERT INTO database_fielddependency
     (dependant_id, dependency_id, via_id, broken_reference_field_name)
     VALUES (?, ?, ?, ?)`
  ).bind(fieldId, dependency.dependencyId, dependency.viaId, dependency.brokenName));
  if (statements.length > 0) await db.batch(statements);
}

function resolveDirectDependency(referenced: DependencyField, fields: DependencyField[]): Dependency {
  if (referenced.type !== "link_row") {
    return { dependencyId: referenced.id, viaId: null, brokenName: null };
  }
  const settings = parseFieldSettings(referenced.field_settings);
  const targetTableId = Number(settings.link_row_table_id || 0);
  const targetPrimary = fields.find((field) => field.table_id === targetTableId && Boolean(field.is_primary));
  return targetPrimary
    ? { dependencyId: targetPrimary.id, viaId: referenced.id, brokenName: null }
    : { dependencyId: referenced.id, viaId: null, brokenName: null };
}

function resolveLinkedDependency(
  sourceTableId: number,
  throughFieldName: string,
  targetFieldName: string,
  fields: DependencyField[]
): Dependency {
  const through = fields.find((field) =>
    field.table_id === sourceTableId &&
    field.type === "link_row" &&
    field.name.toLowerCase() === throughFieldName.toLowerCase()
  );
  if (!through) return { dependencyId: null, viaId: null, brokenName: throughFieldName };
  const settings = parseFieldSettings(through.field_settings);
  const targetTableId = Number(settings.link_row_table_id || 0);
  const target = fields.find((field) =>
    field.table_id === targetTableId && field.name.toLowerCase() === targetFieldName.toLowerCase()
  );
  return target
    ? { dependencyId: target.id, viaId: through.id, brokenName: null }
    : { dependencyId: null, viaId: through.id, brokenName: targetFieldName };
}
