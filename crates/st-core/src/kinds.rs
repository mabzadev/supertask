//! The "type" vocabularies of Supertask: fields, formula results, views and
//! applications.

use crate::string_enum::string_enum;

string_enum! {
    /// The type of a table field, as stored in `database_field.type`.
    pub enum FieldType {
        Text => "text",
        LongText => "long_text",
        Url => "url",
        Email => "email",
        PhoneNumber => "phone_number",
        Number => "number",
        Rating => "rating",
        Boolean => "boolean",
        Date => "date",
        Duration => "duration",
        LastModified => "last_modified",
        CreatedOn => "created_on",
        LastModifiedBy => "last_modified_by",
        CreatedBy => "created_by",
        LinkRow => "link_row",
        File => "file",
        SingleSelect => "single_select",
        MultipleSelect => "multiple_select",
        MultipleCollaborators => "multiple_collaborators",
        Formula => "formula",
        Count => "count",
        Lookup => "lookup",
        Rollup => "rollup",
        Uuid => "uuid",
        /// `auto_number` is an older spelling some rows of `database_field` still carry.
        Autonumber => "autonumber" | "auto_number",
        Password => "password",
        Ai => "ai",
    }
}

impl FieldType {
    /// Whether the server computes the value, so that a client must never send it.
    ///
    /// Mirrors `COMPUTED_FIELD_TYPES` of the TypeScript Worker.
    pub fn is_computed(&self) -> bool {
        matches!(
            self,
            Self::Formula
                | Self::Count
                | Self::Lookup
                | Self::Rollup
                | Self::LastModified
                | Self::CreatedOn
                | Self::LastModifiedBy
                | Self::CreatedBy
                | Self::Autonumber
                | Self::Uuid
        )
    }

    /// Whether a cell of this type is a single line of text that a grid can
    /// edit in place. Long text is left out on purpose: a one-line editor would
    /// silently drop its line breaks.
    pub fn is_inline_editable(&self) -> bool {
        matches!(
            self,
            Self::Text | Self::Url | Self::Email | Self::PhoneNumber | Self::Number
        )
    }
}

string_enum! {
    /// The type of the value a formula, lookup or rollup produces
    /// (`formula_type` and `array_formula_type` of a field).
    pub enum FormulaType {
        Text => "text",
        Char => "char",
        Number => "number",
        Boolean => "boolean",
        Date => "date",
        DateInterval => "date_interval",
        Duration => "duration",
        Array => "array",
        SingleSelect => "single_select",
        MultipleSelect => "multiple_select",
        MultipleCollaborators => "multiple_collaborators",
        Link => "link",
        Button => "button",
        Url => "url",
        SingleFile => "single_file",
        Special => "special",
        Invalid => "invalid",
    }
}

string_enum! {
    /// The type of a table view.
    pub enum ViewType {
        Grid => "grid",
        Gallery => "gallery",
        Form => "form",
        Survey => "survey",
        Kanban => "kanban",
        Calendar => "calendar",
        Timeline => "timeline",
    }
}

string_enum! {
    /// The type of a workspace application.
    pub enum ApplicationType {
        Database => "database",
        Dashboard => "dashboard",
        Document => "document",
        Whiteboard => "whiteboard",
        Builder => "builder",
        Automation => "automation",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_names_round_trip() {
        for kind in FieldType::KNOWN {
            assert_eq!(&FieldType::from(kind.as_str()), kind);
        }
        for kind in ViewType::KNOWN {
            assert_eq!(&ViewType::from(kind.as_str()), kind);
        }
    }

    #[test]
    fn legacy_alias_reads_as_canonical_type() {
        assert_eq!(FieldType::from("auto_number"), FieldType::Autonumber);
        assert_eq!(FieldType::Autonumber.as_str(), "autonumber");
    }

    #[test]
    fn unknown_type_is_kept_verbatim() {
        let kind: FieldType = serde_json::from_str("\"hologram\"").unwrap();
        assert_eq!(kind, FieldType::Other("hologram".into()));
        assert_eq!(serde_json::to_string(&kind).unwrap(), "\"hologram\"");
    }

    #[test]
    fn computed_types_match_the_worker() {
        assert!(FieldType::Formula.is_computed());
        assert!(FieldType::Uuid.is_computed());
        assert!(!FieldType::Text.is_computed());
        assert!(!FieldType::Ai.is_computed());
    }
}
