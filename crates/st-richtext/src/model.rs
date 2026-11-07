//! A read-only snapshot of the document tree and its ProseMirror JSON form.
//!
//! The snapshot keeps every node and attribute, known or not, so that the
//! JSON it produces can be compared with what y-prosemirror builds from the
//! same Yjs state, and written to the `materialized` mirror that the server
//! copies to D1.

use std::collections::BTreeMap;
use std::sync::Arc;

use serde_json::{Map, Value};
use yrs::types::text::YChange;
use yrs::{Any, Number, Out, ReadTxn, Text, Xml, XmlFragment, XmlOut, XmlTextRef};

use crate::schema::{mark_type, node};

/// The whole page body: the children of the `default` fragment.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Document {
    /// Top-level blocks.
    pub content: Vec<Node>,
}

/// A child of an element: either an element or a run of formatted text.
#[derive(Clone, Debug, PartialEq)]
pub enum Node {
    /// A ProseMirror node stored as a Yjs `XmlElement`.
    Element(Element),
    /// The text nodes stored in one Yjs `XmlText`.
    Text(Vec<TextRun>),
}

/// A ProseMirror node.
#[derive(Clone, Debug, PartialEq)]
pub struct Element {
    /// The node type, e.g. `paragraph`.
    pub name: String,
    /// The attributes, as stored (y-prosemirror drops null ones).
    pub attrs: BTreeMap<String, Any>,
    /// The children, in order.
    pub children: Vec<Node>,
}

/// Uniformly formatted text.
#[derive(Clone, Debug, PartialEq)]
pub struct TextRun {
    /// The text.
    pub text: String,
    /// Formatting attribute key → mark attributes (`{}` for plain marks).
    pub marks: BTreeMap<String, Any>,
}

impl Document {
    /// Reads every child of `fragment`.
    pub fn read<T: ReadTxn, F: XmlFragment>(txn: &T, fragment: &F) -> Self {
        Self {
            content: read_children(txn, fragment),
        }
    }

    /// The ProseMirror JSON of the document (`editor.getJSON()` minus the
    /// null attributes, which Yjs does not store).
    pub fn to_prosemirror_json(&self) -> Value {
        let mut doc = Map::new();
        doc.insert("type".into(), "doc".into());
        let content = children_json(&self.content);
        if !content.is_empty() {
            doc.insert("content".into(), Value::Array(content));
        }
        Value::Object(doc)
    }

    /// The text of the document, one line per text block.
    pub fn plain_text(&self) -> String {
        let mut out = String::new();
        for node in &self.content {
            push_plain_text(node, &mut out);
        }
        out.trim_end_matches('\n').to_owned()
    }
}

impl Element {
    /// An attribute as an integer, when it is a number.
    pub fn int_attr(&self, name: &str) -> Option<i64> {
        any_as_i64(self.attrs.get(name)?)
    }
}

fn push_plain_text(node: &Node, out: &mut String) {
    match node {
        Node::Text(runs) => runs.iter().for_each(|run| out.push_str(&run.text)),
        Node::Element(element) => {
            if element.name == node::HARD_BREAK {
                out.push('\n');
                return;
            }
            let inline = element.children.iter().any(|c| matches!(c, Node::Text(_)))
                || element.children.is_empty();
            for child in &element.children {
                push_plain_text(child, out);
            }
            if inline && !out.ends_with('\n') {
                out.push('\n');
            }
        }
    }
}

/// Reads the children of an element or fragment.
pub(crate) fn read_children<T: ReadTxn, F: XmlFragment>(txn: &T, parent: &F) -> Vec<Node> {
    parent
        .children(txn)
        .filter_map(|child| match child {
            XmlOut::Element(element) => Some(Node::Element(Element {
                name: element.tag().to_string(),
                attrs: element
                    .attributes(txn)
                    .filter_map(|(key, value)| match value {
                        Out::Any(any) => Some((key.to_owned(), any)),
                        // y-prosemirror only stores plain values as attributes.
                        _ => None,
                    })
                    .collect(),
                children: read_children(txn, &element),
            })),
            XmlOut::Text(text) => Some(Node::Text(read_runs(txn, &text))),
            XmlOut::Fragment(_) => None,
        })
        .collect()
}

