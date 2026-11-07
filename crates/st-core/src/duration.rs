//! Duration display. Durations travel as a number of seconds.

/// The display formats of a duration field (`duration_format`), the same ten
/// as the web app.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum DurationFormat {
    /// `h:mm` (1:23)
    #[default]
    HM,
    /// `h:mm:ss` (1:23:40)
    HMS,
    /// `h:mm:ss.s` (1:23:40.0)
    HMSDeci,
    /// `h:mm:ss.ss` (1:23:40.00)
    HMSCenti,
    /// `h:mm:ss.sss` (1:23:40.000)
    HMSMilli,
    /// `d h` (1d 2h)
    DH,
    /// `d h:mm` (1d 2:34)
    DHM,
    /// `d h:mm:ss` (1d 2:34:56)
    DHMS,
    /// `d h mm` (1d 2h 03m)
    DHMWords,
    /// `d h mm ss` (1d 2h 03m 04s)
    DHMSWords,
}

impl DurationFormat {
    /// Reads the `duration_format` setting; unknown values fall back to `h:mm`
    /// like the Worker.
    pub fn from_setting(setting: Option<&str>) -> Self {
        match setting {
            Some("h:mm:ss") => Self::HMS,
            Some("h:mm:ss.s") => Self::HMSDeci,
            Some("h:mm:ss.ss") => Self::HMSCenti,
            Some("h:mm:ss.sss") => Self::HMSMilli,
            Some("d h") => Self::DH,
            Some("d h:mm") => Self::DHM,
            Some("d h:mm:ss") => Self::DHMS,
            Some("d h mm") => Self::DHMWords,
            Some("d h mm ss") => Self::DHMSWords,
            _ => Self::HM,
        }
    }

    /// Rounds a number of seconds to the precision the format shows, half away
    /// from zero (the Worker rounds stored values the same way).
    fn round(self, seconds: f64) -> f64 {
        let round_to = |unit: f64| (seconds / unit).round() * unit;
        match self {
            Self::HM | Self::DHM | Self::DHMWords => round_to(60.0),
            Self::DH => round_to(3600.0),
            Self::HMS | Self::DHMS | Self::DHMSWords => seconds.round(),
            Self::HMSDeci => (seconds * 10.0).round() / 10.0,
            Self::HMSCenti => (seconds * 100.0).round() / 100.0,
            Self::HMSMilli => (seconds * 1000.0).round() / 1000.0,
        }
    }

    /// Formats a number of seconds.
    pub fn format(self, seconds: f64) -> String {
        if !seconds.is_finite() {
            return String::new();
        }
        let rounded = self.round(seconds);
        let sign = if rounded < 0.0 { "-" } else { "" };
        let value = rounded.abs();
        let whole = value.trunc() as u64;
        let days = whole / 86_400;
        let hours = whole % 86_400 / 3600;
        let minutes = whole % 3600 / 60;
        let secs = value - (whole - whole % 60) as f64;
        let total_hours = days * 24 + hours;
        let body = match self {
            Self::HM => format!("{total_hours}:{minutes:02}"),
            Self::HMS => format!("{total_hours}:{minutes:02}:{secs:02.0}"),
            Self::HMSDeci => format!("{total_hours}:{minutes:02}:{secs:04.1}"),
            Self::HMSCenti => format!("{total_hours}:{minutes:02}:{secs:05.2}"),
            Self::HMSMilli => format!("{total_hours}:{minutes:02}:{secs:06.3}"),
            Self::DH => format!("{days}d {hours}h"),
            Self::DHM => format!("{days}d {hours}:{minutes:02}"),
            Self::DHMS => format!("{days}d {hours}:{minutes:02}:{secs:02.0}"),
            Self::DHMWords => format!("{days}d {hours}h {minutes:02}m"),
            Self::DHMSWords => format!("{days}d {hours}h {minutes:02}m {secs:02.0}s"),
        };
        format!("{sign}{body}")
    }
}

#[cfg(test)]
mod tests {
    use super::DurationFormat as F;

    #[test]
    fn formats_hours_and_minutes() {
        // 41 h, as captured on the "Temps passé" field.
        assert_eq!(F::HM.format(147_600.0), "41:00");
        assert_eq!(F::HM.format(5_025.0), "1:24");
        assert_eq!(F::HM.format(0.0), "0:00");
    }

    #[test]
    fn formats_seconds_and_fractions() {
        assert_eq!(F::HMS.format(5_020.0), "1:23:40");
        assert_eq!(F::HMSDeci.format(5_020.04), "1:23:40.0");
        assert_eq!(F::HMSCenti.format(5_020.5), "1:23:40.50");
        assert_eq!(F::HMSMilli.format(61.5), "0:01:01.500");
        assert_eq!(F::HMSDeci.format(3.25), "0:00:03.3");
    }

    #[test]
    fn formats_days() {
        let value = 86_400.0 + 2.0 * 3600.0 + 34.0 * 60.0 + 56.0;
        assert_eq!(F::DH.format(value), "1d 3h");
        assert_eq!(F::DHM.format(value), "1d 2:35");
        assert_eq!(F::DHMS.format(value), "1d 2:34:56");
        assert_eq!(F::DHMWords.format(value), "1d 2h 35m");
        assert_eq!(F::DHMSWords.format(value), "1d 2h 34m 56s");
    }

    #[test]
    fn keeps_the_sign() {
        assert_eq!(F::HM.format(-90.0), "-0:02");
        assert_eq!(F::HMS.format(-3_600.0), "-1:00:00");
    }

    #[test]
    fn unknown_setting_falls_back_to_hours_minutes() {
        assert_eq!(F::from_setting(Some("fortnights")), F::HM);
        assert_eq!(F::from_setting(Some("d h mm ss")), F::DHMSWords);
    }
}
