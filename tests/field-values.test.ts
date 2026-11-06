import { describe, expect, it } from "vitest";
import { normalizeFieldValueForStorage } from "../src/services/field-values";
import { deserializeFieldValue, serializeFieldValueForInsert } from "../src/services/dynamic-tables";
import type { FieldMeta } from "../src/services/dynamic-tables";
import { formatNumberForExport } from "../src/services/number-format";
import { verifyPassword } from "../src/services/user";

function fakeDb() {
  const selectOptions = [
    { id: 10, field_id: 1, value: "Ready", color: "light-green", order: 1 },
    { id: 11, field_id: 1, value: "Blocked", color: "light-red", order: 2 },
  ];
  const fields = [{ id: 5, table_id: 20, type: "text", primary: 1, order: 1 }];
  const rows = [{ id: 99, field_5: "Customer A" }];
  const users = [
    { id: 7, username: "user@example.com", first_name: "User", last_name: "Example", email: "user@example.com" },
    { id: 8, username: "team@example.com", first_name: "", last_name: "", email: "team@example.com" },
  ];
  const workspaceUsers = [
    { workspace_id: 1, user_id: 7, to_be_deleted: 0 },
    { workspace_id: 1, user_id: 8, to_be_deleted: 0 },
  ];
  const userFiles = [
    {
      id: 12,
      user_id: 7,
      name: "stored_image.png",
      original_name: "Stored image.png",
      r2_key: "user_files/stored_image.png",
      size: 1024,
      mime_type: "image/png",
      is_image: 1,
      image_width: 640,
      image_height: 480,
      uploaded_at: "2026-05-29T10:00:00.000Z",
    },
  ];

  return {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first() {
              if (sql.includes("database_selectoption") && sql.includes("AND id=?")) {
                return selectOptions.find((option) => option.field_id === args[0] && option.id === args[1]) || null;
              }
              if (sql.includes("database_selectoption") && sql.includes("value=?")) {
                return selectOptions.find((option) => option.field_id === args[0] && option.value === args[1]) || null;
              }
              if (sql.includes("FROM database_field")) {
                return fields.find((field) => field.table_id === args[0]) || null;
              }
              if (sql.includes("database_table_20")) {
                const row = rows.find((item) => item.id === args[0]);
                return row ? { value: row.field_5 } : null;
              }
              if (sql.includes("FROM auth_user") && sql.includes("id=?")) {
                return users.find((user) => user.id === args[0]) || null;
              }
              if (sql.includes("FROM auth_user") && sql.includes("email=?")) {
                return users.find((user) => user.email === args[0] || user.username === args[1]) || null;
              }
              if (sql.includes("FROM core_workspaceuser wu")) {
                const membership = workspaceUsers.find((item) => item.workspace_id === args[0] && item.user_id === args[1] && item.to_be_deleted === 0);
                return membership ? users.find((user) => user.id === membership.user_id) || null : null;
              }
              if (sql.includes("FROM core_userfile")) {
                return userFiles.find((file) => file.name === args[0]) || null;
              }
              return null;
            },
            async all() {
              if (sql.includes("database_table_20") && sql.includes("id IN")) {
                return { results: rows.filter((item) => args.includes(item.id)).map((row) => ({ id: row.id, value: row.field_5 })) };
              }
              return { results: [] };
            },
          };
        },
      };
    },
  };
}

