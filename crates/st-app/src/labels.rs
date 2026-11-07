//! French texts of the interface that depend on domain values.
//!
//! These live in the app rather than in `st-core` because they are interface
//! wording; they will move to Fluent files with the rest of the translations.

use st_api::ClientError;
use st_core::{ApplicationType, FieldType};

/// The name of a field type, as the web app writes it in French.
pub fn field_type(field_type: &FieldType) -> &str {
    match field_type {
        FieldType::Text => "Texte sur une ligne",
        FieldType::LongText => "Texte long",
        FieldType::Url => "URL",
        FieldType::Email => "E-mail",
        FieldType::PhoneNumber => "Numéro de téléphone",
        FieldType::Number => "Nombre",
        FieldType::Rating => "Note",
        FieldType::Boolean => "Booléen",
        FieldType::Date => "Date",
        FieldType::Duration => "Durée",
        FieldType::LastModified => "Dernière modification",
        FieldType::CreatedOn => "Date de création",
        FieldType::LastModifiedBy => "Modifié par",
        FieldType::CreatedBy => "Créé par",
        FieldType::LinkRow => "Lien vers une table",
        FieldType::File => "Fichier",
        FieldType::SingleSelect => "Sélection unique",
        FieldType::MultipleSelect => "Sélection multiple",
        FieldType::MultipleCollaborators => "Collaborateurs",
        FieldType::Formula => "Formule",
        FieldType::Count => "Nombre de liens",
        FieldType::Lookup => "Recherche",
        FieldType::Rollup => "Agrégat",
        FieldType::Uuid => "UUID",
        FieldType::Autonumber => "Numérotation automatique",
        FieldType::Password => "Mot de passe",
        FieldType::Ai => "Champ IA",
        FieldType::Other(other) => other,
    }
}

/// An icon and a name for each kind of application in the sidebar.
pub fn application_type(application_type: &ApplicationType) -> (&'static str, &'static str) {
    match application_type {
        ApplicationType::Database => ("🗄", "Base de données"),
        ApplicationType::Dashboard => ("📊", "Tableau de bord"),
        ApplicationType::Document => ("📄", "Document"),
        ApplicationType::Whiteboard => ("🎨", "Tableau blanc"),
        ApplicationType::Builder => ("🌐", "Site"),
        ApplicationType::Automation => ("⚙", "Automatisation"),
        ApplicationType::Other(_) => ("❔", "Application"),
    }
}

/// Explains a failed API call to the user.
pub fn client_error(error: &ClientError) -> String {
    match error {
        ClientError::Network(detail) => format!("Impossible de joindre le serveur ({detail})."),
        ClientError::Api(api) => match (api.status, api.detail_text().as_str()) {
            (401, "Invalid credentials.") => "Adresse e-mail ou mot de passe incorrect.".to_owned(),
            (401, "Account is disabled.") => "Ce compte est désactivé.".to_owned(),
            (401, _) => "Votre session a expiré, reconnectez-vous.".to_owned(),
            (403, _) => "Vous n'avez pas accès à cette ressource.".to_owned(),
            (404, _) => "Cette ressource n'existe pas ou plus.".to_owned(),
            (status, "") => format!("Erreur du serveur (HTTP {status}, {}).", api.code),
            (status, detail) => format!(
                "Erreur du serveur : {detail} (HTTP {status}, {}).",
                api.code
            ),
        },
        ClientError::Decode(detail) => format!("Réponse inattendue du serveur : {detail}"),
    }
}

/// `10 000`: integers with the French thousands separator (a no-break space).
pub fn count(value: usize) -> String {
    st_core::number::group_thousands(&value.to_string(), "\u{a0}")
}

/// `1 ligne`, `10 000 lignes`.
pub fn rows(value: usize) -> String {
    if value < 2 {
        format!("{} ligne", count(value))
    } else {
        format!("{} lignes", count(value))
    }
}

#[cfg(test)]
mod tests {
    use st_api::ApiError;

    use super::*;

    #[test]
    fn explains_bad_credentials() {
        let error = ClientError::Api(ApiError::from_response(
            401,
            br#"{"error":"NOT_AUTHENTICATED","detail":"Invalid credentials."}"#,
        ));
        assert_eq!(
            client_error(&error),
            "Adresse e-mail ou mot de passe incorrect."
        );
    }

    #[test]
    fn keeps_server_details() {
        let error = ClientError::Api(ApiError::from_response(
            400,
            br#"{"error":"INVALID_REQUEST","detail":"items must be a non-empty array."}"#,
        ));
        assert_eq!(
            client_error(&error),
            "Erreur du serveur : items must be a non-empty array. (HTTP 400, INVALID_REQUEST)."
        );
    }

    #[test]
    fn counts_rows_in_french() {
        assert_eq!(rows(1), "1 ligne");
        assert_eq!(rows(10_000), "10\u{a0}000 lignes");
    }
}
