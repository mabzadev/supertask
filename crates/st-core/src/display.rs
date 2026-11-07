//! What a cell shows, independently of how it is drawn.
//!
//! [`display_cell`] turns the JSON value of a row and the field it belongs to
//! into a [`CellDisplay`]: text already formatted with the field settings,
//! chips with their colors, a rating, a checkbox… The egui grid only draws
//! these, so the formatting rules are written once, tested here, and reusable by
//! any other client (exports, the public HTML pages).

use serde_json::Value;

use crate::color::{self, NEUTRAL_CHIP, Rgb};
use crate::date::{DateSettings, LocalZone};
use crate::duration::DurationFormat;
use crate::field::Field;
use crate::kinds::{FieldType, FormulaType};
use crate::number::NumberFormat;

/// The display of one cell.
#[derive(Clone, Debug, PartialEq)]
pub enum CellDisplay {
    /// Nothing to show.
    Empty,
    /// Left-aligned text on one line.
    Text(String),
    /// Text in a fixed-width font (identifiers such as UUIDs).
    Code(String),
    /// Right-aligned formatted number, date or duration.
    Number(String),
    /// A clickable text: a URL, an e-mail address or a phone number.
    Link { text: String, href: String },
    /// A read-only checkbox.
    Boolean(bool),
    /// Colored labels: select options, linked rows, collaborators, lookups.
    Chips(Vec<Chip>),
    /// `value` filled symbols out of `max`.
    Rating { value: u32, max: u32, color: Rgb },
    /// Attached files: how many, and their names.
    Files(Vec<String>),
    /// A secret that is set but never shown.
    Hidden,
    /// The value cannot be computed (a broken formula).
    Error(String),
}

/// A label with a background color.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Chip {
    pub label: String,
    pub color: Rgb,
}

impl Chip {
    fn neutral(label: impl Into<String>) -> Self {
        Self {
            label: label.into(),
            color: NEUTRAL_CHIP,
        }
    }

    fn colored(label: impl Into<String>, color_name: &str) -> Self {
        Self {
            label: label.into(),
            color: color::palette(color_name).unwrap_or(NEUTRAL_CHIP),
        }
    }
}

impl CellDisplay {
    /// A plain-text rendering, for tooltips, copy and search.
    pub fn plain_text(&self) -> String {
        match self {
            Self::Empty => String::new(),
            Self::Text(text) | Self::Code(text) | Self::Number(text) | Self::Error(text) => {
                text.clone()
            }
            Self::Link { text, .. } => text.clone(),
            Self::Boolean(true) => "✔".to_owned(),
            Self::Boolean(false) => String::new(),
            Self::Chips(chips) => chips
                .iter()
                .map(|chip| chip.label.as_str())
                .collect::<Vec<_>>()
                .join(", "),
            Self::Rating { value, max, .. } => format!("{value}/{max}"),
            Self::Files(names) => names.join(", "),
            Self::Hidden => "••••••••".to_owned(),
        }
    }
}

/// What the formatting needs from its surroundings.
pub struct DisplayContext<'a> {
    /// The viewer's time zone, for dates with a time.
    pub zone: &'a dyn LocalZone,
}

