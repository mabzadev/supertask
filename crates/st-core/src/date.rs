//! Date display for date, created on, last modified and date formula fields.

use chrono::{DateTime, FixedOffset, NaiveDate, Utc};

/// The order of day, month and year (`date_format`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum DateFormat {
    /// `24/02/2025`
    #[default]
    Eu,
    /// `02/24/2025`
    Us,
    /// `2025-02-24`
    Iso,
}

impl DateFormat {
    /// Reads the `date_format` setting; the Worker defaults to `EU`.
    pub fn from_setting(setting: Option<&str>) -> Self {
        match setting {
            Some("US") => Self::Us,
            Some("ISO") => Self::Iso,
            _ => Self::Eu,
        }
    }

    fn pattern(self) -> &'static str {
        match self {
            Self::Eu => "%d/%m/%Y",
            Self::Us => "%m/%d/%Y",
            Self::Iso => "%Y-%m-%d",
        }
    }
}

/// The clock of the time part (`date_time_format`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum TimeFormat {
    /// `17:30`
    #[default]
    H24,
    /// `05:30 PM`
    H12,
}

impl TimeFormat {
    /// Reads the `date_time_format` setting; the Worker defaults to `24`.
    pub fn from_setting(setting: Option<&str>) -> Self {
        match setting {
            Some("12") => Self::H12,
            _ => Self::H24,
        }
    }

    fn pattern(self) -> &'static str {
        match self {
            Self::H24 => "%H:%M",
            Self::H12 => "%I:%M %p",
        }
    }
}

/// The date settings of a field, see [`crate::Field::date_settings`].
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct DateSettings {
    pub format: DateFormat,
    pub include_time: bool,
    pub time_format: TimeFormat,
    pub show_timezone: bool,
    /// An IANA zone name the field is pinned to, if any.
    pub force_timezone: Option<String>,
}

/// Gives the UTC offset of the viewer's time zone at a given instant.
///
/// The offset depends on the instant because of daylight saving time, and only
/// the platform knows the zone rules (the browser on the web, the OS on the
/// desktop), so the app provides this rather than this crate bundling a zone
/// database.
pub trait LocalZone {
    fn offset_at(&self, instant: DateTime<Utc>) -> FixedOffset;
}

impl LocalZone for FixedOffset {
    fn offset_at(&self, _instant: DateTime<Utc>) -> FixedOffset {
        *self
    }
}

/// A date value read from the API.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DateValue {
    /// A calendar date without time (`2025-02-24`).
    Date(NaiveDate),
    /// An instant (`2026-09-15T15:30:00.000Z`).
    Instant(DateTime<Utc>),
}

impl DateValue {
    /// Parses the two shapes the API uses; `None` for anything else.
    pub fn parse(text: &str) -> Option<Self> {
        let text = text.trim();
        if let Ok(date) = NaiveDate::parse_from_str(text, "%Y-%m-%d") {
            return Some(Self::Date(date));
        }
        if let Ok(instant) = DateTime::parse_from_rfc3339(text) {
            return Some(Self::Instant(instant.with_timezone(&Utc)));
        }
        // SQLite's `datetime()` writes "2026-11-07 08:31:12" without a zone; it is UTC.
        chrono::NaiveDateTime::parse_from_str(text, "%Y-%m-%d %H:%M:%S%.f")
            .ok()
            .map(|naive| Self::Instant(naive.and_utc()))
    }
}

impl DateSettings {
    /// Formats a date value of the API, or returns `None` when it does not parse.
    ///
    /// Dates with a time are shown in the viewer's zone (`zone`), or in UTC when
    /// the field is pinned to UTC. A field pinned to another zone is shown in the
    /// viewer's zone too: resolving arbitrary IANA zones needs a zone database
    /// that the app does not ship yet.
    pub fn format(&self, text: &str, zone: &dyn LocalZone) -> Option<String> {
        let value = DateValue::parse(text)?;
        let instant = match value {
            DateValue::Date(date) if !self.include_time => {
                return Some(date.format(self.format.pattern()).to_string());
            }
            DateValue::Date(date) => date.and_hms_opt(0, 0, 0)?.and_utc(),
            DateValue::Instant(instant) => instant,
        };
        if !self.include_time {
            // Like the web app, a date-only field reads instants in UTC.
            return Some(instant.format(self.format.pattern()).to_string());
        }
        let offset = match self.force_timezone.as_deref() {
            Some("UTC" | "Etc/UTC" | "GMT") => FixedOffset::east_opt(0).expect("zero offset"),
            _ => zone.offset_at(instant),
        };
        let local = instant.with_timezone(&offset);
        let pattern = format!("{} {}", self.format.pattern(), self.time_format.pattern());
        let mut formatted = local.format(&pattern).to_string();
        if self.show_timezone {
            formatted.push(' ');
            formatted.push_str(&offset_label(offset));
        }
        Some(formatted)
    }
}

