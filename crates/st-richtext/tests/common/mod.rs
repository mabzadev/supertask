//! Helpers shared by the integration tests.
#![allow(dead_code)]

use serde_json::{Map, Value, json};
use st_richtext::RichTextDoc;

/// The Yjs state of the "Spéc : export PDF" page (see tools/capture-fixture.cjs).
pub fn fixture() -> Vec<u8> {
    std::fs::read(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/spec-export-pdf.yjs"
    ))
    .expect("fixture present")
}

/// What y-prosemirror builds from the fixture, normalized.
pub fn fixture_prosemirror() -> Value {
    let text = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/spec-export-pdf.prosemirror.json"
    ))
    .expect("golden file present");
    serde_json::from_str(&text).expect("valid JSON")
}

/// Same normalization as `normalize()` in tools/common.cjs: null attributes
/// dropped, marks sorted, adjacent text with the same marks merged.
pub fn normalize(value: &Value) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.iter().map(normalize).collect()),
        Value::Object(map) => {
            let mut out = Map::new();
            for (key, value) in map {
                match key.as_str() {
                    "attrs" => {
                        let attrs: Map<String, Value> = value
                            .as_object()
                            .into_iter()
                            .flatten()
                            .filter(|(_, v)| !v.is_null())
                            .map(|(k, v)| (k.clone(), v.clone()))
                            .collect();
                        if !attrs.is_empty() {
                            out.insert(key.clone(), Value::Object(attrs));
                        }
                    }
                    "marks" => {
                        let mut marks: Vec<Value> = value
                            .as_array()
                            .into_iter()
                            .flatten()
                            .map(normalize)
                            .collect();
                        marks.sort_by_key(|m| m.to_string());
                        if !marks.is_empty() {
                            out.insert(key.clone(), Value::Array(marks));
                        }
                    }
                    "content" => {
                        let mut content: Vec<Value> = Vec::new();
                        for child in value.as_array().into_iter().flatten().map(normalize) {
                            let same_marks =
                                |a: &Value, b: &Value| a.get("marks") == b.get("marks");
                            match content.last_mut() {
                                Some(last)
                                    if last["type"] == "text"
                                        && child["type"] == "text"
                                        && same_marks(last, &child) =>
                                {
                                    let text = format!(
                                        "{}{}",
                                        last["text"].as_str().unwrap_or_default(),
                                        child["text"].as_str().unwrap_or_default()
                                    );
                                    last["text"] = Value::String(text);
                                }
                                _ => content.push(child),
                            }
                        }
                        if !content.is_empty() {
                            out.insert(key.clone(), Value::Array(content));
                        }
                    }
                    _ => {
                        out.insert(key.clone(), value.clone());
                    }
                }
            }
            Value::Object(out)
        }
        other => other.clone(),
    }
}

pub fn text(value: &str) -> Value {
    json!({ "type": "text", "text": value })
}

pub fn marked(value: &str, marks: &[&str]) -> Value {
    let marks: Vec<Value> = marks.iter().map(|m| json!({ "type": m })).collect();
    json!({ "type": "text", "text": value, "marks": marks })
}

pub fn p(content: &[Value]) -> Value {
    if content.is_empty() {
        return json!({ "type": "paragraph" });
    }
    json!({ "type": "paragraph", "content": content })
}

pub fn heading(level: u8, value: &str) -> Value {
    json!({ "type": "heading", "attrs": { "level": level }, "content": [text(value)] })
}

pub fn list(kind: &str, items: &[Value]) -> Value {
    json!({ "type": kind, "content": items })
}

pub fn item(content: &[Value]) -> Value {
    json!({ "type": "listItem", "content": content })
}

pub fn doc_json(content: &[Value]) -> Value {
    json!({ "type": "doc", "content": content })
}

/// A document seeded from ProseMirror JSON, with a fixed client id.
pub fn doc(content: &[Value]) -> RichTextDoc {
    let mut doc = RichTextDoc::with_client_id(1);
    assert!(doc.load_prosemirror_json(&doc_json(content)));
    doc.take_local_updates();
    doc
}

/// Asserts the document equals the expected blocks (normalized).
#[track_caller]
pub fn assert_doc(doc: &RichTextDoc, content: &[Value]) {
    assert_eq!(
        normalize(&doc.to_prosemirror_json()),
        normalize(&doc_json(content)),
        "document differs"
    );
}

/// The text of every line, for compact assertions.
pub fn texts(doc: &RichTextDoc) -> Vec<String> {
    doc.lines().iter().map(|line| line.text()).collect()
}
