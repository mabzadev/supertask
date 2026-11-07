//! The SQL pieces of the row listing (`src/routes/database/rows.ts`), kept
//! pure so their string output can be compared with the TS code in tests.

use crate::fields::FieldMeta;
use crate::js;

/// The `:tableId` segment of `/api/database/rows/table/:tableId/`.
pub fn table_segment(path: &str) -> Option<&str> {
    let segment = path
        .strip_prefix("/api/database/rows/table/")?
        .strip_suffix('/')?;
    (!segment.is_empty() && !segment.contains('/')).then_some(segment)
}

/// `activeRowClause(tableName)`.
pub fn active_row_clause(table: &str) -> String {
    format!("COALESCE(\"{table}\".trashed, 0)=0")
}

/// `splitOrderBy`: comma-separated, `"` quotes, `\` escapes.
pub fn split_order_by(value: &str) -> Vec<String> {
    let mut parts = Vec::new();
    let mut current = String::new();
    let (mut quoted, mut escaped) = (false, false);
    let flush = |current: &mut String, parts: &mut Vec<String>| {
        let trimmed = js::trim(current);
        if !trimmed.is_empty() {
            parts.push(trimmed.to_owned());
        }
        current.clear();
    };
    for c in value.chars() {
        if escaped {
            current.push(c);
            escaped = false;
        } else if c == '\\' {
            escaped = true;
        } else if c == '"' {
            quoted = !quoted;
        } else if c == ',' && !quoted {
            flush(&mut current, &mut parts);
        } else {
            current.push(c);
        }
    }
    flush(&mut current, &mut parts);
    parts
}

/// `findOrderByField`.
fn find_order_by_field<'a>(
    raw: &str,
    fields: &'a [FieldMeta],
    use_field_names: bool,
) -> Option<&'a FieldMeta> {
    let all_digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    #[allow(clippy::cast_precision_loss)]
    let by_id = |digits: &str| {
        let id = js::string_to_number(digits);
        fields.iter().find(|f| f.id as f64 == id)
    };
    if let Some(digits) = raw.strip_prefix("field_").filter(|d| all_digits(d)) {
        return by_id(digits);
    }
    if !use_field_names && all_digits(raw) {
        return by_id(raw);
    }
    if use_field_names {
        return fields.iter().find(|f| f.name == raw);
    }
    None
}

/// `buildOrderClause`: requested sorts, then `[order]` and `id` as tie-breakers.
pub fn order_clause(
    table: &str,
    fields: &[FieldMeta],
    order_by: &str,
    use_field_names: bool,
) -> String {
    let mut clauses = Vec::new();
    for part in split_order_by(order_by) {
        let desc = part.starts_with('-');
        let raw = if desc || part.starts_with('+') {
            &part[1..]
        } else {
            part.as_str()
        };
        if let Some(field) = find_order_by_field(raw, fields, use_field_names) {
            clauses.push(format!(
                "\"{table}\".\"field_{}\" {}",
                field.id,
                if desc { "DESC" } else { "ASC" }
            ));
        }
    }
    clauses.push(format!("\"{table}\".[order] ASC"));
    clauses.push(format!("\"{table}\".id ASC"));
    clauses.join(", ")
}

/// The `search` condition: one `instr` per text-like field, each bound to the term.
pub fn search_clauses(table: &str, fields: &[FieldMeta]) -> Vec<String> {
    fields
        .iter()
        .filter(|f| {
            matches!(
                f.field_type.as_str(),
                "text" | "long_text" | "url" | "email" | "phone_number"
            )
        })
        .map(|f| format!("instr(LOWER(\"{table}\".\"field_{}\"), LOWER(?)) > 0", f.id))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Map;

    fn field(id: i64, name: &str, field_type: &str) -> FieldMeta {
        FieldMeta {
            id,
            name: name.into(),
            field_type: field_type.into(),
            primary: false,
            read_only: false,
            settings: Map::new(),
            formula: None,
        }
    }

    #[test]
    fn order_by_splits_like_ts() {
        assert_eq!(
            split_order_by(r#"-field_1, "a,b" ,c\,d,,"#),
            vec!["-field_1", "a,b", "c,d"]
        );
    }

    #[test]
    fn order_clause_matches_ts() {
        let fields = [field(1, "Nom", "text"), field(2, "12", "number")];
        assert_eq!(
            order_clause("t", &fields, "-field_1,+Nom,2,missing", false),
            r#""t"."field_1" DESC, "t"."field_2" ASC, "t".[order] ASC, "t".id ASC"#
        );
        assert_eq!(
            order_clause("t", &fields, "Nom,-12", true),
            r#""t"."field_1" ASC, "t"."field_2" DESC, "t".[order] ASC, "t".id ASC"#
        );
        assert_eq!(
            search_clauses("t", &fields),
            vec![r#"instr(LOWER("t"."field_1"), LOWER(?)) > 0"#]
        );
    }

    #[test]
    fn table_segments() {
        assert_eq!(table_segment("/api/database/rows/table/12/"), Some("12"));
        assert_eq!(table_segment("/api/database/rows/table/12/3/"), None);
        assert_eq!(table_segment("/api/database/rows/table/12"), None);
    }
}
