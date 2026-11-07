//! The endpoints the clients call, one constructor per route.
//!
//! Paths and parameters follow the TypeScript Worker (`src/routes/…`); keeping
//! them here, next to their response types, is what lets the Rust Worker and
//! the app agree on the contract.

use serde_json::{Map, Value, json};
use st_core::Field;

use crate::auth::{AuthResponse, LoginRequest, LoginResponse, RefreshRequest};
use crate::request::{ApiRequest, Method};
use crate::row::{BatchRows, BatchRowsResponse, Row, RowPage, RowsQuery};
use crate::workspace::{Application, Table, Workspace};

fn to_json(value: &impl serde::Serialize) -> Value {
    serde_json::to_value(value).expect("request bodies serialize")
}

/// `POST /api/user/token-auth/`: logs in with e-mail and password.
pub fn login(request: &LoginRequest) -> ApiRequest<LoginResponse> {
    ApiRequest::new(Method::Post, "/api/user/token-auth/")
        .with_body(to_json(request))
        .anonymous()
}

/// `POST /api/user/token-refresh/`: trades the refresh token for a new access token.
pub fn refresh(refresh_token: &str) -> ApiRequest<AuthResponse> {
    let body = RefreshRequest {
        refresh_token: refresh_token.to_owned(),
    };
    ApiRequest::new(Method::Post, "/api/user/token-refresh/")
        .with_body(to_json(&body))
        .anonymous()
}

/// `POST /api/user/token-blacklist/`: invalidates the refresh token (logout).
pub fn logout(refresh_token: &str) -> ApiRequest<Value> {
    let body = RefreshRequest {
        refresh_token: refresh_token.to_owned(),
    };
    ApiRequest::new(Method::Post, "/api/user/token-blacklist/")
        .with_body(to_json(&body))
        .anonymous()
}

/// `GET /api/workspaces/`: the workspaces of the user, with their applications.
pub fn workspaces() -> ApiRequest<Vec<Workspace>> {
    ApiRequest::get("/api/workspaces/")
}

/// `GET /api/applications/`: every application of the user, databases with
/// their tables.
pub fn applications() -> ApiRequest<Vec<Application>> {
    ApiRequest::get("/api/applications/")
}

/// `POST /api/database/tables/database/{id}/`: creates an empty table.
pub fn create_table(database_id: u64, name: &str) -> ApiRequest<Table> {
    ApiRequest::new(
        Method::Post,
        format!("/api/database/tables/database/{database_id}/"),
    )
    .with_body(json!({ "name": name }))
}

/// `GET /api/database/fields/table/{id}/`: the fields of a table.
pub fn fields(table_id: u64) -> ApiRequest<Vec<Field>> {
    ApiRequest::get(format!("/api/database/fields/table/{table_id}/"))
}

/// `POST /api/database/fields/table/{id}/`: creates a field; `settings` holds
/// the type-specific attributes (`number_decimal_places`, `select_options`…).
pub fn create_field(
    table_id: u64,
    name: &str,
    field_type: &str,
    settings: Map<String, Value>,
) -> ApiRequest<Field> {
    let mut body = settings;
    body.insert("name".into(), name.into());
    body.insert("type".into(), field_type.into());
    ApiRequest::new(
        Method::Post,
        format!("/api/database/fields/table/{table_id}/"),
    )
    .with_body(Value::Object(body))
}

/// `GET /api/database/rows/table/{id}/`: one page of rows.
pub fn rows(table_id: u64, query: &RowsQuery) -> ApiRequest<RowPage> {
    let mut request = ApiRequest::get(format!("/api/database/rows/table/{table_id}/"))
        .with_query("page", query.page)
        .with_query("size", query.size);
    if let Some(search) = query.search.as_deref().filter(|search| !search.is_empty()) {
        request = request.with_query("search", search);
    }
    if let Some(order_by) = query.order_by.as_deref().filter(|order| !order.is_empty()) {
        request = request.with_query("order_by", order_by);
    }
    request
}

/// `PATCH /api/database/rows/table/{table}/{row}/`: changes some values of a row.
pub fn update_row(table_id: u64, row_id: u64, values: Map<String, Value>) -> ApiRequest<Row> {
    ApiRequest::new(
        Method::Patch,
        format!("/api/database/rows/table/{table_id}/{row_id}/"),
    )
    .with_body(Value::Object(values))
}

/// `POST /api/database/rows/table/{id}/batch/`: creates up to 200 rows.
pub fn create_rows(table_id: u64, rows: &BatchRows) -> ApiRequest<BatchRowsResponse> {
    ApiRequest::new(
        Method::Post,
        format!("/api/database/rows/table/{table_id}/batch/"),
    )
    .with_body(to_json(rows))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn login_is_anonymous_and_sends_credentials() {
        let request = login(&LoginRequest {
            email: "a@example.com".into(),
            password: "secret".into(),
        });
        assert!(!request.authenticated);
        assert_eq!(request.method, Method::Post);
        assert_eq!(request.body.unwrap()["email"], "a@example.com");
    }

    #[test]
    fn row_listing_carries_paging_and_optional_filters() {
        let query = RowsQuery {
            page: 3,
            size: 200,
            search: Some(String::new()),
            order_by: Some("-field_2".into()),
        };
        assert_eq!(
            rows(7, &query).url(""),
            "/api/database/rows/table/7/?page=3&size=200&order_by=-field_2"
        );
    }

    #[test]
    fn update_row_patches_the_row() {
        let mut values = Map::new();
        values.insert("field_1".into(), "Nouveau nom".into());
        let request = update_row(1, 42, values);
        assert_eq!(request.method, Method::Patch);
        assert_eq!(request.path, "/api/database/rows/table/1/42/");
    }

    #[test]
    fn create_field_merges_settings() {
        let mut settings = Map::new();
        settings.insert("number_decimal_places".into(), 2.into());
        let body = create_field(5, "Montant", "number", settings).body.unwrap();
        assert_eq!(
            body,
            json!({"name": "Montant", "type": "number", "number_decimal_places": 2})
        );
    }
}
