//! Reading a real Supertask document written by TipTap through y-prosemirror.

mod common;

use common::{fixture, fixture_prosemirror, normalize};
use st_richtext::{LineKind, ListKind, RichTextDoc, TextBlock, Wrapper};

#[test]
fn reads_the_fixture_like_y_prosemirror() {
    let doc = RichTextDoc::from_update(&fixture()).expect("valid update");
    assert_eq!(normalize(&doc.to_prosemirror_json()), fixture_prosemirror());
}

#[test]
fn flattens_the_fixture_into_lines() {
    let doc = RichTextDoc::from_update(&fixture()).expect("valid update");
    let lines = doc.lines();
    assert_eq!(lines.len(), 22);
    assert_eq!(lines[0].kind(), &LineKind::Text(TextBlock::Heading(1)));
    assert_eq!(lines[0].text(), "Spéc : export PDF");
    assert_eq!(lines[1].marked_text("bold"), ["attendu"]);
    assert_eq!(lines[1].marked_text("italic"), ["et cas limites"]);

    let bullet = |number| Wrapper::Item {
        list: ListKind::Bullet,
        number,
        marker: true,
        checked: None,
    };
    assert_eq!(lines[4].wrappers(), [bullet(2)]);
    assert_eq!(
        lines[6].wrappers(),
        [Wrapper::Item {
            list: ListKind::Task,
            number: 1,
            marker: true,
            checked: Some(true),
        }]
    );
    // A nested list: the outer item's marker is only on its first line.
    assert_eq!(lines[12].text(), "au client");
    assert!(matches!(
        lines[12].wrappers(),
        [
            Wrapper::Item {
                list: ListKind::Ordered,
                marker: false,
                ..
            },
            Wrapper::Item {
                list: ListKind::Bullet,
                marker: true,
                ..
            }
        ]
    ));
    assert_eq!(lines[9].marked_text("link"), ["documentation"]);
    assert_eq!(lines[9].marked_text("strike"), ["barrées"]);
    assert_eq!(lines[14].wrappers(), [Wrapper::Quote]);
    assert_eq!(lines[15].kind(), &LineKind::Text(TextBlock::CodeBlock));
    assert_eq!(lines[16].kind(), &LineKind::Rule);
    assert_eq!(lines[17].text(), "Ligne un\nligne deux");
    let placeholders: Vec<&str> = lines
        .iter()
        .filter_map(|line| match line.kind() {
            LineKind::Placeholder { name, .. } => Some(name.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(placeholders, ["table", "callout", "image"]);
}

#[test]
fn keeps_the_materialized_mirror_of_the_page() {
    let doc = RichTextDoc::from_update(&fixture()).expect("valid update");
    let materialized = doc.materialized().expect("mirror present");
    assert_eq!(materialized["title"], "Spéc : export PDF");
    assert_eq!(normalize(&materialized["content"]), fixture_prosemirror());
}
