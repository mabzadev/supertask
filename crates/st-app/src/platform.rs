//! The few things that differ between the browser and the desktop.

use chrono::{DateTime, FixedOffset, Utc};
use st_core::date::LocalZone;

/// The viewer's time zone, as the platform knows it: the browser's zone on the
/// web, the operating system's on the desktop.
pub struct ViewerZone;

impl LocalZone for ViewerZone {
    #[cfg(target_arch = "wasm32")]
    fn offset_at(&self, instant: DateTime<Utc>) -> FixedOffset {
        let date = js_sys::Date::new(&wasm_bindgen::JsValue::from_f64(
            instant.timestamp_millis() as f64
        ));
        // getTimezoneOffset() is UTC minus local, in minutes.
        let seconds = (-date.get_timezone_offset() * 60.0) as i32;
        FixedOffset::east_opt(seconds).unwrap_or_else(utc)
    }

    #[cfg(not(target_arch = "wasm32"))]
    fn offset_at(&self, instant: DateTime<Utc>) -> FixedOffset {
        use chrono::{Offset as _, TimeZone as _};
        chrono::Local
            .offset_from_utc_datetime(&instant.naive_utc())
            .fix()
    }
}

#[cfg(target_arch = "wasm32")]
fn utc() -> FixedOffset {
    FixedOffset::east_opt(0).expect("zero offset")
}

/// Publishes measurements of the grid where a test harness can read them.
///
/// On the web they go to `data-*` attributes of the canvas, which a headless
/// browser reads without parsing pixels (phase 0 measures how many rows are
/// laid out per frame). On the desktop there is no such reader, so this does
/// nothing.
#[derive(Default)]
pub struct Diagnostics {
    #[cfg(target_arch = "wasm32")]
    published: std::collections::HashMap<&'static str, String>,
}

impl Diagnostics {
    #[cfg(target_arch = "wasm32")]
    pub fn publish(&mut self, name: &'static str, value: impl ToString) {
        let value = value.to_string();
        if self.published.get(name) == Some(&value) {
            return;
        }
        let canvas = web_sys::window()
            .and_then(|window| window.document())
            .and_then(|document| document.get_element_by_id(crate::CANVAS_ID));
        if let Some(canvas) = canvas {
            let _ = canvas.set_attribute(&format!("data-{name}"), &value);
        }
        self.published.insert(name, value);
    }

    #[cfg(not(target_arch = "wasm32"))]
    pub fn publish(&mut self, _name: &'static str, _value: impl ToString) {}
}
