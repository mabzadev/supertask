//! Draws a [`CellDisplay`] inside a grid cell.
//!
//! Chips, stars and checkboxes are painted directly rather than built from
//! nested widgets: a cell is redrawn every frame for every visible row, and
//! painting keeps that to a few shapes per cell with no layout bookkeeping.

use egui::{
    Align, Align2, Color32, CornerRadius, CursorIcon, FontId, Label, Layout, OpenUrl, Pos2, Rect,
    RichText, Sense, Shape, Stroke, Ui, Vec2, epaint::Mesh, pos2, vec2,
};
use st_core::CellDisplay;
use st_core::color::Rgb;

const CHIP_HEIGHT: f32 = 20.0;
const CHIP_PADDING: f32 = 8.0;
const CHIP_GAP: f32 = 4.0;
const STAR_SIZE: f32 = 15.0;

pub fn color(rgb: Rgb) -> Color32 {
    Color32::from_rgb(rgb.r, rgb.g, rgb.b)
}

/// Draws `display` in the remaining space of `ui` (a table cell).
pub fn show(ui: &mut Ui, display: &CellDisplay) {
    match display {
        CellDisplay::Empty => {}
        CellDisplay::Text(text) => {
            ui.add(Label::new(text.as_str()).truncate());
        }
        CellDisplay::Code(text) => {
            ui.add(Label::new(RichText::new(text.as_str()).monospace().size(11.5)).truncate());
        }
        CellDisplay::Number(text) => {
            ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                ui.add(Label::new(text.as_str()).truncate());
            });
        }
        CellDisplay::Link { text, href } => link(ui, text, href),
        CellDisplay::Boolean(checked) => checkbox(ui, *checked),
        CellDisplay::Chips(chips) => chip_row(
            ui,
            chips.iter().map(|chip| (chip.label.as_str(), chip.color)),
        ),
        CellDisplay::Rating {
            value,
            max,
            color: filled,
        } => rating(ui, *value, *max, color(*filled)),
        CellDisplay::Files(names) => files(ui, names),
        CellDisplay::Hidden => {
            ui.weak("••••••••");
        }
        CellDisplay::Error(message) => {
            ui.add(
                Label::new(
                    RichText::new(format!("⚠ {message}")).color(ui.visuals().error_fg_color),
                )
                .truncate(),
            );
        }
    }
}

fn link(ui: &mut Ui, text: &str, href: &str) {
    let label = RichText::new(text).color(ui.visuals().hyperlink_color);
    let response = ui.add(Label::new(label).truncate().sense(Sense::click()));
    let response = response.on_hover_cursor(CursorIcon::PointingHand);
    if response.clicked() {
        ui.ctx().open_url(OpenUrl::new_tab(href));
    }
}

/// A read-only checkbox, drawn like egui's but without the disabled fading.
fn checkbox(ui: &mut Ui, checked: bool) {
    let (rect, _) = ui.allocate_exact_size(Vec2::splat(16.0), Sense::hover());
    let visuals = ui.visuals();
    let corner = CornerRadius::same(3);
    if checked {
        let accent = visuals.selection.bg_fill;
        ui.painter().rect_filled(rect, corner, accent);
        let tick = [
            pos2(rect.left() + 3.5, rect.center().y),
            pos2(rect.center().x - 1.0, rect.bottom() - 4.0),
            pos2(rect.right() - 3.5, rect.top() + 4.0),
        ];
        ui.painter()
            .add(Shape::line(tick.to_vec(), Stroke::new(2.0, Color32::WHITE)));
    } else {
        let stroke = Stroke::new(
            1.0,
            visuals.widgets.inactive.fg_stroke.color.gamma_multiply(0.5),
        );
        ui.painter()
            .rect_stroke(rect.shrink(0.5), corner, stroke, egui::StrokeKind::Inside);
    }
}

/// Paints chips from left to right; the cell clips the ones that overflow.
/// Hovering the cell lists every label, since the overflowing ones are hidden.
fn chip_row<'a>(ui: &mut Ui, chips: impl Iterator<Item = (&'a str, Rgb)>) {
    let available = ui.available_rect_before_wrap();
    let response = ui.allocate_rect(available, Sense::hover());
    let font = FontId::proportional(12.0);
    let mut x = available.left();
    let mut labels = Vec::new();
    for (label, background) in chips {
        labels.push(label);
        if x >= available.right() {
            continue;
        }
        let text_color = if background.is_dark() {
            Color32::WHITE
        } else {
            Color32::from_rgb(0x07, 0x08, 0x10)
        };
        let galley = ui
            .painter()
            .layout_no_wrap(label.to_owned(), font.clone(), text_color);
        let size = vec2(galley.size().x + 2.0 * CHIP_PADDING, CHIP_HEIGHT);
        let rect = Rect::from_min_size(pos2(x, available.center().y - CHIP_HEIGHT / 2.0), size);
        ui.painter()
            .rect_filled(rect, CornerRadius::same(10), color(background));
        let text_pos = Align2::CENTER_CENTER
            .anchor_size(rect.center(), galley.size())
            .min;
        ui.painter().galley(text_pos, galley, text_color);
        x = rect.right() + CHIP_GAP;
    }
    if labels.len() > 1 || x > available.right() {
        response.on_hover_text(labels.join(", "));
    }
}

fn files(ui: &mut Ui, names: &[String]) {
    // The default fonts have no paperclip glyph, so the count is spelled out.
    let badge = if names.len() == 1 {
        "1 fichier".to_owned()
    } else {
        format!("{} fichiers", names.len())
    };
    let neutral = st_core::color::NEUTRAL_CHIP;
    let chips = std::iter::once((badge.as_str(), Rgb::hex(0xdae4fd)))
        .chain(names.iter().map(|name| (name.as_str(), neutral)));
    chip_row(ui, chips);
}

fn rating(ui: &mut Ui, value: u32, max: u32, filled: Color32) {
    let width = max as f32 * (STAR_SIZE + 2.0);
    let (rect, _) = ui.allocate_exact_size(vec2(width, STAR_SIZE), Sense::hover());
    let empty = ui.visuals().widgets.inactive.bg_fill;
    for index in 0..max {
        let center = pos2(
            rect.left() + STAR_SIZE / 2.0 + index as f32 * (STAR_SIZE + 2.0),
            rect.center().y,
        );
        let fill = if index < value { filled } else { empty };
        ui.painter().add(star(center, STAR_SIZE / 2.0, fill));
    }
}

/// A five-pointed star. It is not convex, so it is built as a triangle fan
/// around its center, which every ray from the center crosses once.
fn star(center: Pos2, radius: f32, fill: Color32) -> Shape {
    let mut mesh = Mesh::default();
    mesh.colored_vertex(center, fill);
    for point in 0..10 {
        let angle = std::f32::consts::PI * (point as f32 / 5.0) - std::f32::consts::FRAC_PI_2;
        let distance = if point % 2 == 0 {
            radius
        } else {
            radius * 0.45
        };
        mesh.colored_vertex(center + distance * Vec2::angled(angle), fill);
    }
    for point in 0..10u32 {
        mesh.add_triangle(0, 1 + point, 1 + (point + 1) % 10);
    }
    Shape::mesh(mesh)
}

/// A light placeholder bar for a row whose page is still loading.
pub fn placeholder(ui: &mut Ui) {
    let available = ui.available_rect_before_wrap();
    let bar = Rect::from_center_size(available.center(), vec2(available.width() * 0.6, 8.0));
    ui.painter().rect_filled(
        bar,
        CornerRadius::same(4),
        ui.visuals().widgets.inactive.bg_fill,
    );
}
