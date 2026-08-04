import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

describe("foreign key indexes", () => {
  it("covers every foreign key with a full leading index", () => {
    const database = new DatabaseSync(":memory:");
    database.exec("PRAGMA foreign_keys=ON");
    const migrations = readdirSync(join(process.cwd(), "migrations"))
      .filter((file) => /^\d+_.+\.sql$/.test(file))
      .sort();
    for (const migration of migrations) {
      database.exec(readFileSync(join(process.cwd(), "migrations", migration), "utf8"));
    }

    const tables = database.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    ).all() as Array<{ name: string }>;
    const missing: string[] = [];

    for (const { name: table } of tables) {
      const escapedTable = quoteIdentifier(table);
      const foreignKeys = database.prepare(`PRAGMA foreign_key_list(${escapedTable})`).all() as Array<{
        id: number;
        seq: number;
        table: string;
        from: string;
      }>;
      const grouped = new Map<number, typeof foreignKeys>();
      for (const foreignKey of foreignKeys) {
        const group = grouped.get(foreignKey.id) || [];
        group.push(foreignKey);
        grouped.set(foreignKey.id, group);
      }

      const indexes = (database.prepare(`PRAGMA index_list(${escapedTable})`).all() as Array<{
        name: string;
        partial: number;
      }>)
        .filter((index) => Number(index.partial) === 0)
        .map((index) => (
          database.prepare(`PRAGMA index_info(${quoteIdentifier(index.name)})`).all() as Array<{ name: string }>
        ).map((column) => column.name));
      const columns = database.prepare(`PRAGMA table_info(${escapedTable})`).all() as Array<{
        name: string;
        type: string;
        pk: number;
      }>;

      for (const group of grouped.values()) {
        group.sort((left, right) => left.seq - right.seq);
        const childColumns = group.map((foreignKey) => foreignKey.from);
        const integerPrimaryKey = childColumns.length === 1 && columns.some((column) => (
          column.name === childColumns[0]
          && Number(column.pk) === 1
          && column.type.toUpperCase() === "INTEGER"
        ));
        const indexed = indexes.some((indexColumns) => (
          childColumns.every((column, position) => indexColumns[position] === column)
        ));
        if (!integerPrimaryKey && !indexed) {
          missing.push(`${table}(${childColumns.join(",")}) -> ${group[0].table}`);
        }
      }
    }

    expect(missing).toEqual([]);
  });
});
