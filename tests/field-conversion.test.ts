import { describe, expect, it } from "vitest";
import {
  coerceValueForFieldType,
  convertExistingFieldValues,
  multipleSelectTextValue,
  parseMultipleSelectText,
  valueForFieldConversion,
} from "../src/services/field-conversion";
import { serializeFieldValueForStorage } from "../src/services/field-values";
import type { FieldMeta } from "../src/services/dynamic-tables";

function conversionDb(rowsInput?: Array<Record<string, unknown>>) {
  const rows = rowsInput || [
    { id: 1, value: "Ready", _created_on: "2026-01-01T00:00:00.000Z", _updated_on: "2026-01-02T00:00:00.000Z" },
    { id: 2, value: "Blocked", _created_on: "2026-01-03T00:00:00.000Z", _updated_on: "2026-01-04T00:00:00.000Z" },
  ];
  const updates: Array<{ sql: string; args: unknown[] }> = [];
  const optionInserts: Array<{ sql: string; args: unknown[] }> = [];
  const options = [
    { id: 10, field_id: 1, value: "Ready", color: "light-green", order: 1 },
    { id: 11, field_id: 1, value: "Blocked", color: "light-red", order: 2 },
  ];
  const users = [
    { id: 7, username: "user@example.com", first_name: "User", last_name: "Example", email: "user@example.com" },
  ];
  const activeRows = () => rows.filter((row) => Number(row.trashed || 0) === 0);

  return {
    updates,
    prepare(sql: string) {
      return {
        async all() {
          if (sql.includes("PRAGMA table_info")) return { results: [{ name: "id" }, { name: "trashed" }] };
          if (sql.includes("database_table_10")) return { results: sql.includes("COALESCE(trashed") ? activeRows() : rows };
          if (sql.includes("database_selectoption")) return { results: options };
          return { results: [] };
        },
        bind(...args: unknown[]) {
          return {
            sql,
            args,
            async all() {
              if (sql.includes("database_selectoption")) {
                return { results: options.filter((option) => option.field_id === args[0]) };
              }
              return { results: [] };
            },
            async first() {
              if (sql.includes("MAX([order])")) {
                const fieldOptions = options.filter((option) => option.field_id === args[0]);
                return { max_order: Math.max(0, ...fieldOptions.map((option) => option.order)) };
              }
              if (sql.includes("database_selectoption") && sql.includes("AND id=?")) {
                return options.find((option) => option.field_id === args[0] && option.id === args[1]) || null;
              }
              if (sql.includes("database_selectoption") && (sql.includes("value=?") || sql.includes("LOWER(value)=LOWER(?)"))) {
                const caseInsensitive = sql.includes("LOWER(value)=LOWER(?)");
                return options.find((option) => option.field_id === args[0] && (
                  caseInsensitive
                    ? option.value.toLowerCase() === String(args[1]).toLowerCase()
                    : option.value === args[1]
                )) || null;
              }
              if (sql.includes("FROM auth_user") && sql.includes("id=?")) {
                return users.find((user) => user.id === args[0]) || null;
              }
              if (sql.includes("FROM auth_user") && sql.includes("email=?")) {
                return users.find((user) => user.email === args[0] || user.username === args[1]) || null;
              }
              return null;
            },
            async run() {
              updates.push({ sql, args });
              return {};
            },
          };
        },
        async run() {
          return {};
        },
      };
    },
    async batch(statements: Array<{ sql: string; args: unknown[] }>) {
      for (const statement of statements) {
        if (statement.sql.includes("INSERT INTO database_selectoption")) {
          const nextId = Math.max(0, ...options.map((option) => option.id)) + 1;
          options.push({
            id: nextId,
            field_id: Number(statement.args[0]),
            value: String(statement.args[1]),
            color: String(statement.args[2]),
            order: Number(statement.args[3]),
          });
          optionInserts.push({ sql: statement.sql, args: statement.args });
        } else {
          updates.push({ sql: statement.sql, args: statement.args });
        }
      }
      return statements.map(() => ({ success: true }));
    },
    optionInserts,
  };
}

