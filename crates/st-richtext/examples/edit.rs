//! Edits a Yjs document through the egui widget, without a window, and
//! prints the Yjs updates it produced. Used by `tools/verify.cjs` to check in
//! Node, with the real yjs and y-prosemirror, that the edits are read back
//! exactly.
//!
//! Usage: `cargo run -p st-richtext --example edit -- <fixture.yjs>`
//!
//! The scenario expects the `spec-export-pdf` fixture; it prints a JSON
//! object with the diff against the fixture and every incremental update,
//! hex-encoded.

use std::fmt::Write as _;
use std::process::ExitCode;

use egui::{Key, Modifiers};
use st_richtext::headless::Harness;
use st_richtext::{Pos, RichTextDoc};

fn hex(bytes: &[u8]) -> String {
    bytes
        .iter()
        .fold(String::with_capacity(bytes.len() * 2), |mut out, b| {
            let _ = write!(out, "{b:02x}");
            out
        })
}

fn line_index(doc: &RichTextDoc, text: &str) -> usize {
    doc.lines()
        .iter()
        .position(|line| line.text() == text)
        .unwrap_or_else(|| panic!("no line {text:?}"))
}

fn main() -> ExitCode {
    let Some(path) = std::env::args().nth(1) else {
        eprintln!("usage: edit <fixture.yjs>");
        return ExitCode::FAILURE;
    };
    let fixture = std::fs::read(&path).expect("readable fixture");
    let mut doc = RichTextDoc::from_update_with_client_id(&fixture, 4242).expect("valid fixture");
    let base = doc.state_vector();
    let mut ui = Harness::new();
    ui.focus(&mut doc);

    // 1. Append to the intro paragraph, then bold the last word with
    //    Shift+Left ×3 and Ctrl+B.
    let intro = line_index(&doc, "Comportement attendu et cas limites.");
    ui.set_cursor(&doc, Pos::new(intro, doc.lines()[intro].len()));
    ui.type_text(&mut doc, " Voir aussi la FAQ");
    for _ in 0..3 {
        ui.press(&mut doc, Key::ArrowLeft, Modifiers::SHIFT);
    }
    ui.press(&mut doc, Key::B, Modifiers::COMMAND);

    // 2. Enter at the end: a new paragraph, which would go on in bold like in
    //    ProseMirror, so Ctrl+B first; then italicize its last word.
    ui.press(&mut doc, Key::End, Modifiers::NONE);
    ui.press(&mut doc, Key::Enter, Modifiers::NONE);
    ui.press(&mut doc, Key::B, Modifiers::COMMAND);
    ui.type_text(&mut doc, "Nouveau paragraphe écrit depuis Rust.");
    ui.press(&mut doc, Key::ArrowLeft, Modifiers::NONE);
    for _ in 0..4 {
        ui.press(&mut doc, Key::ArrowLeft, Modifiers::SHIFT);
    }
    ui.press(&mut doc, Key::I, Modifiers::COMMAND);

    // 3. Enter at the end of a list item: a new item.
    let item = line_index(&doc, "Valider");
    ui.set_cursor(&doc, Pos::new(item, doc.lines()[item].len()));
    ui.press(&mut doc, Key::Enter, Modifiers::NONE);
    ui.type_text(&mut doc, "Tester");

    // 4. Backspace right after a hard break removes it.
    let broken = line_index(&doc, "Ligne un\nligne deux");
    ui.set_cursor(&doc, Pos::new(broken, "Ligne un\n".chars().count()));
    ui.press(&mut doc, Key::Backspace, Modifiers::NONE);

    let diff = doc.encode_diff(&base).expect("own state vector");
    let updates: Vec<String> = doc.take_local_updates().iter().map(|u| hex(u)).collect();
    println!(
        "{}",
        serde_json::json!({ "diff": hex(&diff), "updates": updates, "client_id": 4242 })
    );
    ExitCode::SUCCESS
}
