//! Port of `ComputedFieldResolver` and `serializeRowsWithComputedFields`
//! (`src/services/computed-fields.ts`) for every field type except evaluated
//! formulas, which belong to `st-formula` and are forwarded until it lands.
//!
//! Data access goes through [`RowSource`] so the resolution rules are tested
//! natively against in-memory tables, and run against D1 in the Worker.

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::pin::Pin;
use std::rc::Rc;

use serde_json::{Map, Value};

use crate::fallback::{Failure, Outcome};
use crate::fields::{
    FieldMeta, Row, aggregate_rollup_values, deserialize_field_value, is_linked_computed,
    linked_primary_display_value, linked_row_ids, normalize_resolved_field_value, row_order,
    serialize_lookup_sub_value, stored_link_fallback,
};
use crate::js;

/// Read access the resolver needs, cached per request like `RowReadContext`.
pub trait RowSource {
    /// Active fields of a table, `ORDER BY [order] ASC, id ASC`.
    fn fields(&self, table_id: i64) -> impl Future<Output = Outcome<Rc<Vec<FieldMeta>>>>;
    /// Starts loading (or loads) the given rows of a table into the cache.
    fn load(&self, table_id: i64, ids: &[i64]) -> impl Future<Output = Outcome<()>>;
    /// A cached row, after [`RowSource::load`]; `None` when trashed or missing.
    fn cached_row(&self, table_id: i64, id: i64) -> Option<Rc<Row>>;
}

/// `RowReadContext.linkedRows`: active rows among `ids`, by `order` then id.
pub async fn linked_rows<S: RowSource>(
    source: &S,
    table_id: i64,
    ids: &[i64],
) -> Outcome<Vec<Rc<Row>>> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    source.load(table_id, ids).await?;
    let mut rows: Vec<Rc<Row>> = ids
        .iter()
        .filter_map(|id| source.cached_row(table_id, *id))
        .collect();
    rows.sort_by(|left, right| {
        let by_order = row_order(left)
            .partial_cmp(&row_order(right))
            .unwrap_or(std::cmp::Ordering::Equal);
        by_order.then_with(|| {
            let id = |row: &Row| js::to_number_opt(row.get("id"));
            id(left)
                .partial_cmp(&id(right))
                .unwrap_or(std::cmp::Ordering::Equal)
        })
    });
    Ok(rows)
}

/// Integer form of a numeric setting that names a field or table id.
fn as_id(n: f64) -> Option<i64> {
    // Ids are compared with `===` against integer columns: only integers can match.
    #[allow(clippy::cast_possible_truncation)]
    (js::is_positive_integer(n) && n <= js::MAX_SAFE_INTEGER).then_some(n as i64)
}

/// `row[\`field_${id}\`]` where the id came from settings (so it may print as `NaN`).
fn cell(row: &Row, id: f64) -> Option<&Value> {
    row.get(&format!("field_{}", js::number_to_string(id)))
}

type Lineage = RefCell<HashSet<String>>;
type LocalFuture<'a, T> = Pin<Box<dyn Future<Output = T> + 'a>>;

/// One row's resolver; `memo` caches each field once, `lineage` breaks cycles across rows.
struct Resolver<'a, S> {
    source: &'a S,
    row: Rc<Row>,
    fields: Rc<Vec<FieldMeta>>,
    lineage: &'a Lineage,
    memo: HashMap<i64, Option<Value>>,
}

impl<'a, S: RowSource> Resolver<'a, S> {
    fn new(source: &'a S, row: Rc<Row>, fields: Rc<Vec<FieldMeta>>, lineage: &'a Lineage) -> Self {
        Self {
            source,
            row,
            fields,
            lineage,
            memo: HashMap::new(),
        }
    }

    fn field(&self, id: f64) -> Option<&FieldMeta> {
        as_id(id).and_then(|id| self.fields.iter().find(|field| field.id == id))
    }

