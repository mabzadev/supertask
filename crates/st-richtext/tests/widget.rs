//! The egui widget driven by raw input events, without a window.

mod common;

use common::{assert_doc, doc, fixture, heading, item, list, marked, p, text, texts};
use egui::{Event, Key, Modifiers, vec2};
use st_richtext::headless::Harness;
use st_richtext::{Pos, RichTextDoc};

fn focused(doc: &mut RichTextDoc) -> Harness {
    let mut ui = Harness::new();
    ui.focus(doc);
    ui
}

#[test]
fn typing_enter_and_bold_through_input_events() {
    let mut doc = doc(&[p(&[text("Bonjour")])]);
    let mut ui = focused(&mut doc);
    ui.set_cursor(&doc, Pos::new(0, 7));
    assert!(ui.type_text(&mut doc, " le monde"));
    ui.press(&mut doc, Key::Enter, Modifiers::NONE);
    ui.type_text(&mut doc, "Deuxième ligne");
    // Select "ligne" with Shift+Left and bold it with Ctrl+B.
    for _ in 0.."ligne".len() {
        ui.press(&mut doc, Key::ArrowLeft, Modifiers::SHIFT);
    }
    ui.press(&mut doc, Key::B, Modifiers::COMMAND);
    assert_doc(
        &doc,
        &[
            p(&[text("Bonjour le monde")]),
            p(&[text("Deuxième "), marked("ligne", &["bold"])]),
        ],
    );
    assert_eq!(
        ui.state().selection(&doc),
        Some((Pos::new(1, 14), Pos::new(1, 9)))
    );
}

#[test]
fn ctrl_b_without_selection_applies_to_the_next_text() {
    let mut doc = doc(&[p(&[text("a")])]);
    let mut ui = focused(&mut doc);
    ui.set_cursor(&doc, Pos::new(0, 1));
    ui.press(&mut doc, Key::B, Modifiers::COMMAND);
    ui.type_text(&mut doc, "gras");
    ui.press(&mut doc, Key::B, Modifiers::COMMAND);
    ui.type_text(&mut doc, "normal");
    assert_doc(
        &doc,
        &[p(&[text("a"), marked("gras", &["bold"]), text("normal")])],
    );
}

#[test]
fn backspace_and_delete_keys() {
    let mut doc = doc(&[p(&[text("un")]), p(&[text("deux")])]);
    let mut ui = focused(&mut doc);
    ui.set_cursor(&doc, Pos::new(1, 0));
    ui.press(&mut doc, Key::Backspace, Modifiers::NONE);
    assert_eq!(texts(&doc), ["undeux"]);
    assert_eq!(ui.state().cursor(&doc), Some(Pos::new(0, 2)));
    ui.press(&mut doc, Key::Delete, Modifiers::NONE);
    ui.press(&mut doc, Key::Backspace, Modifiers::NONE);
    assert_eq!(texts(&doc), ["ueux"]);
}

#[test]
fn enter_in_lists_through_the_widget() {
    let mut doc = doc(&[list("bulletList", &[item(&[p(&[text("un")])])])]);
    let mut ui = focused(&mut doc);
    ui.set_cursor(&doc, Pos::new(0, 2));
    ui.press(&mut doc, Key::Enter, Modifiers::NONE);
    ui.type_text(&mut doc, "deux");
    ui.press(&mut doc, Key::Enter, Modifiers::NONE);
    ui.press(&mut doc, Key::Enter, Modifiers::NONE);
    ui.type_text(&mut doc, "fin");
    assert_doc(
        &doc,
        &[
            list(
                "bulletList",
                &[item(&[p(&[text("un")])]), item(&[p(&[text("deux")])])],
            ),
            p(&[text("fin")]),
        ],
    );
}

#[test]
fn arrows_cross_lines_and_keep_the_column() {
    let mut doc = doc(&[p(&[text("abcdef")]), p(&[text("ghijkl")])]);
    let mut ui = focused(&mut doc);
    ui.set_cursor(&doc, Pos::new(0, 6));
    ui.press(&mut doc, Key::ArrowRight, Modifiers::NONE);
    assert_eq!(ui.state().cursor(&doc), Some(Pos::new(1, 0)));
    ui.press(&mut doc, Key::ArrowLeft, Modifiers::NONE);
    ui.press(&mut doc, Key::ArrowLeft, Modifiers::NONE);
    ui.press(&mut doc, Key::ArrowLeft, Modifiers::NONE);
    assert_eq!(ui.state().cursor(&doc), Some(Pos::new(0, 4)));
    ui.press(&mut doc, Key::ArrowDown, Modifiers::NONE);
    let down = ui.state().cursor(&doc).unwrap();
    assert_eq!(down.line, 1);
    assert!((3..=5).contains(&down.offset), "column kept, got {down:?}");
    ui.press(&mut doc, Key::ArrowUp, Modifiers::NONE);
    assert_eq!(ui.state().cursor(&doc), Some(Pos::new(0, 4)));
    ui.press(&mut doc, Key::End, Modifiers::NONE);
    assert_eq!(ui.state().cursor(&doc), Some(Pos::new(0, 6)));
    ui.press(&mut doc, Key::Home, Modifiers::NONE);
    assert_eq!(ui.state().cursor(&doc), Some(Pos::new(0, 0)));
}

#[test]
fn select_all_then_type_replaces_everything() {
    let mut doc = doc(&[heading(1, "Titre"), p(&[text("corps")])]);
    let mut ui = focused(&mut doc);
    ui.press(&mut doc, Key::A, Modifiers::COMMAND);
    ui.type_text(&mut doc, "Neuf");
    assert_doc(&doc, &[heading(1, "Neuf")]);
}

