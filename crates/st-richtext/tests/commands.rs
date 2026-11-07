//! Editing commands of `RichTextDoc`, checked on the ProseMirror JSON.

mod common;

use common::{assert_doc, doc, fixture, heading, item, list, marked, normalize, p, text, texts};
use serde_json::json;
use st_richtext::{LineKind, Mark, Pos, RichTextDoc};

#[test]
fn typing_inherits_marks_but_does_not_extend_links() {
    let link = json!({ "type": "text", "text": "lien", "marks": [{ "type": "link", "attrs": { "href": "https://a.b" } }] });
    let mut doc = doc(&[p(&[text("a"), marked("gras", &["bold"]), link])]);
    doc.insert_text(Pos::new(0, 5), "X");
    doc.insert_text(Pos::new(0, 10), "Y");
    doc.insert_text(Pos::new(0, 0), "<");
    let link = json!({ "type": "text", "text": "lien", "marks": [{ "type": "link", "attrs": { "href": "https://a.b" } }] });
    assert_doc(
        &doc,
        &[p(&[
            text("<a"),
            marked("grasX", &["bold"]),
            link,
            text("Y"),
        ])],
    );
}

#[test]
fn enter_splits_blocks_and_ends_headings_with_a_paragraph() {
    let mut doc = doc(&[
        heading(2, "Titre"),
        p(&[text("avant"), marked("après", &["bold"])]),
    ]);
    let pos = doc.split_block(Pos::new(1, 5));
    assert_eq!(pos, Pos::new(2, 0));
    let pos = doc.split_block(Pos::new(0, 5));
    assert_eq!(pos, Pos::new(1, 0));
    doc.insert_text(pos, "texte");
    doc.split_block(Pos::new(0, 2));
    assert_doc(
        &doc,
        &[
            heading(2, "Ti"),
            heading(2, "tre"),
            p(&[text("texte")]),
            p(&[text("avant")]),
            p(&[marked("après", &["bold"])]),
        ],
    );
}

#[test]
fn enter_in_a_list_item_adds_an_item_and_an_empty_item_leaves_the_list() {
    let mut doc = doc(&[list(
        "bulletList",
        &[item(&[p(&[text("un")])]), item(&[p(&[text("deux")])])],
    )]);
    let pos = doc.split_block(Pos::new(0, 2));
    doc.insert_text(pos, "un bis");
    assert_eq!(texts(&doc), ["un", "un bis", "deux"]);
    // Enter twice at the end of the last item: a new item, then out of the list.
    let pos = doc.split_block(Pos::new(2, 4));
    assert_eq!(pos, Pos::new(3, 0));
    let pos = doc.split_block(pos);
    doc.insert_text(pos, "après");
    assert_doc(
        &doc,
        &[
            list(
                "bulletList",
                &[
                    item(&[p(&[text("un")])]),
                    item(&[p(&[text("un bis")])]),
                    item(&[p(&[text("deux")])]),
                ],
            ),
            p(&[text("après")]),
        ],
    );
}

#[test]
fn enter_in_an_empty_middle_item_splits_the_list() {
    let mut doc = doc(&[list(
        "orderedList",
        &[
            item(&[p(&[text("a")])]),
            item(&[p(&[])]),
            item(&[p(&[text("c")])]),
        ],
    )]);
    doc.split_block(Pos::new(1, 0));
    assert_doc(
        &doc,
        &[
            list("orderedList", &[item(&[p(&[text("a")])])]),
            p(&[]),
            list("orderedList", &[item(&[p(&[text("c")])])]),
        ],
    );
}

#[test]
fn enter_in_an_empty_nested_item_outdents_it() {
    let nested = list("bulletList", &[item(&[p(&[text("b")])]), item(&[p(&[])])]);
    let mut doc = doc(&[list("bulletList", &[item(&[p(&[text("a")]), nested])])]);
    let pos = doc.split_block(Pos::new(2, 0));
    doc.insert_text(pos, "c");
    assert_doc(
        &doc,
        &[list(
            "bulletList",
            &[
                item(&[
                    p(&[text("a")]),
                    list("bulletList", &[item(&[p(&[text("b")])])]),
                ]),
                item(&[p(&[text("c")])]),
            ],
        )],
    );
}

#[test]
fn backspace_joins_paragraphs_and_list_items() {
    let mut doc = doc(&[
        p(&[text("un")]),
        p(&[marked("deux", &["italic"])]),
        list(
            "bulletList",
            &[item(&[p(&[text("a")])]), item(&[p(&[text("b")])])],
        ),
    ]);
    let pos = doc.backspace(Pos::new(1, 0));
    assert_eq!(pos, Pos::new(0, 2));
    // Start of the second item: it joins the first item…
    let pos = doc.backspace(Pos::new(2, 0));
    assert_eq!(texts(&doc), ["undeux", "a", "b"]);
    // …then its paragraph merges into the previous one.
    let pos = doc.backspace(pos);
    assert_eq!(pos, Pos::new(1, 1));
    assert_doc(
        &doc,
        &[
            p(&[text("un"), marked("deux", &["italic"])]),
            list("bulletList", &[item(&[p(&[text("ab")])])]),
        ],
    );
}

