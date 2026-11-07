//! Duration text parsing, ported from `src/services/duration.ts`.
//!
//! The engine always parses with the `h:mm:ss.sss` format. For that format
//! every matcher of `duration.ts` uses its default reading, so the per-format
//! readings of duration fields are left to the field code.

use crate::js;
use crate::regexp::Pattern;
use crate::value::Value;

fn total_seconds(
    days: Option<&str>,
    hours: Option<&str>,
    minutes: Option<&str>,
    seconds: Option<&str>,
) -> f64 {
    // `Number(x || 0)`: a missing or empty group counts as 0.
    let number = |part: Option<&str>| {
        part.filter(|part| !part.is_empty())
            .map_or(0.0, js::string_to_number)
    };
    number(days) * 86_400.0 + number(hours) * 3600.0 + number(minutes) * 60.0 + number(seconds)
}

/// `roundForFormat("h:mm:ss.sss")`: milliseconds, halves away from zero.
fn round_to_milliseconds(value: f64) -> f64 {
    (value * 1000.0 + if value >= 0.0 { 0.5 } else { -0.5 }).trunc() / 1000.0
}

type Groups<'a> = [Option<&'a str>];

fn group<'a>(groups: &Groups<'a>, index: usize) -> Option<&'a str> {
    groups.get(index).copied().flatten()
}