    /// `ComputedFieldResolver.resolve`; `None` is `undefined`.
    fn resolve<'b>(&'b mut self, field: &'b FieldMeta) -> LocalFuture<'b, Outcome<Option<Value>>> {
        Box::pin(async move {
            if let Some(value) = self.memo.get(&field.id) {
                return Ok(value.clone());
            }
            let row_key = match self.row.get("id") {
                None | Some(Value::Null) => String::new(),
                Some(id) => js::to_js_string(id),
            };
            let key = format!("{}:{row_key}", field.id);
            if self.lineage.borrow().contains(&key) {
                return Ok(Some(Value::Null));
            }
            self.lineage.borrow_mut().insert(key.clone());
            let value = self.compute(field).await;
            self.lineage.borrow_mut().remove(&key);
            let value = value?;
            self.memo.insert(field.id, value.clone());
            Ok(value)
        })
    }

    async fn compute(&mut self, field: &FieldMeta) -> Outcome<Option<Value>> {
        if field.has_formula() {
            return Err(Failure::unsupported("formula field"));
        }
        match field.field_type.as_str() {
            "lookup" => lookup_values(self.source, &self.row, &self.fields, field, self.lineage)
                .await
                .map(Some),
            "rollup" => {
                let values =
                    linked_target_values(self.source, &self.row, &self.fields, field, self.lineage)
                        .await?;
                let flat = values
                    .into_iter()
                    .flat_map(|value| match value {
                        Some(Value::Array(items)) => items.into_iter().map(Some).collect(),
                        other => vec![other],
                    })
                    .collect();
                aggregate_rollup_values(flat, &field.settings)
            }
            "count" => {
                let through_id = field.numeric_setting("through_field_id");
                let target_table = self
                    .field(through_id)
                    .map_or(0.0, |through| through.numeric_setting("link_row_table_id"));
                let ids = linked_row_ids(cell(&self.row, through_id))?;
                if js::truthy_opt(js::number_value(through_id).as_ref())
                    && js::truthy_opt(js::number_value(target_table).as_ref())
                {
                    let table = as_id(target_table)
                        .ok_or_else(|| Failure::unsupported("count target table id"))?;
                    let rows = linked_rows(self.source, table, &ids).await?;
                    Ok(Some(Value::from(rows.len())))
                } else {
                    Ok(self.row.get(&field.column()).cloned())
                }
            }
            "link_row" => hydrate_link_row_values(self.source, &self.row, field, self.lineage)
                .await
                .map(Some),
            _ => Ok(self.row.get(&field.column()).cloned()),
        }
    }
}

/// `linkedTargetValues`: the target field's value in each linked row.
async fn linked_target_values<S: RowSource>(
    source: &S,
    row: &Row,
    fields: &[FieldMeta],
    field: &FieldMeta,
    lineage: &Lineage,
) -> Outcome<Vec<Option<Value>>> {
    let through_id = field.numeric_setting("through_field_id");
    let target_field_id = field.numeric_setting("target_field_id");
    if !js::truthy_opt(js::number_value(through_id).as_ref())
        || !js::truthy_opt(js::number_value(target_field_id).as_ref())
    {
        return Ok(Vec::new());
    }
    let Some(through) = as_id(through_id).and_then(|id| fields.iter().find(|f| f.id == id)) else {
        return Ok(Vec::new());
    };
    let target_table = through.numeric_setting("link_row_table_id");
    if through.field_type != "link_row" || !js::truthy_opt(js::number_value(target_table).as_ref())
    {
        return Ok(Vec::new());
    }
    let ids = linked_row_ids(cell(row, through_id))?;
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let table =
        as_id(target_table).ok_or_else(|| Failure::unsupported("lookup target table id"))?;
    let target_fields = source.fields(table).await?;
    let Some(target_field) = as_id(target_field_id)
        .and_then(|id| target_fields.iter().find(|f| f.id == id))
        .cloned()
    else {
        return Ok(Vec::new());
    };
    let target_rows = linked_rows(source, table, &ids).await?;
    let mut values = Vec::with_capacity(target_rows.len());
    for target_row in target_rows {
        if is_linked_computed(&target_field.field_type) {
            let mut resolver =
                Resolver::new(source, target_row, Rc::clone(&target_fields), lineage);
            values.push(resolver.resolve(&target_field).await?);
        } else {
            let stored = match target_row.get(&target_field.column()) {
                None | Some(Value::Null) => target_row.get("value"),
                present => present,
            };
            values.push(Some(deserialize_field_value(
                &target_field.field_type,
                stored,
            )?));
        }
    }
    Ok(values)
}