/// Formats the value of `field` in a row.
pub fn display_cell(field: &Field, value: &Value, context: &DisplayContext<'_>) -> CellDisplay {
    if value.is_null() {
        return CellDisplay::Empty;
    }
    match &field.field_type {
        FieldType::Text => text(value),
        FieldType::LongText => long_text(value),
        FieldType::Url => link(value, ""),
        FieldType::Email => link(value, "mailto:"),
        FieldType::PhoneNumber => link(value, "tel:"),
        FieldType::Number | FieldType::Count | FieldType::Rollup => {
            number(&field.number_format(), value)
        }
        FieldType::Autonumber => number(&NumberFormat::default(), value),
        FieldType::Rating => rating(field, value),
        FieldType::Boolean => CellDisplay::Boolean(truthy(value)),
        FieldType::Date | FieldType::CreatedOn | FieldType::LastModified => {
            date(&field.date_settings(), value, context)
        }
        FieldType::Duration => duration(field.duration_format(), value),
        FieldType::CreatedBy | FieldType::LastModifiedBy => user(value),
        FieldType::MultipleCollaborators => {
            chips_of(value, |item| name_of(item).map(Chip::neutral))
        }
        FieldType::SingleSelect => chips_of(value, option_chip),
        FieldType::MultipleSelect => chips_of(value, option_chip),
        FieldType::LinkRow => chips_of(value, |item| {
            item.get("value")
                .map(|inner| Chip::neutral(inline_text(inner)))
        }),
        FieldType::File => files(value),
        FieldType::Uuid => match value.as_str() {
            Some(uuid) => CellDisplay::Code(uuid.to_owned()),
            None => text(value),
        },
        FieldType::Password => {
            if truthy(value) {
                CellDisplay::Hidden
            } else {
                CellDisplay::Empty
            }
        }
        FieldType::Ai => match value {
            Value::Object(_) => chips_of(value, option_chip),
            _ => long_text(value),
        },
        FieldType::Formula | FieldType::Lookup => computed(field, value, context),
        FieldType::Other(_) => text(value),
    }
}

/// Formula and lookup values take the shape of their result type.
fn computed(field: &Field, value: &Value, context: &DisplayContext<'_>) -> CellDisplay {
    if let Some(error) = &field.settings.formula_type_error {
        return CellDisplay::Error(error.clone());
    }
    let formula_type = field.formula_type().cloned().unwrap_or(FormulaType::Text);
    if formula_type == FormulaType::Array {
        let item_type = field
            .settings
            .array_formula_type
            .clone()
            .unwrap_or(FormulaType::Text);
        return array(field, &item_type, value, context);
    }
    scalar(field, &formula_type, value, context)
}

fn scalar(
    field: &Field,
    formula_type: &FormulaType,
    value: &Value,
    context: &DisplayContext<'_>,
) -> CellDisplay {
    match formula_type {
        FormulaType::Number => number(&field.number_format(), value),
        FormulaType::Boolean => CellDisplay::Boolean(truthy(value)),
        FormulaType::Date => date(&field.date_settings(), value, context),
        FormulaType::Duration => duration(field.duration_format(), value),
        FormulaType::SingleSelect | FormulaType::MultipleSelect => chips_of(value, option_chip),
        FormulaType::MultipleCollaborators => {
            chips_of(value, |item| name_of(item).map(Chip::neutral))
        }
        FormulaType::Link | FormulaType::Button => formula_link(value),
        FormulaType::Url => link(value, ""),
        FormulaType::SingleFile => files(value),
        FormulaType::Invalid => CellDisplay::Error("Formule invalide".to_owned()),
        FormulaType::Array => array(field, &FormulaType::Text, value, context),
        FormulaType::Text
        | FormulaType::Char
        | FormulaType::DateInterval
        | FormulaType::Special
        | FormulaType::Other(_) => long_text(value),
    }
}

/// Arrays (lookups, formulas over links) come as `[{id, value}]`; each item is
/// shown as a chip formatted with the item type.
fn array(
    field: &Field,
    item_type: &FormulaType,
    value: &Value,
    context: &DisplayContext<'_>,
) -> CellDisplay {
    let Some(items) = value.as_array() else {
        return scalar(field, item_type, value, context);
    };
    let mut chips = Vec::with_capacity(items.len());
    for item in items {
        let inner = item.get("value").unwrap_or(item);
        match scalar(field, item_type, inner, context) {
            CellDisplay::Empty => {}
            CellDisplay::Chips(inner_chips) => chips.extend(inner_chips),
            CellDisplay::Boolean(checked) => {
                chips.push(Chip::neutral(if checked { "✔" } else { "✘" }))
            }
            other => chips.push(Chip::neutral(other.plain_text())),
        }
    }
    if chips.is_empty() {
        CellDisplay::Empty
    } else {
        CellDisplay::Chips(chips)
    }
}

