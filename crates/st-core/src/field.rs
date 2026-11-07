//! Table fields as the API describes them.
//!
//! The wire format is flat: the common attributes and the type-specific
//! settings share one JSON object. [`Field`] keeps that shape so that the same
//! struct can be read by the app and written by the Worker, and offers typed
//! views of the settings ([`Field::number_format`], [`Field::date_settings`]…)
//! so that the display code never parses raw strings itself.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::date::{DateFormat, DateSettings, TimeFormat};
use crate::duration::DurationFormat;
use crate::kinds::{FieldType, FormulaType};
use crate::number::{NumberFormat, NumberSeparator};

/// A field (column) of a table.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Field {
    pub id: u64,
    #[serde(default)]
    pub table_id: u64,
    pub name: String,
    #[serde(rename = "type")]
    pub field_type: FieldType,
    #[serde(default)]
    pub order: i64,
    #[serde(default)]
    pub primary: bool,
    #[serde(default)]
    pub read_only: bool,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(flatten)]
    pub settings: FieldSettings,
}

/// The type-specific settings of a field.
///
/// Every setting is optional because each one only exists for some field types;
/// the defaults applied when a setting is missing are the Worker's
/// (`fieldTypeDefaults` in `field-serialization.ts`).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct FieldSettings {
    // number, count, rollup, formula (number)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub number_decimal_places: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub number_prefix: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub number_suffix: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub number_separator: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub number_negative: Option<bool>,

    // date, created_on, last_modified, formula (date)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub date_format: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub date_include_time: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub date_time_format: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub date_show_tzinfo: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub date_force_timezone: Option<String>,

    // duration, formula (duration)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_format: Option<String>,

    // single_select, multiple_select, ai (choice)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub select_options: Option<Vec<SelectOption>>,

    // rating
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_value: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub style: Option<String>,

    // link_row
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub link_row_table_id: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub link_row_related_field_id: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub link_row_multiple_relationships: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub link_row_table_primary_field: Option<LinkedPrimaryField>,

    // formula, lookup, rollup, count
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub formula: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub formula_type: Option<FormulaType>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub array_formula_type: Option<FormulaType>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub formula_type_error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub through_field_id: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_field_id: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rollup_function: Option<String>,

    // ai
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ai_output_type: Option<String>,

    // long_text
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub long_text_enable_rich_text: Option<bool>,

    // multiple_collaborators
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub available_collaborators: Option<Vec<Collaborator>>,

    /// Every other attribute, kept so that nothing is lost when a field is
    /// written back (and so that newer settings survive older clients).
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// A choice of a single or multiple select field.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SelectOption {
    pub id: u64,
    pub value: String,
    /// A palette name such as `blue` or `dark-orange`, see [`crate::color`].
    #[serde(default)]
    pub color: String,
    #[serde(default)]
    pub order: i64,
}

/// A user that can be picked in a collaborator field.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Collaborator {
    pub id: u64,
    #[serde(default)]
    pub name: String,
}

/// The primary field of the table a link row field points to.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct LinkedPrimaryField {
    pub id: u64,
    #[serde(default)]
    pub table_id: u64,
    pub name: String,
    #[serde(rename = "type")]
    pub field_type: FieldType,
}

impl Field {
    /// The key of this field in a row object (`field_42`).
    pub fn row_key(&self) -> String {
        format!("field_{}", self.id)
    }

    /// How numbers of this field are written (number, count, rollup and
    /// number formulas share these settings).
    pub fn number_format(&self) -> NumberFormat {
        let settings = &self.settings;
        NumberFormat {
            decimal_places: settings.number_decimal_places.map(|places| places.min(10)),
            prefix: settings.number_prefix.clone().unwrap_or_default(),
            suffix: settings.number_suffix.clone().unwrap_or_default(),
            separator: NumberSeparator::from_setting(settings.number_separator.as_deref()),
        }
    }