describe("field value storage normalization", () => {
  it("normalizes primitive row values like Baserow before storage", async () => {
    const db = fakeDb() as any;
    await expect(normalizeFieldValueForStorage(db, {
      id: 20,
      name: "Done",
      type: "boolean",
      primary: false,
      settings: {},
    }, "false")).resolves.toBe(false);
    await expect(normalizeFieldValueForStorage(db, {
      id: 20,
      name: "Done",
      type: "boolean",
      primary: false,
      settings: {},
    }, "checked")).resolves.toBe(true);
    await expect(normalizeFieldValueForStorage(db, {
      id: 21,
      name: "Amount",
      type: "number",
      primary: false,
      settings: { number_decimal_places: 2, number_negative: false },
    }, "12.34")).resolves.toBe("n:12.34");
    await expect(normalizeFieldValueForStorage(db, {
      id: 21,
      name: "Amount",
      type: "number",
      primary: false,
      settings: { number_decimal_places: 2, number_negative: false },
    }, "1e3")).resolves.toBe("n:1e3");
    await expect(normalizeFieldValueForStorage(db, {
      id: 21,
      name: "Amount",
      type: "number",
      primary: false,
      settings: {
        number_decimal_places: 2,
        number_negative: false,
        number_prefix: "EUR ",
        number_suffix: " paid",
        number_separator: "SPACE_COMMA",
      },
    }, "EUR 1 234,50 paid")).resolves.toBe("n:1234.50");
    await expect(normalizeFieldValueForStorage(db, {
      id: 21,
      name: "Amount",
      type: "number",
      primary: false,
      settings: {
        number_decimal_places: 2,
        number_negative: false,
        number_separator: "COMMA_PERIOD",
      },
    }, "1,234.50")).resolves.toBe("n:1234.50");
    await expect(normalizeFieldValueForStorage(db, {
      id: 22,
      name: "Rating",
      type: "rating",
      primary: false,
      settings: { max_value: 5 },
    }, "4")).resolves.toBe("n:4");
    await expect(normalizeFieldValueForStorage(db, {
      id: 23,
      name: "Due",
      type: "date",
      primary: false,
      settings: { date_include_time: false },
    }, "2026-05-21T18:30:00Z")).resolves.toBe("2026-05-21");
    await expect(normalizeFieldValueForStorage(db, {
      id: 24,
      name: "Starts",
      type: "date",
      primary: false,
      settings: { date_include_time: true },
    }, "2026-05-21T18:30:00Z")).resolves.toBe("2026-05-21T18:30:00.000Z");
    await expect(normalizeFieldValueForStorage(db, {
      id: 29,
      name: "EU date",
      type: "date",
      primary: false,
      settings: { date_format: "EU", date_include_time: false },
    }, "05/06/2026")).resolves.toBe("2026-06-05");
    await expect(normalizeFieldValueForStorage(db, {
      id: 30,
      name: "US date",
      type: "date",
      primary: false,
      settings: { date_format: "US", date_include_time: false },
    }, "05/06/2026")).resolves.toBe("2026-05-06");
    await expect(normalizeFieldValueForStorage(db, {
      id: 31,
      name: "EU datetime",
      type: "date",
      primary: false,
      settings: { date_format: "EU", date_include_time: true },
    }, "21/05/2026 2:30 PM")).resolves.toBe("2026-05-21T14:30:00.000Z");
    await expect(normalizeFieldValueForStorage(db, {
      id: 32,
      name: "ISO slash date",
      type: "date",
      primary: false,
      settings: { date_format: "ISO", date_include_time: false },
    }, "2026/05/21")).resolves.toBe("2026-05-21");
  });

  it("rejects invalid primitive row values with Baserow-style validation errors", async () => {
    const db = fakeDb() as any;
    await expect(normalizeFieldValueForStorage(db, {
      id: 40,
      name: "Website",
      type: "url",
      primary: false,
      settings: {},
    }, "localhost")).rejects.toThrow("not a valid url");
    await expect(normalizeFieldValueForStorage(db, {
      id: 41,
      name: "Email",
      type: "email",
      primary: false,
      settings: {},
    }, "invalid@invalid@com")).rejects.toThrow("not a valid email");
    await expect(normalizeFieldValueForStorage(db, {
      id: 42,
      name: "Phone",
      type: "phone_number",
      primary: false,
      settings: {},
    }, "Phone: 2312321")).rejects.toThrow("not a valid phone_number");
    await expect(normalizeFieldValueForStorage(db, {
      id: 25,
      name: "Amount",
      type: "number",
      primary: false,
      settings: { number_negative: false },
    }, "-1")).rejects.toThrow("cannot be negative");
    await expect(normalizeFieldValueForStorage(db, {
      id: 25,
      name: "Amount",
      type: "number",
      primary: false,
      settings: { number_decimal_places: 2 },
    }, "12.345")).rejects.toThrow("too many decimal places");
    await expect(normalizeFieldValueForStorage(db, {
      id: 25,
      name: "Amount",
      type: "number",
      primary: false,
      settings: {},
    }, "0x10")).rejects.toThrow("not a valid number");
    await expect(normalizeFieldValueForStorage(db, {
      id: 25,
      name: "Amount",
      type: "number",
      primary: false,
      settings: {},
    }, "EUR 1")).rejects.toThrow("not a valid number");
    await expect(normalizeFieldValueForStorage(db, {
      id: 26,
      name: "Rating",
      type: "rating",
      primary: false,
      settings: { max_value: 5 },
    }, "6")).rejects.toThrow("less than or equal to 5");
    await expect(normalizeFieldValueForStorage(db, {
      id: 27,
      name: "Done",
      type: "boolean",
      primary: false,
      settings: {},
    }, "maybe")).rejects.toThrow("Invalid value for boolean field");
    await expect(normalizeFieldValueForStorage(db, {
      id: 28,
      name: "Due",
      type: "date",
      primary: false,
      settings: {},
    }, "not a date")).rejects.toThrow("could not converted to a date");
    await expect(normalizeFieldValueForStorage(db, {
      id: 29,
      name: "Due",
      type: "date",
      primary: false,
      settings: { date_format: "EU" },
    }, "31/02/2026")).rejects.toThrow("could not converted to a date");
  });

  it("validates specialized text fields with Baserow regex semantics", async () => {
    const db = fakeDb() as any;
    await expect(normalizeFieldValueForStorage(db, {
      id: 40,
      name: "Website",
      type: "url",
      primary: false,
      settings: {},
    }, "mailto:bram@baserow.io?test=test")).resolves.toBe("mailto:bram@baserow.io?test=test");
    await expect(normalizeFieldValueForStorage(db, {
      id: 41,
      name: "Email",
      type: "email",
      primary: false,
      settings: {},
    }, "用户@例子.广告")).resolves.toBe("用户@例子.广告");
    await expect(normalizeFieldValueForStorage(db, {
      id: 42,
      name: "Phone",
      type: "phone_number",
      primary: false,
      settings: {},
    }, "1234567890 NnXx,+._*()#=;/ -")).resolves.toBe("1234567890 NnXx,+._*()#=;/ -");
    await expect(normalizeFieldValueForStorage(db, {
      id: 43,
      name: "Blank email",
      type: "email",
      primary: false,
      settings: {},
    }, null)).resolves.toBe("");
  });

  it("stores select cells as Baserow option objects instead of raw ids", async () => {
    const db = fakeDb() as any;
    const single: FieldMeta = { id: 1, name: "Status", type: "single_select", primary: false, settings: {} };
    const multiple: FieldMeta = { ...single, type: "multiple_select" };

    await expect(normalizeFieldValueForStorage(db, single, 10)).resolves.toEqual({
      id: 10,
      value: "Ready",
      color: "light-green",
    });
    await expect(normalizeFieldValueForStorage(db, multiple, [11, "Ready"])).resolves.toEqual([
      { id: 11, value: "Blocked", color: "light-red" },
      { id: 10, value: "Ready", color: "light-green" },
    ]);
  });

  it("deserializes single select cells as Baserow object-or-null values, never arrays", () => {
    expect(deserializeFieldValue("single_select", JSON.stringify({ id: 10, value: "Ready", color: "light-green" })))
      .toEqual({ id: 10, value: "Ready", color: "light-green" });
    expect(deserializeFieldValue("single_select", "")).toBeNull();
    expect(deserializeFieldValue("single_select", "Ready")).toBeNull();
    expect(deserializeFieldValue("single_select", JSON.stringify([{ id: 10, value: "Ready" }]))).toBeNull();

    expect(deserializeFieldValue("multiple_select", "Ready")).toEqual([]);
  });

  it("deserializes array cell types as Baserow arrays, never raw scalars or objects", () => {
    const values = [{ id: 10, value: "Ready" }];
    const arrayTypes = ["link_row", "lookup", "multiple_select", "multiple_collaborators", "file"] as const;

    for (const type of arrayTypes) {
      expect(deserializeFieldValue(type, JSON.stringify(values))).toEqual(values);
      expect(deserializeFieldValue(type, values)).toEqual(values);
      expect(deserializeFieldValue(type, null)).toEqual([]);
      expect(deserializeFieldValue(type, "")).toEqual([]);
      expect(deserializeFieldValue(type, JSON.stringify({ id: 10, value: "Ready" }))).toEqual([]);
      expect(deserializeFieldValue(type, { id: 10, value: "Ready" })).toEqual([]);
      expect(deserializeFieldValue(type, 10)).toEqual([]);
    }
  });

  it("deserializes generated user cells as Baserow object-or-null values, never arrays", () => {
    const user = { id: 7, name: "User Example", email: "user@example.com" };

    expect(deserializeFieldValue("created_by", JSON.stringify(user))).toEqual(user);
    expect(deserializeFieldValue("last_modified_by", user)).toEqual(user);
    expect(deserializeFieldValue("created_by", "")).toBeNull();
    expect(deserializeFieldValue("created_by", "user@example.com")).toBeNull();
    expect(deserializeFieldValue("last_modified_by", JSON.stringify([user]))).toBeNull();
  });

  it("deserializes numeric cells as finite numbers or null", () => {
    expect(deserializeFieldValue("number", "12.5")).toBe(12.5);
    expect(deserializeFieldValue("number", "n:12.5")).toBe(12.5);
    expect(deserializeFieldValue("number", "n:12345678901234567890.12")).toBe(12345678901234567000);
    expect(deserializeFieldValue("duration", 90)).toBe(90);
    expect(deserializeFieldValue("duration", "n:90.5")).toBe(90.5);
    expect(deserializeFieldValue("rating", "0")).toBe(0);
    expect(deserializeFieldValue("count", "3")).toBe(3);
    expect(deserializeFieldValue("autonumber", "n:3")).toBe(3);

    expect(deserializeFieldValue("number", "")).toBeNull();
    expect(deserializeFieldValue("duration", "")).toBeNull();
    expect(deserializeFieldValue("rating", "invalid")).toBeNull();
    expect(deserializeFieldValue("count", Number.NaN)).toBeNull();
  });

  it("stores numeric cells as tagged decimal text while keeping Baserow API numbers", () => {
    const field: FieldMeta = {
      id: 21,
      name: "Amount",
      type: "number",
      primary: false,
      settings: {
        number_decimal_places: 2,
        number_prefix: "EUR ",
        number_suffix: " paid",
        number_separator: "SPACE_COMMA",
      },
    };

    expect(serializeFieldValueForInsert("number", "12345678901234567890.12")).toBe("n:12345678901234567890.12");
    expect(serializeFieldValueForInsert("number", "n:12345678901234567890.12")).toBe("n:12345678901234567890.12");
    expect(serializeFieldValueForInsert("duration", 90.5)).toBe("n:90.5");
    expect(formatNumberForExport(field, "n:1234.50")).toBe("EUR 1 234,50 paid");
    expect(formatNumberForExport(field, "n:12345678901234567890.12")).toBe("EUR 12 345 678 901 234 567 890,12 paid");
    expect(formatNumberForExport(field, "n:1.2345e6")).toBe("EUR 1 234 500,00 paid");

    const plain: FieldMeta = {
      ...field,
      settings: { number_decimal_places: 2 },
    };
    expect(formatNumberForExport(plain, "n:12345678901234567890.125")).toBe("12345678901234567890.12");
    expect(formatNumberForExport(plain, "n:12345678901234567890.135")).toBe("12345678901234567890.14");
  });

  it("deserializes boolean cells using Baserow boolean tokens", () => {
    expect(deserializeFieldValue("boolean", true)).toBe(true);
    expect(deserializeFieldValue("boolean", false)).toBe(false);
    expect(deserializeFieldValue("boolean", 1)).toBe(true);
    expect(deserializeFieldValue("boolean", 0)).toBe(false);
    expect(deserializeFieldValue("boolean", "true")).toBe(true);
    expect(deserializeFieldValue("boolean", "checked")).toBe(true);
    expect(deserializeFieldValue("boolean", "false")).toBe(false);
    expect(deserializeFieldValue("boolean", "0")).toBe(false);
    expect(deserializeFieldValue("boolean", "off")).toBe(false);
    expect(deserializeFieldValue("boolean", "")).toBe(false);
  });

  it("hashes password writes and deserializes password cells as write-only booleans", async () => {
    const db = fakeDb() as any;
    const field: FieldMeta = { id: 33, name: "Secret", type: "password", primary: false, settings: {} };

    const stored = await normalizeFieldValueForStorage(db, field, "secret-value");
    expect(stored).toMatch(/^pbkdf2_sha256\$/);
    await expect(verifyPassword("secret-value", String(stored))).resolves.toBe(true);

    await expect(normalizeFieldValueForStorage(db, field, null)).resolves.toBeNull();
    await expect(normalizeFieldValueForStorage(db, field, "")).resolves.toBeNull();
    await expect(normalizeFieldValueForStorage(db, field, true)).resolves.toBeUndefined();

    expect(deserializeFieldValue("password", stored)).toBe(true);
    expect(deserializeFieldValue("password", null)).toBeNull();
    expect(deserializeFieldValue("password", "")).toBeNull();
  });

  it("stores link row cells as Baserow id/value objects instead of ids", async () => {
    const db = fakeDb() as any;
    const field: FieldMeta = {
      id: 2,
      name: "Customer",
      type: "link_row",
      primary: false,
      settings: { link_row_table_id: 20 },
    };

    await expect(normalizeFieldValueForStorage(db, field, [99])).resolves.toEqual([
      { id: 99, value: "Customer A" },
    ]);
  });

  it("preserves complete file metadata expected by Baserow cells", async () => {
    const db = fakeDb() as any;
    const field: FieldMeta = { id: 3, name: "Files", type: "file", primary: false, settings: {} };
    const value = await normalizeFieldValueForStorage(db, field, [{ name: "abc.pdf", size: 12, external: true }]);
    expect(value).toEqual([
      expect.objectContaining({
        name: "abc.pdf",
        visible_name: "abc.pdf",
        original_name: "abc.pdf",
        size: 12,
        mime_type: "application/octet-stream",
      }),
    ]);
  });

  it("hydrates file cells from core_userfile when the frontend sends only the stored file name", async () => {
    const db = fakeDb() as any;
    const field: FieldMeta = { id: 3, name: "Files", type: "file", primary: false, settings: {} };
    const value = await normalizeFieldValueForStorage(
      db,
      field,
      [{ name: "stored_image.png", visible_name: "Renamed image.png" }],
      "https://supertask.test"
    );

    expect(value).toEqual([
      expect.objectContaining({
        name: "stored_image.png",
        visible_name: "Renamed image.png",
        url: "https://supertask.test/media/user_files/stored_image.png",
        size: 1024,
        mime_type: "image/png",
        is_image: true,
        image_width: 640,
        image_height: 480,
        uploaded_at: "2026-05-29T10:00:00.000Z",
      }),
    ]);
    expect((value as any[])[0].original_name).toBeUndefined();
    expect((value as any[])[0].thumbnails.tiny.url).toBe("https://supertask.test/media/user_files/stored_image.png?thumbnail=tiny");
  });

  it("accepts Baserow CSV file-name input and hydrates every stored file", async () => {
    const db = fakeDb() as any;
    const field: FieldMeta = { id: 3, name: "Files", type: "file", primary: false, settings: {} };

    await expect(normalizeFieldValueForStorage(db, field, 'stored_image.png,"stored_image.png"', "https://supertask.test"))
      .resolves.toEqual([
        expect.objectContaining({ name: "stored_image.png", visible_name: "Stored image.png" }),
        expect.objectContaining({ name: "stored_image.png", visible_name: "Stored image.png" }),
      ]);
  });

  it("rejects invalid and missing user files instead of storing broken cells", async () => {
    const db = fakeDb() as any;
    const field: FieldMeta = { id: 3, name: "Files", type: "file", primary: false, settings: {} };

    await expect(normalizeFieldValueForStorage(db, field, [{ name: "invalid.png" }]))
      .rejects.toMatchObject({ code: "ERROR_INVALID_USER_FILE_NAME_ERROR", status: 400 });
    await expect(normalizeFieldValueForStorage(db, field, [{ name: "missing_hash.png" }]))
      .rejects.toMatchObject({ code: "ERROR_USER_FILE_DOES_NOT_EXIST", status: 400 });
    await expect(normalizeFieldValueForStorage(db, field, [{ visible_name: "Missing name" }]))
      .rejects.toThrow("A name property is required");
    await expect(normalizeFieldValueForStorage(db, field, ["stored_image.png", { name: "stored_image.png" }]))
      .rejects.toThrow("same type");
  });

  it("stores collaborator cells as Baserow id/name objects and rejects invalid collaborators", async () => {
    const db = fakeDb() as any;
    const field: FieldMeta = { id: 4, name: "Assignees", type: "multiple_collaborators", primary: false, settings: {} };

    await expect(normalizeFieldValueForStorage(db, field, [7, { id: "8" }], undefined, 1)).resolves.toEqual([
      { id: 7, name: "User Example" },
      { id: 8, name: "team@example.com" },
    ]);
    await expect(normalizeFieldValueForStorage(db, field, "team@example.com", undefined, 1)).rejects.toThrow("valid list");
    await expect(normalizeFieldValueForStorage(db, field, ["team@example.com"], undefined, 1)).rejects.toThrow("Expected an integer");
    await expect(normalizeFieldValueForStorage(db, field, [7, 7], undefined, 1)).rejects.toThrow("not valid collaborators");
    await expect(normalizeFieldValueForStorage(db, field, [999], undefined, 1)).rejects.toThrow("not valid collaborators");
    await expect(normalizeFieldValueForStorage(db, field, null, undefined, 1)).rejects.toThrow("may not be null");
  });
});