#[test]
fn backspace_at_the_start_of_a_first_item_lifts_it_out() {
    let mut doc = doc(&[
        p(&[text("avant")]),
        list(
            "bulletList",
            &[item(&[p(&[text("a")])]), item(&[p(&[text("b")])])],
        ),
    ]);
    doc.backspace(Pos::new(1, 0));
    assert_doc(
        &doc,
        &[
            p(&[text("avant")]),
            p(&[text("a")]),
            list("bulletList", &[item(&[p(&[text("b")])])]),
        ],
    );
}

#[test]
fn backspace_after_a_list_moves_the_paragraph_into_it() {
    let mut doc = doc(&[
        list("bulletList", &[item(&[p(&[text("a")])])]),
        p(&[text("b")]),
    ]);
    doc.backspace(Pos::new(1, 0));
    assert_doc(
        &doc,
        &[list(
            "bulletList",
            &[item(&[p(&[text("a")])]), item(&[p(&[text("b")])])],
        )],
    );
}

#[test]
fn backspace_at_the_start_of_the_document_clears_a_heading() {
    let mut doc = doc(&[heading(1, "Titre")]);
    doc.backspace(Pos::new(0, 0));
    assert_doc(&doc, &[p(&[text("Titre")])]);
}

#[test]
fn deleting_across_blocks_merges_the_ends() {
    let mut doc = doc(&[
        p(&[text("début")]),
        list("bulletList", &[item(&[p(&[text("milieu")])])]),
        p(&[text("fin")]),
    ]);
    let pos = doc.delete(Pos::new(0, 3), Pos::new(2, 1));
    assert_eq!(pos, Pos::new(0, 3));
    assert_doc(&doc, &[p(&[text("débin")])]);
}

#[test]
fn deleting_everything_leaves_an_empty_paragraph() {
    let mut doc = doc(&[heading(1, "Titre"), p(&[text("texte")])]);
    let (from, to) = (doc.first_text_pos(), doc.last_text_pos());
    doc.delete(from, to);
    assert_doc(
        &doc,
        &[json!({ "type": "heading", "attrs": { "level": 1 } })],
    );
    assert!(doc.lines()[0].is_empty());
}

#[test]
fn toggle_mark_adds_then_removes() {
    let mut doc = doc(&[p(&[text("un deux")]), p(&[marked("trois", &["bold"])])]);
    doc.toggle_mark(Pos::new(0, 3), Pos::new(1, 2), Mark::Bold);
    assert!(doc.has_mark(Pos::new(0, 3), Pos::new(1, 5), Mark::Bold));
    assert_doc(
        &doc,
        &[
            p(&[text("un "), marked("deux", &["bold"])]),
            p(&[marked("trois", &["bold"])]),
        ],
    );
    // Partly bold: toggling bolds everything, toggling again unbolds it all.
    doc.toggle_mark(Pos::new(0, 0), Pos::new(1, 5), Mark::Bold);
    assert!(doc.has_mark(Pos::new(0, 0), Pos::new(1, 5), Mark::Bold));
    doc.toggle_mark(Pos::new(0, 0), Pos::new(1, 5), Mark::Bold);
    assert!(!doc.has_mark(Pos::new(0, 0), Pos::new(0, 1), Mark::Bold));
    doc.toggle_mark(Pos::new(0, 0), Pos::new(0, 2), Mark::Italic);
    assert_doc(
        &doc,
        &[
            p(&[marked("un", &["italic"]), text(" deux")]),
            p(&[text("trois")]),
        ],
    );
}

#[test]
fn hard_breaks_are_inserted_and_removed() {
    let mut doc = doc(&[p(&[marked("ab", &["bold"])])]);
    let pos = doc.insert_hard_break(Pos::new(0, 1));
    assert_eq!(texts(&doc), ["a\nb"]);
    assert_doc(
        &doc,
        &[p(&[
            marked("a", &["bold"]),
            json!({ "type": "hardBreak" }),
            marked("b", &["bold"]),
        ])],
    );
    doc.backspace(pos);
    assert_doc(&doc, &[p(&[marked("ab", &["bold"])])]);
}

#[test]
fn enter_in_a_code_block_inserts_a_newline() {
    let code = json!({ "type": "codeBlock", "attrs": { "language": "rust" }, "content": [text("fn main() {}")] });
    let mut doc = doc(&[code]);
    assert_eq!(
        doc.lines()[0].kind(),
        &LineKind::Text(st_richtext::TextBlock::CodeBlock)
    );
    doc.split_block(Pos::new(0, 11));
    let code = json!({ "type": "codeBlock", "attrs": { "language": "rust" }, "content": [text("fn main() {\n}")] });
    assert_doc(&doc, &[code]);
}