/// The single-line text of a value, whatever its JSON type.
fn inline_text(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::String(text) => first_line(text),
        Value::Bool(true) => "✔".to_owned(),
        Value::Bool(false) => String::new(),
        Value::Number(number) => number.to_string(),
        Value::Array(items) => items.iter().map(inline_text).collect::<Vec<_>>().join(", "),
        Value::Object(map) => map
            .get("value")
            .or_else(|| map.get("name"))
            .or_else(|| map.get("label"))
            .map(inline_text)
            .unwrap_or_default(),
    }
}

/// The first line of a text, with an ellipsis when lines were dropped: the
/// grid shows one line per row.
fn first_line(text: &str) -> String {
    let trimmed = text.trim();
    match trimmed.split_once('\n') {
        Some((first, _)) => format!("{} …", first.trim_end()),
        None => trimmed.to_owned(),
    }
}

fn text(value: &Value) -> CellDisplay {
    non_empty(inline_text(value), CellDisplay::Text)
}

fn long_text(value: &Value) -> CellDisplay {
    text(value)
}

fn non_empty(text: String, wrap: impl FnOnce(String) -> CellDisplay) -> CellDisplay {
    if text.is_empty() {
        CellDisplay::Empty
    } else {
        wrap(text)
    }
}

fn link(value: &Value, scheme: &str) -> CellDisplay {
    let text = inline_text(value);
    if text.is_empty() {
        return CellDisplay::Empty;
    }
    let href = if scheme.is_empty() {
        if text.contains("://") {
            text.clone()
        } else {
            format!("https://{text}")
        }
    } else {
        format!("{scheme}{}", text.replace(' ', ""))
    };
    CellDisplay::Link { text, href }
}

/// Link and button formulas produce `{url, label}`.
fn formula_link(value: &Value) -> CellDisplay {
    let url = value.get("url").and_then(Value::as_str).unwrap_or_default();
    let label = value
        .get("label")
        .and_then(Value::as_str)
        .filter(|label| !label.is_empty())
        .unwrap_or(url);
    if url.is_empty() {
        return text(value);
    }
    CellDisplay::Link {
        text: label.to_owned(),
        href: url.to_owned(),
    }
}

fn number(format: &NumberFormat, value: &Value) -> CellDisplay {
    let raw = match value {
        Value::String(text) => text.clone(),
        Value::Number(number) => number.to_string(),
        other => return text(other),
    };
    if raw.trim().is_empty() {
        return CellDisplay::Empty;
    }
    CellDisplay::Number(format.format(&raw).unwrap_or(raw))
}

fn rating(field: &Field, value: &Value) -> CellDisplay {
    let max = field.rating_max();
    let value = as_f64(value).unwrap_or(0.0).clamp(0.0, f64::from(max)) as u32;
    let color = color::rating_color(field.settings.color.as_deref().unwrap_or("dark-orange"));
    CellDisplay::Rating { value, max, color }
}

fn date(settings: &DateSettings, value: &Value, context: &DisplayContext<'_>) -> CellDisplay {
    match value.as_str() {
        Some(raw) if !raw.trim().is_empty() => CellDisplay::Number(
            settings
                .format(raw, context.zone)
                .unwrap_or_else(|| raw.to_owned()),
        ),
        Some(_) => CellDisplay::Empty,
        None => text(value),
    }
}

fn duration(format: DurationFormat, value: &Value) -> CellDisplay {
    match as_f64(value) {
        Some(seconds) => CellDisplay::Number(format.format(seconds)),
        None => text(value),
    }
}

fn user(value: &Value) -> CellDisplay {
    match name_of(value) {
        Some(name) => CellDisplay::Chips(vec![Chip::neutral(name)]),
        None => CellDisplay::Empty,
    }
}

fn name_of(value: &Value) -> Option<String> {
    let name = value
        .get("name")
        .and_then(Value::as_str)
        .filter(|name| !name.is_empty());
    let email = value.get("email").and_then(Value::as_str);
    name.or(email).map(str::to_owned)
}