describe("field type conversion", () => {
  it("extracts display values from stored Baserow option/link/file objects", () => {
    expect(valueForFieldConversion("single_select", JSON.stringify({ id: 10, value: "Ready", color: "green" })))
      .toEqual({ id: 10, value: "Ready", color: "green" });
    expect(valueForFieldConversion("single_select", "Ready")).toBe("Ready");
    expect(valueForFieldConversion("multiple_select", JSON.stringify([{ id: 11, value: "Blocked" }])))
      .toEqual([{ id: 11, value: "Blocked" }]);
    expect(valueForFieldConversion("number", "n:9007199254740993.12500"))
      .toBe("9007199254740993.12500");
  });

  it("preserves null cells when converting nullable fields to text", async () => {
    const textField: FieldMeta = {
      id: 122,
      name: "Text",
      type: "text",
      primary: false,
      settings: {},
    };
    await expect(coerceValueForFieldType({} as any, textField, null, undefined, undefined, "single_select"))
      .resolves.toBeNull();
    await expect(coerceValueForFieldType({} as any, textField, [], undefined, undefined, "multiple_select"))
      .resolves.toBeNull();
    await expect(coerceValueForFieldType({} as any, textField, [{ id: 1, value: "Ready" }], undefined, undefined, "multiple_select"))
      .resolves.toBe("Ready");
  });

  it("coerces common Baserow cells into the target type before storage", async () => {
    await expect(coerceValueForFieldType({} as any, {
      id: 2,
      name: "Done",
      type: "boolean",
      primary: false,
      settings: {},
    }, "oui")).resolves.toBe(true);

    await expect(coerceValueForFieldType({} as any, {
      id: 3,
      name: "Score",
      type: "rating",
      primary: false,
      settings: { max_value: 5 },
    }, "12")).resolves.toBe(5);

    await expect(coerceValueForFieldType({} as any, {
      id: 4,
      name: "Labels",
      type: "multiple_select",
      primary: false,
      settings: {},
    }, "A, B")).resolves.toEqual(["A", "B"]);

    await expect(coerceValueForFieldType({} as any, {
      id: 5,
      name: "Assignees",
      type: "multiple_collaborators",
      primary: false,
      settings: {},
    }, "7, user@example.com")).resolves.toEqual(["7", "user@example.com"]);
  });

  it("matches Baserow quoted multiple-select text conversion", () => {
    expect(parseMultipleSelectText('Option 1, "Option 3,", Option 2, Option 1'))
      .toEqual(["Option 1", "Option 3,", "Option 2"]);
    expect(parseMultipleSelectText('"A, B", "quoted ""value"""'))
      .toEqual(["A, B", 'quoted "value"']);
    expect(parseMultipleSelectText(`${"x".repeat(260)}, y`))
      .toEqual(["x".repeat(255), "y"]);
    expect(multipleSelectTextValue([
      { id: 1, value: "Option 3," },
      { id: 2, value: "Option 2" },
    ])).toBe('"Option 3,", Option 2');
  });

  it("matches the Baserow text-to-boolean conversion fixture", async () => {
    const field: FieldMeta = {
      id: 12,
      name: "Checked",
      type: "boolean",
      primary: false,
      settings: {},
    };
    const fixture = new Map<unknown, boolean>([
      ["1", true], ["t", true], ["y", true], ["yes", true], ["on", true],
      ["YES", true], ["checked", true], ["Checked", true], ["", false],
      ["f", false], ["n", false], ["false", false], ["off", false],
      ["Random text", false],
    ]);

    for (const [input, expected] of fixture) {
      await expect(coerceValueForFieldType({} as any, field, input)).resolves.toBe(expected);
    }
  });

  it("matches Baserow numeric and rating conversions to boolean", async () => {
    const field: FieldMeta = {
      id: 120,
      name: "Checked",
      type: "boolean",
      primary: false,
      settings: {},
    };
    await expect(coerceValueForFieldType({} as any, field, 1, undefined, undefined, "number")).resolves.toBe(true);
    await expect(coerceValueForFieldType({} as any, field, 100, undefined, undefined, "number")).resolves.toBe(false);
    await expect(coerceValueForFieldType({} as any, field, -1, undefined, undefined, "number")).resolves.toBe(false);
    await expect(coerceValueForFieldType({} as any, field, 3, undefined, undefined, "rating")).resolves.toBe(true);
    await expect(coerceValueForFieldType({} as any, field, 0, undefined, undefined, "rating")).resolves.toBe(false);
  });

  it("matches Baserow number conversion rounding, precision and negative clamping", async () => {
    const values = [
      "9223372036854775807", "100", "100.22", "100.59999",
      "-9223372036854775808", "-100", "-100.22", "-100.5999",
      "100.59.99", "-100.59.99", "100TEST100.10", "!@#$%%^^&&^^%$$",
      "!@#$%%^^5.2&&^^%$$",
    ];
    const integerField: FieldMeta = {
      id: 13,
      name: "Integer",
      type: "number",
      primary: false,
      settings: { number_decimal_places: 0, number_negative: false },
    };
    const decimalField: FieldMeta = {
      ...integerField,
      id: 14,
      name: "Decimal",
      settings: { number_decimal_places: 3, number_negative: true },
    };

    const integers = [];
    const decimals = [];
    for (const value of values) {
      integers.push(await coerceValueForFieldType({} as any, integerField, value));
      decimals.push(await coerceValueForFieldType({} as any, decimalField, value));
    }

    expect(integers).toEqual([
      "9223372036854775807", "100", "100", "101", "0", "0", "0", "0",
      null, null, null, null, null,
    ]);
    expect(decimals).toEqual([
      "9223372036854775807.000", "100.000", "100.220", "100.600",
      "-9223372036854775808.000", "-100.000", "-100.220", "-100.600",
      null, null, null, null, null,
    ]);
    await expect(serializeFieldValueForStorage(conversionDb() as any, integerField, integers[3]))
      .resolves.toBe("n:101");
  });

  it("uses zero for invalid or empty values converted to rating", async () => {
    const field: FieldMeta = {
      id: 121,
      name: "Rating",
      type: "rating",
      primary: false,
      settings: { max_value: 3 },
    };
    await expect(coerceValueForFieldType({} as any, field, "invalid", undefined, undefined, "text")).resolves.toBe(0);
    await expect(coerceValueForFieldType({} as any, field, null, undefined, undefined, "text")).resolves.toBe(0);
    await expect(coerceValueForFieldType({} as any, field, 4.5, undefined, undefined, "number")).resolves.toBe(3);
  });

  it("parses Baserow date conversion formats as UTC and clears invalid values", async () => {
    const euDate: FieldMeta = {
      id: 15,
      name: "EU date",
      type: "date",
      primary: false,
      settings: { date_format: "EU", date_include_time: false, date_time_format: "24" },
    };
    const usDate = { ...euDate, id: 16, settings: { ...euDate.settings, date_format: "US" } };
    const dateTime = { ...euDate, id: 17, settings: { ...euDate.settings, date_include_time: true, date_time_format: "12" } };

    await expect(coerceValueForFieldType({} as any, euDate, "22/07/2021")).resolves.toBe("2021-07-22");
    await expect(coerceValueForFieldType({} as any, euDate, "22-7-2021")).resolves.toBe("2021-07-22");
    await expect(coerceValueForFieldType({} as any, usDate, "07/22/2021")).resolves.toBe("2021-07-22");
    await expect(coerceValueForFieldType({} as any, dateTime, "22/07/2021 12:45 PM"))
      .resolves.toBe("2021-07-22T12:45:00.000Z");
    await expect(coerceValueForFieldType({} as any, dateTime, "19/Apr/2017:06:36:15"))
      .resolves.toBe("2017-04-19T06:36:15.000Z");
    await expect(coerceValueForFieldType({} as any, dateTime, "Dec 2, 2017 2:39:58 AM"))
      .resolves.toBe("2017-12-02T02:39:58.000Z");
    await expect(coerceValueForFieldType({} as any, dateTime, "INVALID")).resolves.toBeNull();
  });

  it("generates a new valid UUID for every converted source row", async () => {
    const field: FieldMeta = {
      id: 18,
      name: "UUID",
      type: "uuid",
      primary: false,
      settings: {},
    };
    const first = await coerceValueForFieldType({} as any, field, "Row 1");
    const second = await coerceValueForFieldType({} as any, field, "Row 2");
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(second).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(second).not.toBe(first);
  });

  it("parses Baserow duration input strings and rounds by duration_format", async () => {
    const durationField: FieldMeta = {
      id: 6,
      name: "Duration",
      type: "duration",
      primary: false,
      settings: { duration_format: "h:mm" },
    };

    await expect(coerceValueForFieldType({} as any, durationField, "1:30")).resolves.toBe(5400);
    await expect(coerceValueForFieldType({} as any, durationField, "90")).resolves.toBe(120);
    await expect(coerceValueForFieldType({} as any, {
      ...durationField,
      settings: { duration_format: "d h:mm" },
    }, "1d 2:03")).resolves.toBe(93780);
    await expect(coerceValueForFieldType({} as any, {
      ...durationField,
      settings: { duration_format: "h:mm:ss.sss" },
    }, "1:02.345")).resolves.toBe(62.345);
    await expect(coerceValueForFieldType({} as any, durationField, "-1:30")).resolves.toBe(-5400);

    await expect(serializeFieldValueForStorage(conversionDb() as any, durationField, "1h 2m"))
      .resolves.toBe("n:3720");
  });

  it("clears invalid specialized text values during conversion like Baserow", async () => {
    await expect(coerceValueForFieldType({} as any, {
      id: 7,
      name: "Website",
      type: "url",
      primary: false,
      settings: {},
    }, "https://baserow.io")).resolves.toBe("https://baserow.io");
    await expect(coerceValueForFieldType({} as any, {
      id: 7,
      name: "Website",
      type: "url",
      primary: false,
      settings: {},
    }, "localhost")).resolves.toBe("");
    await expect(coerceValueForFieldType({} as any, {
      id: 8,
      name: "Email",
      type: "email",
      primary: false,
      settings: {},
    }, "a@a")).resolves.toBe("a@a");
    await expect(coerceValueForFieldType({} as any, {
      id: 8,
      name: "Email",
      type: "email",
      primary: false,
      settings: {},
    }, "invalid@invalid@com")).resolves.toBe("");
    await expect(coerceValueForFieldType({} as any, {
      id: 9,
      name: "Phone",
      type: "phone_number",
      primary: false,
      settings: {},
    }, "1234567890 NnXx,+._*()#=;/ -")).resolves.toBe("1234567890 NnXx,+._*()#=;/ -");
    await expect(coerceValueForFieldType({} as any, {
      id: 9,
      name: "Phone",
      type: "phone_number",
      primary: false,
      settings: {},
    }, "invalid phone number")).resolves.toBe("");
  });

  it("rewrites existing row values using the new select option objects", async () => {
    const db = conversionDb([
      { id: 1, value: "READY", _created_on: "2026-01-01T00:00:00.000Z", _updated_on: "2026-01-02T00:00:00.000Z" },
      { id: 2, value: "Blocked", _created_on: "2026-01-03T00:00:00.000Z", _updated_on: "2026-01-04T00:00:00.000Z" },
    ]);
    const field: FieldMeta = {
      id: 1,
      name: "Status",
      type: "single_select",
      primary: false,
      settings: {},
    };

    await expect(convertExistingFieldValues(db as any, 10, field, "text")).resolves.toBe(2);

    expect(db.updates).toHaveLength(2);
    expect(JSON.parse(String(db.updates[0].args[0]))).toEqual({
      id: 10,
      value: "Ready",
      color: "light-green",
    });
    expect(JSON.parse(String(db.updates[1].args[0]))).toEqual({
      id: 11,
      value: "Blocked",
      color: "light-red",
    });
  });

  it("converts active and trashed rows so restored cells keep the target type", async () => {
    const db = conversionDb([
      { id: 1, value: "Ready", trashed: 0, _created_on: "2026-01-01T00:00:00.000Z", _updated_on: "2026-01-02T00:00:00.000Z" },
      { id: 2, value: "Blocked", trashed: 1, _created_on: "2026-01-03T00:00:00.000Z", _updated_on: "2026-01-04T00:00:00.000Z" },
    ]);
    const field: FieldMeta = {
      id: 1,
      name: "Status",
      type: "single_select",
      primary: false,
      settings: {},
    };

    await expect(convertExistingFieldValues(db as any, 10, field, "text")).resolves.toBe(2);

    expect(db.updates).toHaveLength(2);
    expect(db.updates[0].sql).not.toContain("COALESCE(trashed, 0)=0");
    expect(db.updates.map((update) => update.args[1])).toEqual([1, 2]);
  });

  it("only maps options supplied on the target select field", async () => {
    const db = conversionDb([
      { id: 1, value: "Ready", _created_on: "2026-01-01T00:00:00.000Z", _updated_on: "2026-01-02T00:00:00.000Z" },
      { id: 2, value: "New, Blocked", _created_on: "2026-01-03T00:00:00.000Z", _updated_on: "2026-01-04T00:00:00.000Z" },
    ]);
    const field: FieldMeta = {
      id: 1,
      name: "Tags",
      type: "multiple_select",
      primary: false,
      settings: {},
    };

    await expect(convertExistingFieldValues(db as any, 10, field, "text")).resolves.toBe(2);

    expect(db.optionInserts).toEqual([]);
    expect(JSON.parse(String(db.updates[0].args[0]))).toEqual([
      { id: 10, value: "Ready", color: "light-green" },
    ]);
    expect(JSON.parse(String(db.updates[1].args[0]))).toEqual([
      { id: 11, value: "Blocked", color: "light-red" },
    ]);
  });

  it("recreates file, link-row and collaborator columns without preserving incompatible data", async () => {
    const db = conversionDb([
      { id: 1, value: "7", _created_on: "2026-01-01T00:00:00.000Z", _updated_on: "2026-01-02T00:00:00.000Z" },
      { id: 2, value: "user@example.com", _created_on: "2026-01-03T00:00:00.000Z", _updated_on: "2026-01-04T00:00:00.000Z" },
    ]);
    const field: FieldMeta = {
      id: 1,
      name: "Assignees",
      type: "multiple_collaborators",
      primary: false,
      settings: {},
    };

    await expect(convertExistingFieldValues(db as any, 10, field, "text")).resolves.toBe(2);

    expect(db.updates).toHaveLength(2);
    expect(JSON.parse(String(db.updates[0].args[0]))).toEqual([]);
    expect(JSON.parse(String(db.updates[1].args[0]))).toEqual([]);

    for (const type of ["file", "link_row"] as const) {
      const targetDb = conversionDb([{ id: 1, value: "old value" }]);
      await convertExistingFieldValues(targetDb as any, 10, {
        ...field,
        type,
      }, "text");
      expect(JSON.parse(String(targetDb.updates[0].args[0]))).toEqual([]);
    }

    const scalarDb = conversionDb([{ id: 1, value: JSON.stringify([{ name: "file.pdf" }]) }]);
    await convertExistingFieldValues(scalarDb as any, 10, {
      ...field,
      type: "text",
    }, "file");
    expect(scalarDb.updates[0].args[0]).toBeNull();
  });

  it("quotes comma-containing options when converting multiple select to text", async () => {
    const db = conversionDb([{
      id: 1,
      value: JSON.stringify([{ id: 1, value: "Option 3," }, { id: 2, value: "Option 2" }]),
    }]);
    await convertExistingFieldValues(db as any, 10, {
      id: 1,
      name: "Text",
      type: "text",
      primary: false,
      settings: {},
    }, "multiple_select");
    expect(db.updates[0].args[0]).toBe('"Option 3,", Option 2');
  });
});