    /// How dates of this field are written.
    pub fn date_settings(&self) -> DateSettings {
        let settings = &self.settings;
        // Created on and last modified fields default to showing the time,
        // plain dates and date formulas do not.
        let include_time_default = matches!(
            self.field_type,
            FieldType::CreatedOn | FieldType::LastModified
        );
        DateSettings {
            format: DateFormat::from_setting(settings.date_format.as_deref()),
            include_time: settings.date_include_time.unwrap_or(include_time_default),
            time_format: TimeFormat::from_setting(settings.date_time_format.as_deref()),
            show_timezone: settings.date_show_tzinfo.unwrap_or(false),
            force_timezone: settings.date_force_timezone.clone(),
        }
    }

    /// How durations of this field are written.
    pub fn duration_format(&self) -> DurationFormat {
        DurationFormat::from_setting(self.settings.duration_format.as_deref())
    }

    /// The options of a select field, empty for other types.
    pub fn select_options(&self) -> &[SelectOption] {
        self.settings.select_options.as_deref().unwrap_or_default()
    }

    /// The maximum of a rating field (5 when unset, like the Worker).
    pub fn rating_max(&self) -> u32 {
        self.settings.max_value.unwrap_or(5).clamp(1, 10)
    }

    /// The type of the value a formula, lookup or rollup field produces.
    pub fn formula_type(&self) -> Option<&FormulaType> {
        self.settings.formula_type.as_ref()
    }
}

/// Sorts fields the way the grid shows them when no view says otherwise: the
/// primary field first, then by `order`, then by id for fields created together.
pub fn sort_for_display(fields: &mut [Field]) {
    fields.sort_by_key(|field| (!field.primary, field.order, field.id));
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIELDS: &str = include_str!("../tests/data/fields_projets.json");

    fn fields() -> Vec<Field> {
        serde_json::from_str(FIELDS).expect("the captured fields deserialize")
    }

    fn by_name<'a>(fields: &'a [Field], name: &str) -> &'a Field {
        fields.iter().find(|field| field.name == name).unwrap()
    }

    #[test]
    fn captured_fields_cover_many_types() {
        let fields = fields();
        assert_eq!(fields.len(), 24);
        assert!(
            fields
                .iter()
                .all(|field| !matches!(field.field_type, FieldType::Other(_)))
        );
    }

    #[test]
    fn settings_are_typed() {
        let fields = fields();
        let budget = by_name(&fields, "Budget");
        assert_eq!(budget.field_type, FieldType::Number);
        assert_eq!(budget.number_format().decimal_places, Some(2));
        assert_eq!(budget.number_format().suffix, " €");

        let status = by_name(&fields, "Statut");
        assert_eq!(status.select_options().len(), 5);
        assert_eq!(status.select_options()[1].color, "blue");

        let lookup = by_name(&fields, "Secteur du client");
        assert_eq!(lookup.formula_type(), Some(&FormulaType::Array));
        assert_eq!(
            lookup.settings.array_formula_type,
            Some(FormulaType::SingleSelect)
        );

        let link = by_name(&fields, "Client");
        assert_eq!(link.settings.link_row_table_id, Some(1));
        assert_eq!(
            link.settings
                .link_row_table_primary_field
                .as_ref()
                .unwrap()
                .name,
            "Nom"
        );
    }

    #[test]
    fn unknown_settings_are_kept() {
        let fields = fields();
        let ai = by_name(&fields, "Résumé IA");
        assert_eq!(ai.settings.extra["ai_generative_ai_model"], "llama3.1");
        let written = serde_json::to_value(ai).unwrap();
        assert_eq!(written["ai_generative_ai_model"], "llama3.1");
        assert_eq!(written["type"], "ai");
    }

    #[test]
    fn primary_field_comes_first() {
        let mut fields = fields();
        fields.reverse();
        sort_for_display(&mut fields);
        assert!(fields[0].primary);
        assert!(
            fields
                .windows(2)
                .skip(1)
                .all(|pair| pair[0].order <= pair[1].order)
        );
    }
}