fn option_chip(value: &Value) -> Option<Chip> {
    let label = value.get("value").map(inline_text)?;
    let color = value
        .get("color")
        .and_then(Value::as_str)
        .unwrap_or_default();
    Some(Chip::colored(label, color))
}

/// Applies `chip` to every item of an array, or to the value itself when it is
/// a single object (single select).
fn chips_of(value: &Value, chip: impl Fn(&Value) -> Option<Chip>) -> CellDisplay {
    let chips: Vec<Chip> = match value {
        Value::Array(items) => items.iter().filter_map(&chip).collect(),
        Value::Object(_) => chip(value).into_iter().collect(),
        Value::Null => Vec::new(),
        other => vec![Chip::neutral(inline_text(other))],
    };
    if chips.is_empty() {
        CellDisplay::Empty
    } else {
        CellDisplay::Chips(chips)
    }
}

fn files(value: &Value) -> CellDisplay {
    let items: Vec<&Value> = match value {
        Value::Array(items) => items.iter().collect(),
        Value::Object(_) => vec![value],
        _ => Vec::new(),
    };
    let names: Vec<String> = items
        .into_iter()
        .filter_map(|file| {
            file.get("visible_name")
                .or_else(|| file.get("name"))
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .collect();
    if names.is_empty() {
        CellDisplay::Empty
    } else {
        CellDisplay::Files(names)
    }
}

fn truthy(value: &Value) -> bool {
    match value {
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64().is_some_and(|number| number != 0.0),
        Value::String(text) => matches!(
            text.trim().to_lowercase().as_str(),
            "true" | "t" | "1" | "on" | "yes" | "checked"
        ),
        Value::Null => false,
        Value::Array(items) => !items.is_empty(),
        Value::Object(_) => true,
    }
}

fn as_f64(value: &Value) -> Option<f64> {
    match value {
        Value::Number(number) => number.as_f64(),
        Value::String(text) => text.trim().parse().ok(),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use chrono::FixedOffset;
    use serde_json::json;

    use super::*;

    fn fields(json: &str) -> Vec<Field> {
        serde_json::from_str(json).unwrap()
    }

    fn rows(json: &str) -> Vec<serde_json::Map<String, Value>> {
        let page: Value = serde_json::from_str(json).unwrap();
        page["results"]
            .as_array()
            .unwrap()
            .iter()
            .map(|row| row.as_object().unwrap().clone())
            .collect()
    }

    /// Displays every cell of the first captured row of a table, by field name.
    fn first_row(fields_json: &str, rows_json: &str) -> Vec<(String, CellDisplay)> {
        let zone = FixedOffset::east_opt(3600).unwrap();
        let context = DisplayContext { zone: &zone };
        let row = rows(rows_json).remove(0);
        fields(fields_json)
            .iter()
            .map(|field| {
                let value = row.get(&field.row_key()).unwrap_or(&Value::Null);
                (field.name.clone(), display_cell(field, value, &context))
            })
            .collect()
    }

    fn cell<'a>(cells: &'a [(String, CellDisplay)], name: &str) -> &'a CellDisplay {
        &cells
            .iter()
            .find(|(field, _)| field == name)
            .unwrap_or_else(|| panic!("no field {name}"))
            .1
    }

    fn chip_labels(display: &CellDisplay) -> Vec<&str> {
        match display {
            CellDisplay::Chips(chips) => chips.iter().map(|chip| chip.label.as_str()).collect(),
            other => panic!("expected chips, got {other:?}"),
        }
    }

    const PROJETS_FIELDS: &str = include_str!("../tests/data/fields_projets.json");
    const PROJETS_ROWS: &str = include_str!("../tests/data/rows_projets.json");
    const CLIENTS_FIELDS: &str = include_str!("../tests/data/fields_clients.json");
    const CLIENTS_ROWS: &str = include_str!("../tests/data/rows_clients.json");

    #[test]
    fn projets_row_is_displayed_like_the_web_app() {
        let cells = first_row(PROJETS_FIELDS, PROJETS_ROWS);
        assert_eq!(
            cell(&cells, "Nom"),
            &CellDisplay::Text("Refonte du site".into())
        );
        assert_eq!(chip_labels(cell(&cells, "Client")), ["Atelier Lumen"]);
        assert_eq!(chip_labels(cell(&cells, "Statut")), ["Bloqué"]);
        let CellDisplay::Chips(status) = cell(&cells, "Statut") else {
            unreachable!()
        };
        assert_eq!(status[0].color, color::palette("red").unwrap());
        assert_eq!(
            chip_labels(cell(&cells, "Étiquettes")),
            ["Design", "Contenu", "Data"]
        );
        assert_eq!(chip_labels(cell(&cells, "Responsables")), ["Mabza"]);
        assert_eq!(
            cell(&cells, "Début"),
            &CellDisplay::Number("13/09/2026".into())
        );
        // 15:30 UTC seen from UTC+1.
        assert_eq!(
            cell(&cells, "Prochain point"),
            &CellDisplay::Number("15/09/2026 16:30".into())
        );
        assert_eq!(
            cell(&cells, "Budget"),
            &CellDisplay::Number("27700.00 €".into())
        );
        assert_eq!(
            cell(&cells, "Avancement"),
            &CellDisplay::Number("27 %".into())
        );
        assert_eq!(
            cell(&cells, "Temps passé"),
            &CellDisplay::Number("41:00".into())
        );
        assert_eq!(cell(&cells, "Livré"), &CellDisplay::Boolean(false));
        assert_eq!(
            cell(&cells, "Brief"),
            &CellDisplay::Text("Objectifs, livrables et contraintes du projet. …".into())
        );
        assert_eq!(cell(&cells, "Visuels"), &CellDisplay::Empty);
        assert_eq!(cell(&cells, "Code d'accès"), &CellDisplay::Hidden);
        assert_eq!(
            cell(&cells, "Créé le"),
            &CellDisplay::Number("07/11/2026 09:31".into())
        );
        assert_eq!(
            chip_labels(cell(&cells, "Créé par")),
            ["mabzadev@gmail.com"]
        );
        assert_eq!(
            cell(&cells, "Jours restants"),
            &CellDisplay::Number("-29".into())
        );
        assert_eq!(
            cell(&cells, "Résumé"),
            &CellDisplay::Text("Refonte du site — 27 %".into())
        );
        assert_eq!(chip_labels(cell(&cells, "Secteur du client")), ["Commerce"]);
        assert_eq!(cell(&cells, "Résumé IA"), &CellDisplay::Empty);
    }

    #[test]
    fn clients_row_is_displayed_like_the_web_app() {
        let cells = first_row(CLIENTS_FIELDS, CLIENTS_ROWS);
        assert_eq!(
            cell(&cells, "Site web"),
            &CellDisplay::Link {
                text: "https://atelierlumen.example.com".into(),
                href: "https://atelierlumen.example.com".into()
            }
        );
        assert_eq!(
            cell(&cells, "E-mail"),
            &CellDisplay::Link {
                text: "contact@atelierlumen.example.com".into(),
                href: "mailto:contact@atelierlumen.example.com".into()
            }
        );
        let CellDisplay::Link { href, .. } = cell(&cells, "Téléphone") else {
            panic!()
        };
        assert_eq!(href, "tel:+41229724529");
        assert_eq!(
            cell(&cells, "Client depuis"),
            &CellDisplay::Number("24/02/2025".into())
        );
        assert!(matches!(
            cell(&cells, "Satisfaction"),
            CellDisplay::Rating {
                value: 5,
                max: 5,
                ..
            }
        ));
        assert_eq!(cell(&cells, "Actif"), &CellDisplay::Boolean(true));
        assert_eq!(
            cell(&cells, "Logo"),
            &CellDisplay::Files(vec!["violet.png".into()])
        );
        assert!(matches!(cell(&cells, "Référence"), CellDisplay::Code(uuid) if uuid.len() == 36));
        assert_eq!(cell(&cells, "N°"), &CellDisplay::Number("1".into()));
        assert_eq!(chip_labels(cell(&cells, "Projets")).len(), 3);
        assert_eq!(
            cell(&cells, "Nombre de projets"),
            &CellDisplay::Number("3".into())
        );
        assert_eq!(
            cell(&cells, "Budget total"),
            &CellDisplay::Number("68400.00 €".into())
        );
    }

    fn field(json: Value) -> Field {
        serde_json::from_value(json).unwrap()
    }

    fn show(field: &Field, value: Value) -> CellDisplay {
        let utc = FixedOffset::east_opt(0).unwrap();
        display_cell(field, &value, &DisplayContext { zone: &utc })
    }

    #[test]
    fn formulas_follow_their_result_type() {
        let boolean =
            field(json!({"id": 1, "name": "f", "type": "formula", "formula_type": "boolean"}));
        assert_eq!(show(&boolean, json!(true)), CellDisplay::Boolean(true));

        let date = field(
            json!({"id": 1, "name": "f", "type": "formula", "formula_type": "date", "date_format": "ISO"}),
        );
        assert_eq!(
            show(&date, json!("2026-01-02")),
            CellDisplay::Number("2026-01-02".into())
        );

        let button =
            field(json!({"id": 1, "name": "f", "type": "formula", "formula_type": "button"}));
        assert_eq!(
            show(
                &button,
                json!({"url": "https://example.com", "label": "Ouvrir"})
            ),
            CellDisplay::Link {
                text: "Ouvrir".into(),
                href: "https://example.com".into()
            }
        );

        let numbers = field(json!({
            "id": 1, "name": "f", "type": "formula", "formula_type": "array",
            "array_formula_type": "number", "number_decimal_places": 1
        }));
        assert_eq!(
            chip_labels(&show(
                &numbers,
                json!([{"id": 1, "value": "2"}, {"id": 2, "value": "3.25"}])
            )),
            ["2.0", "3.3"]
        );

        let broken = field(
            json!({"id": 1, "name": "f", "type": "formula", "formula_type": "invalid", "formula_type_error": "Champ inconnu"}),
        );
        assert_eq!(show(&broken, json!(null)), CellDisplay::Empty);
        assert_eq!(
            show(&broken, json!("x")),
            CellDisplay::Error("Champ inconnu".into())
        );
    }

    #[test]
    fn ai_choice_shows_a_chip() {
        let ai = field(json!({"id": 1, "name": "f", "type": "ai", "ai_output_type": "choice"}));
        assert_eq!(
            chip_labels(&show(
                &ai,
                json!({"id": 3, "value": "Oui", "color": "green"})
            )),
            ["Oui"]
        );
        let ai_text = field(json!({"id": 1, "name": "f", "type": "ai"}));
        assert_eq!(
            show(&ai_text, json!("Une phrase.")),
            CellDisplay::Text("Une phrase.".into())
        );
    }

    #[test]
    fn empty_values_show_nothing() {
        let text = field(json!({"id": 1, "name": "f", "type": "text"}));
        assert_eq!(show(&text, json!("")), CellDisplay::Empty);
        let select = field(json!({"id": 1, "name": "f", "type": "multiple_select"}));
        assert_eq!(show(&select, json!([])), CellDisplay::Empty);
        let password = field(json!({"id": 1, "name": "f", "type": "password"}));
        assert_eq!(show(&password, json!(null)), CellDisplay::Empty);
        let number = field(json!({"id": 1, "name": "f", "type": "number"}));
        assert_eq!(show(&number, json!("")), CellDisplay::Empty);
    }

    #[test]
    fn unknown_types_still_show_their_text() {
        let future = field(json!({"id": 1, "name": "f", "type": "hologram"}));
        assert_eq!(
            show(&future, json!({"value": "3D"})),
            CellDisplay::Text("3D".into())
        );
    }

    #[test]
    fn rating_is_clamped_to_its_maximum() {
        let rating = field(json!({"id": 1, "name": "f", "type": "rating", "max_value": 3}));
        assert!(matches!(
            show(&rating, json!(7)),
            CellDisplay::Rating {
                value: 3,
                max: 3,
                ..
            }
        ));
    }
}