/// One accepted syntax and its default reading, in the order `duration.ts`
/// tries them.
struct Matcher {
    pattern: Pattern,
    parse: fn(&Groups<'_>) -> f64,
}

static MATCHERS: [Matcher; 14] = [
    Matcher {
        pattern: Pattern::new(
            r"^((\d+)(?:d\s*))?((\d+)(?:h\s*))?((\d+)(?:m\s*|\s+))?((\d+|\d+\.\d+)?(?:s\s*))?$",
            "",
        ),
        parse: |g| total_seconds(group(g, 2), group(g, 4), group(g, 6), group(g, 8)),
    },
    Matcher {
        pattern: Pattern::new(r"^(\d+)(?:d\s*|\s+)(\d+):(\d+):(\d+|\d+\.\d+)$", ""),
        parse: |g| total_seconds(group(g, 1), group(g, 2), group(g, 3), group(g, 4)),
    },
    Matcher {
        pattern: Pattern::new(r"^(\d+):(\d+):(\d+|\d+\.\d+)$", ""),
        parse: |g| total_seconds(None, group(g, 1), group(g, 2), group(g, 3)),
    },
    Matcher {
        pattern: Pattern::new(r"^(\d+)(?:d\s*|\s+)(\d+)h$", ""),
        parse: |g| total_seconds(group(g, 1), group(g, 2), None, None),
    },
    Matcher {
        pattern: Pattern::new(r"^(\d+)h$", ""),
        parse: |g| total_seconds(None, group(g, 1), None, None),
    },
    Matcher {
        pattern: Pattern::new(r"^(\d+)d$", ""),
        parse: |g| total_seconds(group(g, 1), None, None, None),
    },
    Matcher {
        pattern: Pattern::new(r"^(\d+)(?:d\s*|\s+)(\d+):(\d+)$", ""),
        parse: |g| total_seconds(group(g, 1), None, group(g, 2), group(g, 3)),
    },
    Matcher {
        pattern: Pattern::new(r"^(\d+)(?:d\s*|\s+)(\d+\.\d+)$", ""),
        parse: |g| total_seconds(group(g, 1), None, None, group(g, 2)),
    },
    Matcher {
        pattern: Pattern::new(r"^(\d+):(\d+)$", ""),
        parse: |g| total_seconds(None, None, group(g, 1), group(g, 2)),
    },
    Matcher {
        pattern: Pattern::new(r"^(\d+):(\d+\.\d+)$", ""),
        parse: |g| total_seconds(None, None, group(g, 1), group(g, 2)),
    },
    Matcher {
        pattern: Pattern::new(r"^(\d+)(?:d\s*|\s+)(\d+)$", ""),
        parse: |g| total_seconds(group(g, 1), None, None, group(g, 2)),
    },
    Matcher {
        pattern: Pattern::new(r"^(\d+)(?:d\s*|\s+)(\d+\.\d+)$", ""),
        parse: |g| total_seconds(group(g, 1), None, None, group(g, 2)),
    },
    Matcher {
        pattern: Pattern::new(r"^(\d+)$", ""),
        parse: |g| total_seconds(None, None, None, group(g, 1)),
    },
    Matcher {
        pattern: Pattern::new(r"^(\d+\.\d+)$", ""),
        parse: |g| total_seconds(None, None, None, group(g, 1)),
    },
];

static POSTGRES_INTERVAL: Pattern = Pattern::new(
    r"(?:(-?\d+)\s+years?\s*)|(?:(-?\d+)\s+mons?\s*)|(?:(-?\d+)\s+days?\s*)|(?:(-?\d{1,2}):(\d{2}):(\d{2}))",
    "",
);

/// Reads the text PostgreSQL prints for intervals (`1 year 2 mons 3 days 04:05:06`).
fn parse_postgres_interval(text: &str) -> Option<f64> {
    let mut days = 0.0;
    let mut seconds = 0.0;
    let mut valid = false;
    for groups in POSTGRES_INTERVAL.captures_iter(text) {
        let number = |index: usize| group(&groups, index).map(js::string_to_number);
        if let Some(years) = number(1) {
            days += years * 365.0;
        } else if let Some(months) = number(2) {
            days += months * 30.0;
        } else if let Some(count) = number(3) {
            days += count;
        } else if group(&groups, 4).is_some() {
            seconds += total_seconds(
                None,
                group(&groups, 4),
                group(&groups, 5),
                group(&groups, 6),
            );
        } else {
            continue;
        }
        valid = true;
    }
    valid.then_some(days * 86_400.0 + seconds)
}

fn parse_duration_string(value: &str) -> Option<f64> {
    let mut text = js::trim(value);
    if text.is_empty() {
        return None;
    }
    let mut sign = 1.0;
    if let Some(rest) = text.strip_prefix('-') {
        sign = -1.0;
        text = rest;
    }
    for matcher in &MATCHERS {
        let Some(groups) = matcher.pattern.captures(text) else {
            continue;
        };
        let total = (matcher.parse)(&groups);
        return total.is_finite().then_some(total * sign);
    }
    parse_postgres_interval(text).map(|total| total * sign)
}

/// `parseDurationSeconds(value, "h:mm:ss.sss")`: a number of seconds, or
/// `None` when the value is not a duration.
pub(crate) fn parse_duration_seconds(value: &Value) -> Option<f64> {
    let raw = match value {
        Value::Number(number) => number.is_finite().then_some(*number)?,
        Value::Text(text) => {
            let text = js::trim(text);
            if text.is_empty() {
                return None;
            }
            let numeric = js::string_to_number(text);
            if numeric.is_finite() {
                numeric
            } else {
                parse_duration_string(text)?
            }
        }
        _ => return None,
    };
    Some(round_to_milliseconds(raw))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seconds(text: &str) -> Option<f64> {
        parse_duration_seconds(&Value::from(text))
    }

    #[test]
    fn reads_the_supported_syntaxes() {
        assert_eq!(seconds("90"), Some(90.0));
        assert_eq!(seconds("1:30"), Some(90.0));
        assert_eq!(seconds("1:02:03"), Some(3723.0));
        assert_eq!(seconds("1d 2h 3m 4s"), Some(93_784.0));
        assert_eq!(seconds("2h"), Some(7200.0));
        assert_eq!(seconds("-1:00"), Some(-60.0));
        assert_eq!(seconds("1.23456"), Some(1.235));
        assert_eq!(
            seconds("1 year 2 mons 3 days 04:05:06"),
            Some((365.0 + 60.0 + 3.0) * 86_400.0 + 14_706.0)
        );
        assert_eq!(seconds("invalid"), None);
        assert_eq!(seconds(""), None);
        assert_eq!(parse_duration_seconds(&Value::Number(60.0)), Some(60.0));
        assert_eq!(parse_duration_seconds(&Value::Bool(true)), None);
    }
}