#[test]
fn paste_with_newlines_makes_paragraphs() {
    let mut doc = doc(&[p(&[text("[]")])]);
    let mut ui = focused(&mut doc);
    ui.set_cursor(&doc, Pos::new(0, 1));
    ui.push_event(Event::Paste("un\ndeux\ntrois".into()));
    ui.run(&mut doc);
    assert_eq!(texts(&doc), ["[un", "deux", "trois]"]);
    assert_eq!(ui.state().cursor(&doc), Some(Pos::new(2, 5)));
}

#[test]
fn ctrl_z_undoes_and_ctrl_shift_z_redoes() {
    let mut doc = doc(&[p(&[text("a")])]);
    let mut ui = focused(&mut doc);
    ui.set_cursor(&doc, Pos::new(0, 1));
    ui.type_text(&mut doc, "b");
    ui.wait(1.0);
    ui.press(&mut doc, Key::Enter, Modifiers::NONE);
    ui.wait(1.0);
    ui.type_text(&mut doc, "c");
    ui.wait(1.0);
    ui.press(&mut doc, Key::Z, Modifiers::COMMAND);
    assert_eq!(texts(&doc), ["ab", ""]);
    ui.press(&mut doc, Key::Z, Modifiers::COMMAND);
    ui.press(&mut doc, Key::Z, Modifiers::COMMAND);
    assert_eq!(texts(&doc), ["a"]);
    ui.press(&mut doc, Key::Z, Modifiers::COMMAND | Modifiers::SHIFT);
    assert_eq!(texts(&doc), ["ab"]);
}

#[test]
fn clicking_places_the_cursor_and_ticks_checkboxes() {
    let task = serde_json::json!({
        "type": "taskList",
        "content": [{ "type": "taskItem", "attrs": { "checked": false }, "content": [p(&[text("tâche")])] }]
    });
    let mut doc = doc(&[task, p(&[text("dernier paragraphe")])]);
    let mut ui = focused(&mut doc);
    let height = ui.rect().height();
    // Far right of the last line: the cursor goes to its end.
    ui.click(&mut doc, vec2(ui.rect().width() - 2.0, height - 2.0));
    assert_eq!(ui.state().cursor(&doc), Some(Pos::new(1, 18)));
    ui.type_text(&mut doc, ".");
    assert_eq!(texts(&doc)[1], "dernier paragraphe.");
    // The checkbox sits in the list indent of the first line.
    assert!(ui.click(&mut doc, vec2(10.0, 10.0)));
    let checked = doc.to_prosemirror_json()["content"][0]["content"][0]["attrs"]["checked"].clone();
    assert_eq!(checked, serde_json::json!(true));
}

#[test]
fn the_cursor_survives_a_remote_block_inserted_above() {
    let mut doc = RichTextDoc::from_update_with_client_id(&fixture(), 21).unwrap();
    let mut other = RichTextDoc::from_update_with_client_id(&fixture(), 22).unwrap();
    let mut ui = focused(&mut doc);
    ui.set_cursor(&doc, Pos::new(1, 12));
    other.split_block(Pos::new(0, 4));
    for update in other.take_local_updates() {
        doc.apply_update(&update).unwrap();
    }
    ui.run(&mut doc);
    // The intro paragraph moved from line 1 to line 2; the cursor followed.
    assert_eq!(ui.state().cursor(&doc), Some(Pos::new(2, 12)));
    ui.type_text(&mut doc, "!");
    assert!(doc.lines()[2].text().starts_with("Comportement!"));
}

#[test]
fn the_real_page_renders_and_edits_around_placeholders() {
    let mut doc = RichTextDoc::from_update_with_client_id(&fixture(), 31).unwrap();
    let mut ui = focused(&mut doc);
    assert!(ui.rect().height() > 400.0, "the whole page is laid out");
    let last = doc.last_text_pos();
    ui.set_cursor(&doc, last);
    ui.type_text(&mut doc, "Écrit sous le tableau");
    ui.press(&mut doc, Key::ArrowUp, Modifiers::NONE);
    // Up skips the image, callout and table placeholders to the hard break line.
    let cursor = ui.state().cursor(&doc).unwrap();
    assert_eq!(doc.lines()[cursor.line].text(), "Ligne un\nligne deux");
    assert_eq!(doc.lines()[last.line].text(), "Écrit sous le tableau");
}

#[test]
fn enter_at_the_end_of_bold_text_keeps_typing_bold() {
    let mut doc = doc(&[p(&[marked("gras", &["bold"])])]);
    let mut ui = focused(&mut doc);
    ui.set_cursor(&doc, Pos::new(0, 4));
    ui.press(&mut doc, Key::Enter, Modifiers::NONE);
    ui.type_text(&mut doc, "encore");
    assert_doc(
        &doc,
        &[
            p(&[marked("gras", &["bold"])]),
            p(&[marked("encore", &["bold"])]),
        ],
    );
}

#[test]
fn ime_commits_are_typed() {
    let mut doc = doc(&[p(&[text("caf")])]);
    let mut ui = focused(&mut doc);
    ui.set_cursor(&doc, Pos::new(0, 3));
    ui.push_event(Event::Ime(egui::ImeEvent::Preedit {
        text: "e".into(),
        active_range_chars: None,
    }));
    ui.run(&mut doc);
    ui.push_event(Event::Ime(egui::ImeEvent::Commit("é".into())));
    ui.run(&mut doc);
    assert_eq!(texts(&doc), ["café"]);
    // Mobile keyboards delete around the caret.
    ui.push_event(Event::Ime(egui::ImeEvent::DeleteSurrounding {
        before_chars: 2,
        after_chars: 0,
    }));
    ui.run(&mut doc);
    assert_eq!(texts(&doc), ["ca"]);
}