#[test]
fn unknown_nodes_survive_edits_around_them() {
    let original = RichTextDoc::from_update(&fixture())
        .unwrap()
        .to_prosemirror_json();
    let mut doc = RichTextDoc::from_update_with_client_id(&fixture(), 7).unwrap();
    let table = doc
        .lines()
        .iter()
        .position(|l| matches!(l.kind(), LineKind::Placeholder { name, .. } if name == "table"))
        .unwrap();
    // Type in the line before the table and in the last paragraph after it.
    let before = doc.prev_text_line(table).unwrap();
    let end = doc.lines()[before].len();
    doc.insert_text(Pos::new(before, end), " !");
    doc.insert_text(doc.last_text_pos(), "fin");
    // Backspace at the start of the line after the placeholders does nothing.
    doc.backspace(doc.last_text_pos().with_offset(0));
    let after = doc.to_prosemirror_json();
    for name in ["table", "callout", "image"] {
        let find = |json: &serde_json::Value| {
            json["content"]
                .as_array()
                .unwrap()
                .iter()
                .find(|n| n["type"] == name)
                .cloned()
        };
        assert_eq!(find(&after), find(&original), "{name} unchanged");
    }
}

#[test]
fn task_items_toggle() {
    let task = json!({ "type": "taskList", "content": [{ "type": "taskItem", "attrs": { "checked": false }, "content": [p(&[text("faire")])] }] });
    let mut doc = doc(&[task]);
    doc.toggle_task(0);
    let task = json!({ "type": "taskList", "content": [{ "type": "taskItem", "attrs": { "checked": true }, "content": [p(&[text("faire")])] }] });
    assert_doc(&doc, &[task]);
}

#[test]
fn undo_and_redo_restore_the_document() {
    let mut doc = doc(&[p(&[text("a")])]);
    doc.set_time(1.0);
    doc.insert_text(Pos::new(0, 1), "b");
    doc.set_time(2.0);
    doc.split_block(Pos::new(0, 2));
    assert_eq!(texts(&doc), ["ab", ""]);
    assert!(doc.undo());
    assert_eq!(texts(&doc), ["ab"]);
    assert!(doc.undo());
    assert_eq!(texts(&doc), ["a"]);
    assert!(doc.redo());
    assert_eq!(texts(&doc), ["ab"]);
    // The mirror follows undo too.
    assert_eq!(
        normalize(&doc.materialized().unwrap()["content"]),
        normalize(&doc.to_prosemirror_json())
    );
}

#[test]
fn every_edit_is_a_replayable_update() {
    let mut doc = RichTextDoc::from_update_with_client_id(&fixture(), 9).unwrap();
    doc.insert_text(Pos::new(1, 0), "Avant : ");
    doc.split_block(Pos::new(4, 3));
    doc.toggle_mark(Pos::new(0, 0), Pos::new(0, 4), Mark::Italic);
    let updates = doc.take_local_updates();
    assert!(updates.len() >= 3);
    let mut replica = RichTextDoc::from_update(&fixture()).unwrap();
    for update in &updates {
        replica.apply_update(update).unwrap();
    }
    assert_eq!(replica.to_prosemirror_json(), doc.to_prosemirror_json());
    assert_eq!(replica.materialized(), doc.materialized());
}

#[test]
fn concurrent_edits_converge() {
    let mut alice = RichTextDoc::from_update_with_client_id(&fixture(), 11).unwrap();
    let mut bruno = RichTextDoc::from_update_with_client_id(&fixture(), 12).unwrap();
    alice.insert_text(Pos::new(0, 0), "[A] ");
    alice.split_block(Pos::new(1, 12));
    bruno.insert_text(Pos::new(0, 4), " (B)");
    bruno.toggle_mark(Pos::new(1, 0), Pos::new(1, 12), Mark::Bold);
    let from_alice = alice.take_local_updates();
    let from_bruno = bruno.take_local_updates();
    for update in &from_bruno {
        alice.apply_update(update).unwrap();
    }
    for update in &from_alice {
        bruno.apply_update(update).unwrap();
    }
    assert_eq!(alice.to_prosemirror_json(), bruno.to_prosemirror_json());
    assert_eq!(alice.lines()[0].text(), "[A] Spéc (B) : export PDF");
    assert_eq!(alice.lines()[1].text(), "Comportement");
    assert_eq!(alice.lines()[1].marked_text("bold"), ["Comportement"]);
}

#[test]
fn loading_json_twice_does_not_duplicate() {
    let mut doc = doc(&[p(&[text("a")])]);
    assert!(!doc.load_prosemirror_json(&common::doc_json(&[p(&[text("b")])])));
    assert_eq!(texts(&doc), ["a"]);
}

trait WithOffset {
    fn with_offset(self, offset: usize) -> Self;
}

impl WithOffset for Pos {
    fn with_offset(self, offset: usize) -> Self {
        Pos::new(self.line, offset)
    }
}