/// `lookupValues`: `{ id, value }` per linked value, arrays flattened.
async fn lookup_values<S: RowSource>(
    source: &S,
    row: &Row,
    fields: &[FieldMeta],
    field: &FieldMeta,
    lineage: &Lineage,
) -> Outcome<Value> {
    let values = linked_target_values(source, row, fields, field, lineage).await?;
    let through_id = field.numeric_setting("through_field_id");
    let target_table = as_id(through_id)
        .and_then(|id| fields.iter().find(|f| f.id == id))
        .map_or(0.0, |through| through.numeric_setting("link_row_table_id"));
    let rows = if js::truthy_opt(js::number_value(target_table).as_ref()) {
        let table =
            as_id(target_table).ok_or_else(|| Failure::unsupported("lookup target table id"))?;
        linked_rows(source, table, &linked_row_ids(cell(row, through_id))?).await?
    } else {
        Vec::new()
    };
    let mut out = Vec::new();
    for (index, value) in values.into_iter().enumerate() {
        let row_id = rows
            .get(index)
            .map_or(f64::NAN, |r| js::to_number_opt(r.get("id")));
        #[allow(clippy::cast_precision_loss)]
        let id = if js::is_positive_integer(row_id) {
            row_id
        } else {
            (index + 1) as f64
        };
        let flattened = match value {
            Some(Value::Array(items)) => items.into_iter().map(Some).collect(),
            other => vec![other],
        };
        for item in flattened {
            let mut entry = Map::new();
            entry.insert("id".into(), js::number_value(id).unwrap_or(Value::Null));
            if let Some(sub) = serialize_lookup_sub_value(field, item)? {
                entry.insert("value".into(), sub);
            }
            out.push(Value::Object(entry));
        }
    }
    Ok(Value::Array(out))
}

/// `hydrateLinkRowValues`: `{ id, value, order }` with the linked rows' primary values.
async fn hydrate_link_row_values<S: RowSource>(
    source: &S,
    row: &Row,
    field: &FieldMeta,
    lineage: &Lineage,
) -> Outcome<Value> {
    let target_table = field.numeric_setting("link_row_table_id");
    let raw = row.get(&field.column());
    let stored = deserialize_field_value("link_row", raw)?;
    let ids = linked_row_ids(raw)?;
    if !js::truthy_opt(js::number_value(target_table).as_ref()) || ids.is_empty() {
        return Ok(stored_link_fallback(&stored));
    }
    let table = as_id(target_table).ok_or_else(|| Failure::unsupported("link target table id"))?;
    let target_fields = source.fields(table).await?;
    let Some(primary) = target_fields
        .iter()
        .find(|f| f.primary)
        .or_else(|| target_fields.first())
        .cloned()
    else {
        return Ok(stored_link_fallback(&stored));
    };
    let mut links = Vec::new();
    for target_row in linked_rows(source, table, &ids).await? {
        let primary_value = if is_linked_computed(&primary.field_type) {
            let mut resolver = Resolver::new(
                source,
                Rc::clone(&target_row),
                Rc::clone(&target_fields),
                lineage,
            );
            resolver.resolve(&primary).await?
        } else {
            Some(deserialize_field_value(
                &primary.field_type,
                target_row.get(&primary.column()),
            )?)
        };
        let mut link = Map::new();
        link.insert(
            "id".into(),
            js::number_value(js::to_number_opt(target_row.get("id"))).unwrap_or(Value::Null),
        );
        link.insert(
            "value".into(),
            Value::String(linked_primary_display_value(primary_value.as_ref())),
        );
        link.insert(
            "order".into(),
            Value::String(js::number_to_string(row_order(&target_row))),
        );
        links.push(Value::Object(link));
    }
    Ok(Value::Array(links))
}

/// A JS object under construction: keys keep their first position, `undefined` values are dropped at the end.
#[derive(Default)]
struct JsObject {
    entries: Vec<(String, Option<Value>)>,
    positions: HashMap<String, usize>,
}

