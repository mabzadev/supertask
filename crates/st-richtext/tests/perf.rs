//! Rough timings on a large page, to size the remaining work. Run with
//! `cargo test --release -p st-richtext --test perf -- --ignored --nocapture`.

mod common;

use std::time::Instant;

use common::{marked, p, text};
use st_richtext::headless::Harness;
use st_richtext::{Pos, RichTextDoc};

#[test]
#[ignore = "timing report, not a check"]
fn large_page_timings() {
    for blocks in [200, 2000] {
        let content: Vec<_> = (0..blocks)
            .map(|i| {
                p(&[
                    text(&format!("Paragraphe {i} avec un peu de texte, ")),
                    marked("du gras", &["bold"]),
                    text(" et de l'italique pour faire bonne mesure."),
                ])
            })
            .collect();
        let mut doc = common::doc(&content);
        let update = doc.encode_state_as_update();

        let start = Instant::now();
        let mut loaded = RichTextDoc::from_update(&update).unwrap();
        let load = start.elapsed();

        let start = Instant::now();
        let middle = Pos::new(blocks / 2, 3);
        for _ in 0..20 {
            loaded.insert_text(middle, "x");
        }
        let keystroke = start.elapsed() / 20;

        loaded.set_mirror_materialized(false);
        let start = Instant::now();
        for _ in 0..20 {
            loaded.insert_text(middle, "x");
        }
        let keystroke_no_mirror = start.elapsed() / 20;

        let mut ui = Harness::new();
        let start = Instant::now();
        ui.run(&mut doc);
        let first_frame = start.elapsed();
        let start = Instant::now();
        for _ in 0..10 {
            ui.run(&mut doc);
        }
        let frame = start.elapsed() / 10;

        println!(
            "{blocks} blocks, {} KiB: load {load:?}, keystroke {keystroke:?} \
             ({keystroke_no_mirror:?} without the JSON mirror), first frame {first_frame:?}, \
             next frames {frame:?}",
            update.len() / 1024
        );
    }
}