/// `UTC`, `UTC+1`, `UTC-3:30`: a short label for an offset, used when a field
/// asks to show the zone.
pub fn offset_label(offset: FixedOffset) -> String {
    let seconds = offset.local_minus_utc();
    if seconds == 0 {
        return "UTC".to_owned();
    }
    let sign = if seconds < 0 { '-' } else { '+' };
    let minutes = seconds.unsigned_abs() / 60;
    match minutes % 60 {
        0 => format!("UTC{sign}{}", minutes / 60),
        rest => format!("UTC{sign}{}:{rest:02}", minutes / 60),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn paris_summer() -> FixedOffset {
        FixedOffset::east_opt(2 * 3600).unwrap()
    }

    fn settings(format: DateFormat, include_time: bool) -> DateSettings {
        DateSettings {
            format,
            include_time,
            ..Default::default()
        }
    }

    #[test]
    fn formats_plain_dates() {
        let zone = paris_summer();
        assert_eq!(
            settings(DateFormat::Eu, false)
                .format("2025-02-24", &zone)
                .unwrap(),
            "24/02/2025"
        );
        assert_eq!(
            settings(DateFormat::Us, false)
                .format("2025-02-24", &zone)
                .unwrap(),
            "02/24/2025"
        );
        assert_eq!(
            settings(DateFormat::Iso, false)
                .format("2025-02-24", &zone)
                .unwrap(),
            "2025-02-24"
        );
    }

    #[test]
    fn shows_instants_in_the_viewer_zone() {
        let zone = paris_summer();
        let with_time = settings(DateFormat::Eu, true);
        assert_eq!(
            with_time.format("2026-09-15T15:30:00.000Z", &zone).unwrap(),
            "15/09/2026 17:30"
        );
        let twelve = DateSettings {
            time_format: TimeFormat::H12,
            ..with_time.clone()
        };
        assert_eq!(
            twelve.format("2026-09-15T15:30:00.000Z", &zone).unwrap(),
            "15/09/2026 05:30 PM"
        );
        let tz = DateSettings {
            show_timezone: true,
            ..with_time
        };
        assert_eq!(
            tz.format("2026-09-15T15:30:00.000Z", &zone).unwrap(),
            "15/09/2026 17:30 UTC+2"
        );
    }

    #[test]
    fn date_only_fields_read_instants_in_utc() {
        let late_evening = FixedOffset::east_opt(-5 * 3600).unwrap();
        assert_eq!(
            settings(DateFormat::Iso, false)
                .format("2026-11-07T02:00:00Z", &late_evening)
                .unwrap(),
            "2026-11-07"
        );
    }

    #[test]
    fn pinned_utc_ignores_the_viewer_zone() {
        let pinned = DateSettings {
            include_time: true,
            force_timezone: Some("UTC".into()),
            ..Default::default()
        };
        assert_eq!(
            pinned
                .format("2026-09-15T15:30:00Z", &paris_summer())
                .unwrap(),
            "15/09/2026 15:30"
        );
    }

    #[test]
    fn reads_sqlite_timestamps_as_utc() {
        let with_time = settings(DateFormat::Iso, true);
        let utc = FixedOffset::east_opt(0).unwrap();
        assert_eq!(
            with_time.format("2026-11-07 08:31:12", &utc).unwrap(),
            "2026-11-07 08:31"
        );
    }

    #[test]
    fn rejects_garbage() {
        assert_eq!(
            settings(DateFormat::Eu, false).format("demain", &paris_summer()),
            None
        );
    }

    #[test]
    fn labels_offsets() {
        assert_eq!(offset_label(FixedOffset::east_opt(0).unwrap()), "UTC");
        assert_eq!(
            offset_label(FixedOffset::west_opt(3 * 3600 + 1800).unwrap()),
            "UTC-3:30"
        );
    }
}