impl JsObject {
    fn set(&mut self, key: String, value: Option<Value>) {
        match self.positions.get(&key) {
            Some(&index) => self.entries[index].1 = value,
            None => {
                self.positions.insert(key.clone(), self.entries.len());
                self.entries.push((key, value));
            }
        }
    }

    fn into_value(self) -> Value {
        Value::Object(
            self.entries
                .into_iter()
                .filter_map(|(key, value)| value.map(|v| (key, v)))
                .collect(),
        )
    }
}

/// `serializeRowWithComputedFields(db, row, fields, useFieldNames, ctx)`.
pub async fn serialize_row<S: RowSource>(
    source: &S,
    row: Rc<Row>,
    fields: Rc<Vec<FieldMeta>>,
    use_field_names: bool,
) -> Outcome<Value> {
    let mut object = JsObject::default();
    object.set("id".into(), row.get("id").cloned());
    let order = match row.get("order") {
        None | Some(Value::Null) => Value::from(10000),
        Some(order) => order.clone(),
    };
    object.set("order".into(), Some(order));
    let lineage = Lineage::default();
    let mut resolver = Resolver::new(source, Rc::clone(&row), Rc::clone(&fields), &lineage);
    for field in fields.iter() {
        let key = if use_field_names {
            field.name.clone()
        } else {
            field.column()
        };
        let value = resolver.resolve(field).await?;
        object.set(key, normalize_resolved_field_value(field, value)?);
    }
    Ok(object.into_value())
}