/// Reads the formatted runs of an `XmlText`.
///
/// Embedded values (which y-prosemirror never writes) are skipped.
pub(crate) fn read_runs<T: ReadTxn>(txn: &T, text: &XmlTextRef) -> Vec<TextRun> {
    text.diff(txn, YChange::identity)
        .into_iter()
        .filter_map(|chunk| match chunk.insert {
            Out::Any(Any::String(s)) if !s.is_empty() => Some(TextRun {
                text: s.to_string(),
                marks: chunk
                    .attributes
                    .map(|attrs| {
                        attrs
                            .iter()
                            .map(|(k, v)| (k.to_string(), v.clone()))
                            .collect()
                    })
                    .unwrap_or_default(),
            }),
            _ => None,
        })
        .collect()
}

fn children_json(children: &[Node]) -> Vec<Value> {
    let mut out = Vec::new();
    for child in children {
        match child {
            Node::Element(element) => out.push(element_json(element)),
            Node::Text(runs) => out.extend(runs.iter().map(run_json)),
        }
    }
    out
}

fn element_json(element: &Element) -> Value {
    let mut json = Map::new();
    json.insert("type".into(), element.name.clone().into());
    if !element.attrs.is_empty() {
        let attrs = element
            .attrs
            .iter()
            .map(|(k, v)| (k.clone(), any_to_json(v)))
            .collect();
        json.insert("attrs".into(), Value::Object(attrs));
    }
    let content = children_json(&element.children);
    if !content.is_empty() {
        json.insert("content".into(), Value::Array(content));
    }
    Value::Object(json)
}

fn run_json(run: &TextRun) -> Value {
    let mut json = Map::new();
    json.insert("type".into(), "text".into());
    json.insert("text".into(), run.text.clone().into());
    if !run.marks.is_empty() {
        let marks = run
            .marks
            .iter()
            .map(|(key, value)| {
                let mut mark = Map::new();
                mark.insert("type".into(), mark_type(key).into());
                if let Any::Map(attrs) = value
                    && !attrs.is_empty()
                {
                    mark.insert("attrs".into(), any_to_json(value));
                }
                Value::Object(mark)
            })
            .collect();
        json.insert("marks".into(), Value::Array(marks));
    }
    Value::Object(json)
}

/// Converts a Yjs value to JSON. Integral numbers stay integers, as in
/// JavaScript, so `level: 1` does not become `1.0`.
pub fn any_to_json(any: &Any) -> Value {
    match any {
        Any::Null | Any::Undefined => Value::Null,
        Any::Bool(b) => Value::Bool(*b),
        Any::Number(Number::Int(i)) => Value::from(*i),
        Any::Number(Number::Float(f)) => {
            if f.fract() == 0.0 && f.abs() <= Number::F64_MAX_SAFE_INTEGER {
                Value::from(*f as i64)
            } else {
                serde_json::Number::from_f64(*f).map_or(Value::Null, Value::Number)
            }
        }
        Any::String(s) => Value::String(s.to_string()),
        Any::Buffer(bytes) => Value::Array(bytes.iter().map(|b| Value::from(*b)).collect()),
        Any::Array(items) => Value::Array(items.iter().map(any_to_json).collect()),
        Any::Map(map) => Value::Object(
            map.iter()
                .map(|(k, v)| (k.clone(), any_to_json(v)))
                .collect(),
        ),
    }
}

/// Converts JSON to a Yjs value.
pub fn json_to_any(value: &Value) -> Any {
    match value {
        Value::Null => Any::Null,
        Value::Bool(b) => Any::Bool(*b),
        Value::Number(n) => match n.as_i64() {
            Some(i) => Any::Number(Number::Int(i)),
            None => Any::Number(Number::Float(n.as_f64().unwrap_or_default())),
        },
        Value::String(s) => Any::String(Arc::from(s.as_str())),
        Value::Array(items) => Any::Array(items.iter().map(json_to_any).collect()),
        Value::Object(map) => Any::Map(Arc::new(
            map.iter()
                .map(|(k, v)| (k.clone(), json_to_any(v)))
                .collect(),
        )),
    }
}

/// A Yjs value as an integer, when it is an integral number.
pub(crate) fn any_as_i64(any: &Any) -> Option<i64> {
    match any {
        Any::Number(Number::Int(i)) => Some(*i),
        Any::Number(Number::Float(f)) if f.fract() == 0.0 => Some(*f as i64),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn json_round_trip_keeps_integers() {
        let value = json!({ "level": 2, "ratio": 0.5, "src": "a.png", "list": [true, null] });
        assert_eq!(any_to_json(&json_to_any(&value)), value);
        assert_eq!(any_to_json(&Any::Number(Number::Float(3.0))), json!(3));
    }
}
