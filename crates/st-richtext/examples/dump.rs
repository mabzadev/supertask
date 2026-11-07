//! Prints the ProseMirror JSON of a Yjs update file, as the Rust model reads
//! it. Used by `tools/verify.cjs` to compare with y-prosemirror.
//!
//! Usage: `cargo run -p st-richtext --example dump -- <update.yjs>`

use std::process::ExitCode;

use st_richtext::RichTextDoc;

fn main() -> ExitCode {
    let Some(path) = std::env::args().nth(1) else {
        eprintln!("usage: dump <update.yjs>");
        return ExitCode::FAILURE;
    };
    let bytes = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) => {
            eprintln!("{path}: {error}");
            return ExitCode::FAILURE;
        }
    };
    match RichTextDoc::from_update(&bytes) {
        Ok(doc) => {
            println!("{}", doc.to_prosemirror_json());
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("{path}: {error}");
            ExitCode::FAILURE
        }
    }
}