/// `serializeRowsWithComputedFields`: prefetches every linked row in bulk, then serializes each row.
pub async fn serialize_rows<S: RowSource>(
    source: &S,
    rows: Vec<Rc<Row>>,
    fields: Rc<Vec<FieldMeta>>,
    use_field_names: bool,
) -> Outcome<Vec<Value>> {
    if rows.is_empty() {
        return Ok(Vec::new());
    }
    // Evaluated formulas are not ported: bail out before any per-row work.
    if fields.iter().any(FieldMeta::has_formula) {
        return Err(Failure::unsupported("formula field"));
    }
    let mut ids_by_table: Vec<(i64, Vec<i64>)> = Vec::new();
    for field in fields.iter().filter(|f| f.field_type == "link_row") {
        let Some(table) = as_id(field.numeric_setting("link_row_table_id")) else {
            continue;
        };
        let mut ids = Vec::new();
        for row in &rows {
            ids.extend(linked_row_ids(row.get(&field.column()))?);
        }
        match ids_by_table.iter_mut().find(|(t, _)| *t == table) {
            Some((_, existing)) => existing.extend(ids),
            None if !ids.is_empty() => ids_by_table.push((table, ids)),
            None => {}
        }
    }
    for (table, ids) in &ids_by_table {
        let mut unique = Vec::new();
        let mut seen = HashSet::new();
        ids.iter()
            .filter(|id| seen.insert(**id))
            .for_each(|id| unique.push(*id));
        source.load(*table, &unique).await?;
        source.fields(*table).await?;
    }
    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        out.push(serialize_row(source, row, Rc::clone(&fields), use_field_names).await?);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::cell::RefCell;

    /// In-memory tables: `fields[table]` and `rows[table]`.
    #[derive(Default)]
    struct Memory {
        fields: HashMap<i64, Rc<Vec<FieldMeta>>>,
        rows: HashMap<i64, Vec<Rc<Row>>>,
        loads: RefCell<usize>,
    }

    impl RowSource for Memory {
        async fn fields(&self, table_id: i64) -> Outcome<Rc<Vec<FieldMeta>>> {
            Ok(self.fields.get(&table_id).cloned().unwrap_or_default())
        }
        async fn load(&self, _table_id: i64, _ids: &[i64]) -> Outcome<()> {
            *self.loads.borrow_mut() += 1;
            Ok(())
        }
        fn cached_row(&self, table_id: i64, id: i64) -> Option<Rc<Row>> {
            self.rows
                .get(&table_id)?
                .iter()
                .find(|r| r.get("id").and_then(Value::as_i64) == Some(id))
                .cloned()
        }
    }

    fn meta(id: i64, name: &str, field_type: &str, primary: bool, settings: Value) -> FieldMeta {
        FieldMeta {
            id,
            name: name.into(),
            field_type: field_type.into(),
            primary,
            read_only: false,
            settings: settings.as_object().cloned().unwrap(),
            formula: None,
        }
    }

    fn row(value: Value) -> Rc<Row> {
        Rc::new(value.as_object().cloned().unwrap())
    }

    fn block_on<F: Future>(future: F) -> F::Output {
        // The memory source never suspends, so a single poll completes the future.
        let waker = std::task::Waker::noop();
        let mut context = std::task::Context::from_waker(waker);
        let mut future = std::pin::pin!(future);
        match future.as_mut().poll(&mut context) {
            std::task::Poll::Ready(value) => value,
            std::task::Poll::Pending => panic!("memory source suspended"),
        }
    }

    fn sample() -> (Memory, Rc<Vec<FieldMeta>>) {
        let clients = Rc::new(vec![
            meta(1, "Nom", "text", true, json!({})),
            meta(
                16,
                "Projets",
                "link_row",
                false,
                json!({ "link_row_table_id": 2 }),
            ),
            meta(
                39,
                "Nb",
                "count",
                false,
                json!({ "through_field_id": 16, "formula_type": "number" }),
            ),
            meta(
                40,
                "Budget",
                "rollup",
                false,
                json!({ "through_field_id": 16, "target_field_id": 24, "rollup_function": "sum", "formula_type": "number", "number_decimal_places": 2 }),
            ),
            meta(
                41,
                "Budgets",
                "lookup",
                false,
                json!({ "through_field_id": 16, "target_field_id": 24, "array_formula_type": "number", "number_decimal_places": 1 }),
            ),
        ]);
        let projects = Rc::new(vec![
            meta(14, "Nom", "text", true, json!({})),
            meta(24, "Budget", "number", false, json!({})),
        ]);
        let mut memory = Memory::default();
        memory.fields.insert(1, Rc::clone(&clients));
        memory.fields.insert(2, projects);
        memory.rows.insert(
            2,
            vec![
                row(json!({ "id": 1, "order": 20000.0, "field_14": "B", "field_24": "n:1000.5" })),
                row(json!({ "id": 21, "order": 10000.0, "field_14": "A", "field_24": "n:250" })),
            ],
        );
        (memory, clients)
    }

    #[test]
    fn resolves_links_counts_rollups_and_lookups() {
        let (memory, clients) = sample();
        let client = row(
            json!({ "id": 1, "order": 10000.0, "field_1": "Lumen", "field_16": r#"[{"id":1},{"id":21},{"id":99}]"# }),
        );
        let value = block_on(serialize_row(&memory, client, clients, false)).unwrap();
        assert_eq!(
            crate::json::stringify(&value),
            r#"{"id":1,"order":10000,"field_1":"Lumen","field_16":[{"id":21,"value":"A","order":"10000"},{"id":1,"value":"B","order":"20000"}],"field_39":"2","field_40":"1250.50","field_41":[{"id":21,"value":"250.0"},{"id":1,"value":"1000.5"}]}"#
        );
    }

    #[test]
    fn user_field_names_and_formulas() {
        let (memory, clients) = sample();
        let client = row(json!({ "id": 2, "order": null, "field_1": "X", "field_16": null }));
        let value = block_on(serialize_row(&memory, Rc::clone(&client), clients, true)).unwrap();
        assert_eq!(
            crate::json::stringify(&value),
            r#"{"id":2,"order":10000,"Nom":"X","Projets":[],"Nb":"0","Budget":"0.00","Budgets":[]}"#
        );
        let mut formula = meta(5, "F", "formula", false, json!({ "formula": "1+1" }));
        formula.formula = Some("1+1".into());
        let result = block_on(serialize_rows(
            &memory,
            vec![client],
            Rc::new(vec![formula]),
            false,
        ));
        assert!(matches!(result, Err(Failure::Unsupported(_))));
    }
}
