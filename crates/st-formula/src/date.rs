//! JavaScript dates, as the TS engine sees them on Cloudflare Workers.
//!
//! The engine stores dates as ISO strings and turns any text into a date with
//! `new Date(text)`, so every comparison or subtraction of strings depends on
//! what V8's date parser accepts. This module reproduces that parser
//! (`src/date/dateparser*.{h,cc}` in V8, legacy fallback included), the ES date
//! arithmetic, `toISOString`, and the `Intl.DateTimeFormat` behaviour used for
//! time zones.
//!
//! Local time is UTC: Workers always run in UTC, so `getHours()` and
//! `getUTCHours()` agree there, and this port treats them as one.

#[cfg(feature = "tzdb")]
use std::sync::OnceLock;

use crate::env::Environment;
use crate::js;

pub(crate) const MS_PER_DAY: f64 = 86_400_000.0;
const MS_PER_HOUR: f64 = 3_600_000.0;
const MS_PER_MINUTE: f64 = 60_000.0;
const MS_PER_SECOND: f64 = 1000.0;
/// The largest time value a `Date` can hold: 100 million days from the epoch.
const MAX_TIME: f64 = 8.64e15;

/// `TimeClip`: `NaN` outside the representable range, else an integer.
pub(crate) fn time_clip(time: f64) -> f64 {
    if !time.is_finite() || time.abs() > MAX_TIME {
        return f64::NAN;
    }
    time.trunc() + 0.0
}

/// `MakeTime`.
pub(crate) fn make_time(hour: f64, minute: f64, second: f64, millisecond: f64) -> f64 {
    if !(hour.is_finite() && minute.is_finite() && second.is_finite() && millisecond.is_finite()) {
        return f64::NAN;
    }
    hour.trunc() * MS_PER_HOUR
        + minute.trunc() * MS_PER_MINUTE
        + second.trunc() * MS_PER_SECOND
        + millisecond.trunc()
}

/// `MakeDay`, with months outside 0..12 rolling over into years.
pub(crate) fn make_day(year: f64, month: f64, date: f64) -> f64 {
    if !(year.is_finite() && month.is_finite() && date.is_finite()) {
        return f64::NAN;
    }
    let full_year = year.trunc() + (month.trunc() / 12.0).floor();
    // Far outside the time range already; bail out before the integer math.
    if full_year.abs() > 100_000_000.0 {
        return f64::NAN;
    }
    let month_in_year = month.trunc().rem_euclid(12.0);
    days_from_civil(full_year as i64, month_in_year as i64 + 1, 1) as f64 + date.trunc() - 1.0
}

/// `MakeDate`.
pub(crate) fn make_date(day: f64, time: f64) -> f64 {
    if !(day.is_finite() && time.is_finite()) {
        return f64::NAN;
    }
    day * MS_PER_DAY + time
}

/// `Date.UTC(year, month, day, hours, minutes, seconds)`, including its quirk
/// of reading years 0 to 99 as 1900 to 1999.
pub(crate) fn date_utc(
    year: f64,
    month: f64,
    day: f64,
    hour: f64,
    minute: f64,
    second: f64,
) -> f64 {
    let year = if year.is_nan() {
        year
    } else {
        let integer = js::to_integer_or_infinity(year);
        if (0.0..=99.0).contains(&integer) {
            1900.0 + integer
        } else {
            year
        }
    };
    time_clip(make_date(
        make_day(year, month, day),
        make_time(hour, minute, second, 0.0),
    ))
}

/// Days from 1970-01-01 to the given proleptic Gregorian date.
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let year_of_era = year - era * 400;
    let day_of_year = (153 * ((month + 9) % 12) + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let days = days + 719_468;
    let era = days.div_euclid(146_097);
    let day_of_era = days - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let shifted_month = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * shifted_month + 2) / 5 + 1;
    let month = if shifted_month < 10 {
        shifted_month + 3
    } else {
        shifted_month - 9
    };
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

/// The calendar fields of a valid time value, in UTC.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Parts {
    pub(crate) year: i64,
    /// 0-based, like `getUTCMonth()`.
    pub(crate) month: i64,
    pub(crate) day: i64,
    pub(crate) hour: i64,
    pub(crate) minute: i64,
    pub(crate) second: i64,
    pub(crate) millisecond: i64,
    /// 0 is Sunday, like `getUTCDay()`.
    pub(crate) weekday: i64,
}

pub(crate) fn parts(time: f64) -> Parts {
    let day = (time / MS_PER_DAY).floor();
    let within_day = (time - day * MS_PER_DAY) as i64;
    let day = day as i64;
    let (year, month, date) = civil_from_days(day);
    Parts {
        year,
        month: month - 1,
        day: date,
        hour: within_day / 3_600_000,
        minute: within_day / 60_000 % 60,
        second: within_day / 1000 % 60,
        millisecond: within_day % 1000,
        weekday: (day + 4).rem_euclid(7),
    }
}

fn time_within_day(time: f64) -> f64 {
    time.rem_euclid(MS_PER_DAY)
}

/// `setUTCFullYear(year)`.
pub(crate) fn set_full_year(time: f64, year: f64) -> f64 {
    let p = parts(time);
    time_clip(make_date(
        make_day(year, p.month as f64, p.day as f64),
        time_within_day(time),
    ))
}

/// `setUTCMonth(month)`.
pub(crate) fn set_month(time: f64, month: f64) -> f64 {
    let p = parts(time);
    time_clip(make_date(
        make_day(p.year as f64, month, p.day as f64),
        time_within_day(time),
    ))
}

/// `setUTCDate(date)`.
pub(crate) fn set_date(time: f64, date: f64) -> f64 {
    let p = parts(time);
    time_clip(make_date(
        make_day(p.year as f64, p.month as f64, date),
        time_within_day(time),
    ))
}

/// `setUTCHours(hour)`.
pub(crate) fn set_hours(time: f64, hour: f64) -> f64 {
    let p = parts(time);
    let day = (time / MS_PER_DAY).floor();
    time_clip(make_date(
        day,
        make_time(hour, p.minute as f64, p.second as f64, p.millisecond as f64),
    ))
}

/// `setUTCMinutes(minute)`.
pub(crate) fn set_minutes(time: f64, minute: f64) -> f64 {
    let p = parts(time);
    let day = (time / MS_PER_DAY).floor();
    time_clip(make_date(
        day,
        make_time(p.hour as f64, minute, p.second as f64, p.millisecond as f64),
    ))
}

/// `Date.prototype.toISOString`, or `None` where it throws `RangeError`.
pub(crate) fn to_iso_string(time: f64) -> Option<String> {
    if time.is_nan() {
        return None;
    }
    let p = parts(time);
    let year = if (0..=9999).contains(&p.year) {
        format!("{:04}", p.year)
    } else {
        format!("{}{:06}", if p.year < 0 { '-' } else { '+' }, p.year.abs())
    };
    Some(format!(
        "{year}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        p.month + 1,
        p.day,
        p.hour,
        p.minute,
        p.second,
        p.millisecond
    ))
}

// ── V8's date parser ──────────────────────────────────────────────────────────

/// `new Date(text).getTime()`: `NaN` when V8 cannot read the text.
pub(crate) fn parse(text: &str) -> f64 {
    let chars: Vec<char> = text.chars().collect();
    let Some(fields) = parse_fields(&chars) else {
        return f64::NAN;
    };
    let day = make_day(fields.year, fields.month, fields.day);
    let time = make_time(
        fields.hour,
        fields.minute,
        fields.second,
        fields.millisecond,
    );
    let mut date = make_date(day, time);
    if let Some(offset) = fields.utc_offset {
        date -= offset * 1000.0;
    }
    time_clip(date)
}

/// The "not set" marker of V8's composers (`kNone`).
const NONE: i32 = i32::MAX;
/// V8 keeps only the first nine digits of a numeral.
const MAX_SIGNIFICANT_DIGITS: usize = 9;
/// `Smi::kMaxValue` with pointer compression, as in workerd.
const SMI_MAX: u32 = (1 << 30) - 1;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum KeywordKind {
    Invalid,
    MonthName,
    TimeZoneName,
    TimeSeparator,
    AmPm,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Token {
    Invalid,
    Unknown,
    Number {
        value: i32,
        length: usize,
    },
    Symbol(char),
    WhiteSpace,
    Keyword {
        kind: KeywordKind,
        value: i32,
        length: usize,
    },
    End,
}

impl Token {
    fn is_number(self) -> bool {
        matches!(self, Token::Number { .. })
    }

    fn is_fixed_length_number(self, wanted: usize) -> bool {
        matches!(self, Token::Number { length, .. } if length == wanted)
    }

    fn number(self) -> i32 {
        match self {
            Token::Number { value, .. } => value,
            _ => 0,
        }
    }

    fn is_ascii_sign(self) -> bool {
        matches!(self, Token::Symbol('+' | '-'))
    }

    fn is_keyword_z(self) -> bool {
        matches!(
            self,
            Token::Keyword {
                kind: KeywordKind::TimeZoneName,
                value: 0,
                length: 1
            }
        )
    }
}

/// V8's keyword table: a word matches on its first three letters, and only
/// month names may be longer than their entry.
const KEYWORDS: [([u8; 3], KeywordKind, i32); 27] = [
    (*b"jan", KeywordKind::MonthName, 1),
    (*b"feb", KeywordKind::MonthName, 2),
    (*b"mar", KeywordKind::MonthName, 3),
    (*b"apr", KeywordKind::MonthName, 4),
    (*b"may", KeywordKind::MonthName, 5),
    (*b"jun", KeywordKind::MonthName, 6),
    (*b"jul", KeywordKind::MonthName, 7),
    (*b"aug", KeywordKind::MonthName, 8),
    (*b"sep", KeywordKind::MonthName, 9),
    (*b"oct", KeywordKind::MonthName, 10),
    (*b"nov", KeywordKind::MonthName, 11),
    (*b"dec", KeywordKind::MonthName, 12),
    (*b"am\0", KeywordKind::AmPm, 0),
    (*b"pm\0", KeywordKind::AmPm, 12),
    (*b"ut\0", KeywordKind::TimeZoneName, 0),
    (*b"utc", KeywordKind::TimeZoneName, 0),
    (*b"z\0\0", KeywordKind::TimeZoneName, 0),
    (*b"gmt", KeywordKind::TimeZoneName, 0),
    (*b"cdt", KeywordKind::TimeZoneName, -5),
    (*b"cst", KeywordKind::TimeZoneName, -6),
    (*b"edt", KeywordKind::TimeZoneName, -4),
    (*b"est", KeywordKind::TimeZoneName, -5),
    (*b"mdt", KeywordKind::TimeZoneName, -6),
    (*b"mst", KeywordKind::TimeZoneName, -7),
    (*b"pdt", KeywordKind::TimeZoneName, -7),
    (*b"pst", KeywordKind::TimeZoneName, -8),
    (*b"t\0\0", KeywordKind::TimeSeparator, 0),
];

fn lookup_keyword(prefix: [u32; 3], length: usize) -> (KeywordKind, i32) {
    KEYWORDS
        .iter()
        .find(|(word, kind, _)| {
            word.iter()
                .zip(prefix)
                .all(|(letter, c)| u32::from(*letter) == c)
                && (length <= 3 || *kind == KeywordKind::MonthName)
        })
        .map_or((KeywordKind::Invalid, 0), |(_, kind, value)| {
            (*kind, *value)
        })
}

struct Scanner<'a> {
    chars: &'a [char],
    position: usize,
    next: Token,
}

impl<'a> Scanner<'a> {
    fn new(chars: &'a [char]) -> Self {
        let mut scanner = Scanner {
            chars,
            position: 0,
            next: Token::End,
        };
        scanner.next = scanner.scan();
        scanner
    }

    fn peek(&self) -> Token {
        self.next
    }

    fn next(&mut self) -> Token {
        let token = self.next;
        self.next = self.scan();
        token
    }

    fn skip_symbol(&mut self, symbol: char) -> bool {
        if self.next == Token::Symbol(symbol) {
            self.next();
            true
        } else {
            false
        }
    }

    /// The current character; V8 reads a NUL character as the end of input.
    fn current(&self) -> char {
        self.chars.get(self.position).copied().unwrap_or('\0')
    }

    fn scan(&mut self) -> Token {
        let start = self.position;
        let c = self.current();
        if c == '\0' {
            return Token::End;
        }
        if c.is_ascii_digit() {
            while self.current() == '0' {
                self.position += 1;
            }
            let mut value: i32 = 0;
            let mut digits = 0;
            while let Some(digit) = self
                .current()
                .to_digit(10)
                .filter(|_| self.current().is_ascii_digit())
            {
                if digits < MAX_SIGNIFICANT_DIGITS {
                    value = value * 10 + digit as i32;
                }
                digits += 1;
                self.position += 1;
            }
            return Token::Number {
                value,
                length: self.position - start,
            };
        }
        if matches!(c, ':' | '-' | '+' | '.' | ')') {
            self.position += 1;
            return Token::Symbol(c);
        }
        if c >= 'A' && !js::is_whitespace(c) {
            let mut prefix = [0u32; 3];
            let mut length = 0;
            while self.current() >= 'A' && !js::is_whitespace(self.current()) {
                if length < 3 {
                    prefix[length] = u32::from(self.current().to_ascii_lowercase());
                }
                length += 1;
                self.position += 1;
            }
            let (kind, value) = lookup_keyword(prefix, length);
            return Token::Keyword {
                kind,
                value,
                length,
            };
        }
        if js::is_whitespace(c) {
            self.position += 1;
            return Token::WhiteSpace;
        }
        if c == '(' {
            let mut balance = 0;
            loop {
                match self.current() {
                    ')' => balance -= 1,
                    '(' => balance += 1,
                    _ => {}
                }
                self.position += 1;
                if balance <= 0 || self.current() == '\0' {
                    break;
                }
            }
            return Token::Unknown;
        }
        self.position += 1;
        Token::Unknown
    }
}

fn between(value: i32, low: i32, high: i32) -> bool {
    (low..=high).contains(&value)
}

fn is_month(value: i32) -> bool {
    between(value, 1, 12)
}

fn is_day(value: i32) -> bool {
    between(value, 1, 31)
}

fn is_hour(value: i32) -> bool {
    between(value, 0, 23)
}

fn is_minute(value: i32) -> bool {
    between(value, 0, 59)
}

fn is_second(value: i32) -> bool {
    between(value, 0, 59)
}

fn is_millisecond(value: i32) -> bool {
    between(value, 0, 999)
}

struct DayComposer {
    components: [i32; 3],
    index: usize,
    named_month: i32,
    is_iso_date: bool,
}

impl DayComposer {
    fn is_empty(&self) -> bool {
        self.index == 0
    }

    fn add(&mut self, value: i32) -> bool {
        if self.index < 3 {
            self.components[self.index] = value;
            self.index += 1;
            true
        } else {
            false
        }
    }

    fn write(&mut self) -> Option<(i32, i32, i32)> {
        if self.index < 1 {
            return None;
        }
        // Day and month default to 1. From here on `index` is always 3, which
        // makes V8's own `index_ == 1` branch dead code; it is kept for parity.
        while self.index < 3 {
            self.components[self.index] = 1;
            self.index += 1;
        }
        let c = self.components;
        let (mut year, month, day);
        if self.named_month == NONE {
            if self.is_iso_date || (self.index == 3 && !is_day(c[0])) {
                (year, month, day) = (c[0], c[1], c[2]);
            } else {
                (month, day) = (c[0], c[1]);
                year = if self.index == 3 { c[2] } else { 0 };
            }
        } else {
            month = self.named_month;
            if self.index == 1 {
                (year, day) = (0, c[0]);
            } else if !is_day(c[0]) {
                (year, day) = (c[0], c[1]);
            } else {
                (day, year) = (c[0], c[1]);
            }
        }
        if !self.is_iso_date {
            if between(year, 0, 49) {
                year += 2000;
            } else if between(year, 50, 99) {
                year += 1900;
            }
        }
        if !is_month(month) || !is_day(day) {
            return None;
        }
        Some((year, month - 1, day))
    }
}

struct TimeComposer {
    components: [i32; 4],
    index: usize,
    hour_offset: i32,
}

impl TimeComposer {
    fn is_empty(&self) -> bool {
        self.index == 0
    }

    fn is_expecting(&self, value: i32) -> bool {
        (self.index == 1 && is_minute(value))
            || (self.index == 2 && is_second(value))
            || (self.index == 3 && is_millisecond(value))
    }

    fn add(&mut self, value: i32) -> bool {
        if self.index < 4 {
            self.components[self.index] = value;
            self.index += 1;
            true
        } else {
            false
        }
    }

    fn add_final(&mut self, value: i32) -> bool {
        if !self.add(value) {
            return false;
        }
        while self.index < 4 {
            self.components[self.index] = 0;
            self.index += 1;
        }
        true
    }

    fn write(&mut self) -> Option<[i32; 4]> {
        while self.index < 4 {
            self.components[self.index] = 0;
            self.index += 1;
        }
        let [mut hour, minute, second, millisecond] = self.components;
        if self.hour_offset != NONE {
            if !between(hour, 0, 12) {
                return None;
            }
            hour %= 12;
            hour += self.hour_offset;
        }
        let valid =
            is_hour(hour) && is_minute(minute) && is_second(second) && is_millisecond(millisecond);
        // 24:00:00.000 is allowed and means midnight of the next day.
        if !valid && (hour != 24 || minute != 0 || second != 0 || millisecond != 0) {
            return None;
        }
        Some([hour, minute, second, millisecond])
    }
}

struct TimeZoneComposer {
    sign: i32,
    hour: i32,
    minute: i32,
}

impl TimeZoneComposer {
    fn set(&mut self, offset_in_hours: i32) {
        self.sign = if offset_in_hours < 0 { -1 } else { 1 };
        self.hour = offset_in_hours * self.sign;
        self.minute = 0;
    }

    fn is_expecting(&self, value: i32) -> bool {
        self.hour != NONE && self.minute == NONE && is_minute(value)
    }

    fn is_utc(&self) -> bool {
        self.hour == 0 && self.minute == 0
    }

    fn is_empty(&self) -> bool {
        self.hour == NONE
    }

    /// The offset in seconds, `Some(None)` for local time, `None` when invalid.
    fn write(&mut self) -> Option<Option<f64>> {
        if self.sign == NONE {
            return Some(None);
        }
        if self.hour == NONE {
            self.hour = 0;
        }
        if self.minute == NONE {
            self.minute = 0;
        }
        // V8 does this in unsigned 32-bit arithmetic, wrapping included.
        let total = (self.hour as u32)
            .wrapping_mul(3600)
            .wrapping_add((self.minute as u32).wrapping_mul(60));
        if total > SMI_MAX {
            return None;
        }
        let total = f64::from(total);
        Some(Some(if self.sign < 0 { -total } else { total }))
    }
}

/// Keeps the three most significant digits of a fraction of a second.
fn read_milliseconds(token: Token) -> i32 {
    let Token::Number { value, length } = token else {
        return 0;
    };
    match length {
        1 => value * 100,
        2 => value * 10,
        3 => value,
        _ => {
            let length = length.min(MAX_SIGNIFICANT_DIGITS);
            value / 10_i32.pow((length - 3) as u32)
        }
    }
}

struct Fields {
    year: f64,
    month: f64,
    day: f64,
    hour: f64,
    minute: f64,
    second: f64,
    millisecond: f64,
    /// Seconds east of UTC, `None` for local time (UTC on Workers).
    utc_offset: Option<f64>,
}

/// `DateParser::ParseES5DateTime`: the ISO 8601 subset of ECMAScript. Returns
/// the first token it could not handle, for the legacy parser to continue with.
fn parse_es5(
    scanner: &mut Scanner<'_>,
    day: &mut DayComposer,
    time: &mut TimeComposer,
    tz: &mut TimeZoneComposer,
) -> Token {
    if scanner.peek().is_ascii_sign() {
        let sign_token = scanner.next();
        if !scanner.peek().is_fixed_length_number(6) {
            return sign_token;
        }
        let sign = if sign_token == Token::Symbol('-') {
            -1
        } else {
            1
        };
        let year = scanner.next().number();
        if sign < 0 && year == 0 {
            return sign_token;
        }
        day.add(sign * year);
    } else if scanner.peek().is_fixed_length_number(4) {
        day.add(scanner.next().number());
    } else {
        return scanner.next();
    }
    if scanner.skip_symbol('-') {
        if !scanner.peek().is_fixed_length_number(2) || !is_month(scanner.peek().number()) {
            return scanner.next();
        }
        day.add(scanner.next().number());
        if scanner.skip_symbol('-') {
            if !scanner.peek().is_fixed_length_number(2) || !is_day(scanner.peek().number()) {
                return scanner.next();
            }
            day.add(scanner.next().number());
        }
    }
    if !matches!(
        scanner.peek(),
        Token::Keyword {
            kind: KeywordKind::TimeSeparator,
            ..
        }
    ) {
        if scanner.peek() != Token::End {
            return scanner.next();
        }
    } else {
        scanner.next();
        if !scanner.peek().is_fixed_length_number(2) || !between(scanner.peek().number(), 0, 24) {
            return Token::Invalid;
        }
        // 24:00[:00[.000]] is allowed, no other time starting with 24.
        let hour_is_24 = scanner.peek().number() == 24;
        time.add(scanner.next().number());
        if !scanner.skip_symbol(':') {
            return Token::Invalid;
        }
        if !scanner.peek().is_fixed_length_number(2)
            || !is_minute(scanner.peek().number())
            || (hour_is_24 && scanner.peek().number() > 0)
        {
            return Token::Invalid;
        }
        time.add(scanner.next().number());
        if scanner.skip_symbol(':') {
            if !scanner.peek().is_fixed_length_number(2)
                || !is_second(scanner.peek().number())
                || (hour_is_24 && scanner.peek().number() > 0)
            {
                return Token::Invalid;
            }
            time.add(scanner.next().number());
            if scanner.skip_symbol('.') {
                if !scanner.peek().is_number() || (hour_is_24 && scanner.peek().number() > 0) {
                    return Token::Invalid;
                }
                time.add(read_milliseconds(scanner.next()));
            }
        }
        if scanner.peek().is_keyword_z() {
            scanner.next();
            tz.set(0);
        } else if scanner.peek().is_ascii_sign() {
            tz.sign = if scanner.next() == Token::Symbol('+') {
                1
            } else {
                -1
            };
            if scanner.peek().is_fixed_length_number(4) {
                let hour_minute = scanner.next().number();
                let (hour, minute) = (hour_minute / 100, hour_minute % 100);
                if !is_hour(hour) || !is_minute(minute) {
                    return Token::Invalid;
                }
                tz.hour = hour;
                tz.minute = minute;
            } else {
                if !scanner.peek().is_fixed_length_number(2) || !is_hour(scanner.peek().number()) {
                    return Token::Invalid;
                }
                tz.hour = scanner.next().number();
                if !scanner.skip_symbol(':') {
                    return Token::Invalid;
                }
                if !scanner.peek().is_fixed_length_number(2) || !is_minute(scanner.peek().number())
                {
                    return Token::Invalid;
                }
                tz.minute = scanner.next().number();
            }
        }
        if scanner.peek() != Token::End {
            return Token::Invalid;
        }
    }
    // Date-only forms are UTC, date-time forms without an offset are local.
    if tz.is_empty() && time.is_empty() {
        tz.set(0);
    }
    day.is_iso_date = true;
    Token::End
}

/// `DateParser::Parse`: the ES5 form first, then V8's legacy heuristics on
/// whatever is left (`"2020-01-01 10:00"`, `"Jan 5 2020"`, `"12/31/1999"`...).
fn parse_fields(chars: &[char]) -> Option<Fields> {
    let mut scanner = Scanner::new(chars);
    let mut day = DayComposer {
        components: [0; 3],
        index: 0,
        named_month: NONE,
        is_iso_date: false,
    };
    let mut time = TimeComposer {
        components: [0; 4],
        index: 0,
        hour_offset: NONE,
    };
    let mut tz = TimeZoneComposer {
        sign: NONE,
        hour: NONE,
        minute: NONE,
    };

    let mut token = parse_es5(&mut scanner, &mut day, &mut time, &mut tz);
    if token == Token::Invalid {
        return None;
    }
    let mut has_read_number = !day.is_empty();
    while token != Token::End {
        match token {
            Token::Number { value: number, .. } => {
                has_read_number = true;
                if scanner.skip_symbol(':') {
                    if scanner.skip_symbol(':') {
                        if !time.is_empty() {
                            return None;
                        }
                        time.add(number);
                        time.add(0);
                    } else {
                        if !time.add(number) {
                            return None;
                        }
                        if scanner.peek() == Token::Symbol('.') {
                            scanner.next();
                        }
                    }
                } else if scanner.skip_symbol('.') && time.is_expecting(number) {
                    time.add(number);
                    if !scanner.peek().is_number() {
                        return None;
                    }
                    let millisecond = read_milliseconds(scanner.next());
                    if millisecond < 0 {
                        return None;
                    }
                    time.add_final(millisecond);
                } else if tz.is_expecting(number) {
                    tz.minute = number;
                } else if time.is_expecting(number) {
                    time.add_final(number);
                    // A finished time must be followed by the end, a space, "Z" or a sign.
                    let peek = scanner.peek();
                    if !(peek == Token::End
                        || peek == Token::WhiteSpace
                        || peek.is_keyword_z()
                        || peek.is_ascii_sign())
                    {
                        return None;
                    }
                } else {
                    if !day.add(number) {
                        return None;
                    }
                    scanner.skip_symbol('-');
                }
            }
            Token::Keyword { kind, value, .. } => {
                if kind == KeywordKind::AmPm && !time.is_empty() {
                    time.hour_offset = value;
                } else if kind == KeywordKind::MonthName {
                    day.named_month = value;
                    scanner.skip_symbol('-');
                } else if kind == KeywordKind::TimeZoneName && has_read_number {
                    tz.set(value);
                } else {
                    // Garbage words are only allowed before the first number,
                    // and must be separated from it.
                    if has_read_number || scanner.peek().is_number() {
                        return None;
                    }
                }
            }
            Token::Symbol(sign @ ('+' | '-')) if tz.is_utc() || !time.is_empty() => {
                tz.sign = if sign == '+' { 1 } else { -1 };
                let (mut number, mut length) = (0, 0);
                if let Token::Number {
                    value,
                    length: digits,
                } = scanner.peek()
                {
                    scanner.next();
                    (number, length) = (value, digits);
                }
                has_read_number = true;
                if scanner.peek() == Token::Symbol(':') {
                    tz.hour = number;
                    tz.minute = NONE;
                } else if length == 1 || length == 2 {
                    tz.hour = number;
                    tz.minute = 0;
                } else if length == 3 || length == 4 {
                    tz.hour = number / 100;
                    tz.minute = number % 100;
                } else {
                    return None;
                }
            }
            Token::Symbol('+' | '-' | ')') if has_read_number => return None,
            _ => {}
        }
        token = scanner.next();
    }

    let (year, month, date) = day.write()?;
    let [hour, minute, second, millisecond] = time.write()?;
    let utc_offset = tz.write()?;
    Some(Fields {
        year: year.into(),
        month: month.into(),
        day: date.into(),
        hour: hour.into(),
        minute: minute.into(),
        second: second.into(),
        millisecond: millisecond.into(),
        utc_offset,
    })
}

// ── Intl time zones ───────────────────────────────────────────────────────────

/// A time zone `Intl.DateTimeFormat` accepts.
pub(crate) enum TimeZone<'a> {
    /// An offset identifier such as `+01:00`, in seconds.
    Fixed(f64),
    /// An IANA name, resolved by the [`Environment`].
    Named(&'a str),
}

/// Resolves a `timeZone` option, or `None` where `Intl` throws `RangeError`.
/// Offsets are `±HH`, `±HHMM` or `±HH:MM`; names go to the environment.
pub(crate) fn time_zone<'a>(name: &'a str, env: &mut dyn Environment) -> Option<TimeZone<'a>> {
    if let Some(offset) = offset_time_zone(name) {
        return Some(TimeZone::Fixed(offset));
    }
    if name.is_empty() {
        return None;
    }
    env.time_zone_offset_ms(name, 0.0)?;
    Some(TimeZone::Named(name))
}

fn offset_time_zone(name: &str) -> Option<f64> {
    let bytes = name.as_bytes();
    let sign = match bytes.first()? {
        b'+' => 1.0,
        b'-' => -1.0,
        _ => return None,
    };
    let digits = |range: std::ops::Range<usize>| -> Option<f64> {
        let part = name.get(range)?;
        part.bytes()
            .all(|byte| byte.is_ascii_digit())
            .then(|| part.parse::<f64>().ok())?
    };
    let (hour, minute) = match bytes.len() {
        3 => (digits(1..3)?, 0.0),
        5 => (digits(1..3)?, digits(3..5)?),
        6 if bytes[3] == b':' => (digits(1..3)?, digits(4..6)?),
        _ => return None,
    };
    (hour <= 23.0 && minute <= 59.0).then_some(sign * (hour * 3600.0 + minute * 60.0))
}

impl TimeZone<'_> {
    /// The offset from UTC at an instant, in milliseconds.
    pub(crate) fn offset_ms(&self, time: f64, env: &mut dyn Environment) -> f64 {
        match self {
            TimeZone::Fixed(seconds) => seconds * 1000.0,
            TimeZone::Named(name) => env.time_zone_offset_ms(name, time).unwrap_or(0.0),
        }
    }

    /// The local calendar fields at an instant.
    pub(crate) fn local_parts(&self, time: f64, env: &mut dyn Environment) -> Parts {
        parts(time + self.offset_ms(time, env))
    }
}

/// [`Environment::time_zone_offset_ms`] from the bundled IANA database.
#[cfg(feature = "tzdb")]
pub(crate) fn bundled_offset_ms(name: &str, time: f64) -> Option<f64> {
    fn database() -> &'static jiff::tz::TimeZoneDatabase {
        static DATABASE: OnceLock<jiff::tz::TimeZoneDatabase> = OnceLock::new();
        DATABASE.get_or_init(jiff::tz::TimeZoneDatabase::bundled)
    }
    if !name.is_ascii() {
        return None;
    }
    let zone = database().get(name).ok()?;
    Some(f64::from(zone.to_offset(jiff_timestamp(time)).seconds()) * 1000.0)
}

/// Without the bundled database, no IANA name is known.
#[cfg(not(feature = "tzdb"))]
pub(crate) fn bundled_offset_ms(_name: &str, _time: f64) -> Option<f64> {
    None
}

/// Maps a time value into jiff's range (years -9999 to 9999). The calendar and
/// a zone's final rule both repeat every 400 years, so far dates are shifted by
/// whole 400-year cycles.
#[cfg(feature = "tzdb")]
fn jiff_timestamp(time: f64) -> jiff::Timestamp {
    const CYCLE: f64 = 146_097.0 * MS_PER_DAY;
    const LATEST: f64 = 250_000_000_000_000.0;
    const EARLIEST: f64 = -370_000_000_000_000.0;
    let mut time = time;
    if time > LATEST {
        time -= ((time - LATEST) / CYCLE).ceil() * CYCLE;
    } else if time < EARLIEST {
        time += ((EARLIEST - time) / CYCLE).ceil() * CYCLE;
    }
    jiff::Timestamp::from_millisecond(time as i64).unwrap_or(jiff::Timestamp::UNIX_EPOCH)
}

/// The fields `formatToParts` returns for the `en-GB` options the engine uses.
/// Years at or before 0 print as positive era years, as `Intl` does.
pub(crate) struct IntlParts {
    pub(crate) year: String,
    pub(crate) month: String,
    pub(crate) day: String,
    pub(crate) hour: String,
    pub(crate) minute: String,
    pub(crate) second: String,
}

pub(crate) fn intl_parts(time: f64, zone: &TimeZone<'_>, env: &mut dyn Environment) -> IntlParts {
    let p = zone.local_parts(time, env);
    IntlParts {
        year: (if p.year <= 0 { 1 - p.year } else { p.year }).to_string(),
        month: format!("{:02}", p.month + 1),
        day: format!("{:02}", p.day),
        hour: format!("{:02}", p.hour),
        minute: format!("{:02}", p.minute),
        second: format!("{:02}", p.second),
    }
}

pub(crate) const WEEKDAYS: [&str; 7] = [
    "sunday",
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
];

#[cfg(test)]
mod tests {
    use super::*;

    fn iso(text: &str) -> String {
        to_iso_string(parse(text)).unwrap_or_else(|| "NaN".to_owned())
    }

    /// Expected values recorded from V8 (Node 24, TZ=UTC).
    #[test]
    fn parses_like_v8() {
        let cases = [
            ("1", "2001-01-01T00:00:00.000Z"),
            ("13", "NaN"),
            ("32", "2032-01-01T00:00:00.000Z"),
            ("2020", "2020-01-01T00:00:00.000Z"),
            ("2020-1-1", "2020-01-01T00:00:00.000Z"),
            ("2020-01-01 10:00", "2020-01-01T10:00:00.000Z"),
            ("2020/01/02", "2020-01-02T00:00:00.000Z"),
            ("01/02/2020", "2020-01-02T00:00:00.000Z"),
            ("Jan 5", "2001-01-05T00:00:00.000Z"),
            ("5 Jan 2020", "2020-01-05T00:00:00.000Z"),
            (
                "January 5, 2020 10:00:00 GMT+0200",
                "2020-01-05T08:00:00.000Z",
            ),
            ("Tue Jan 01 2020", "2020-01-01T00:00:00.000Z"),
            ("n:5", "2001-05-01T00:00:00.000Z"),
            ("a", "NaN"),
            ("2020-01-01T10:00", "2020-01-01T10:00:00.000Z"),
            ("2020-01-01T24:00", "2020-01-02T00:00:00.000Z"),
            ("2020-01-01T10:00:00.1234Z", "2020-01-01T10:00:00.123Z"),
            ("+002020-01-01", "2020-01-01T00:00:00.000Z"),
            ("-000000-01-01", "2001-01-01T00:00:00.000Z"),
            ("2020-01-01T10:00+0100", "2020-01-01T09:00:00.000Z"),
            (" 2020-01-01", "2020-01-01T00:00:00.000Z"),
            ("2020-01-01Z", "2020-01-01T00:00:00.000Z"),
            ("10:00", "NaN"),
            ("2020-01-01 10:00 PM", "2020-01-01T22:00:00.000Z"),
            ("12/31/1999 23:59:59 UTC+1", "1999-12-31T22:59:59.000Z"),
            ("2020-13-01", "NaN"),
            ("2020-02-30", "2020-03-01T00:00:00.000Z"),
            ("Mon, 01 Jan 2024 10:00:00 GMT", "2024-01-01T10:00:00.000Z"),
            ("1e3", "NaN"),
            ("1.5", "2001-01-05T00:00:00.000Z"),
            ("-5", "2001-05-01T00:00:00.000Z"),
            ("(c) 2020", "2020-01-01T00:00:00.000Z"),
            ("2020-01-01 (note)", "2020-01-01T00:00:00.000Z"),
            ("99", "1999-01-01T00:00:00.000Z"),
            ("49", "2049-01-01T00:00:00.000Z"),
            ("50", "1950-01-01T00:00:00.000Z"),
            ("0", "2000-01-01T00:00:00.000Z"),
            ("100", "0100-01-01T00:00:00.000Z"),
            ("2020-01", "2020-01-01T00:00:00.000Z"),
            ("2020-01-01T10:00:00+01:00", "2020-01-01T09:00:00.000Z"),
        ];
        for (text, expected) in cases {
            assert_eq!(iso(text), expected, "{text:?}");
        }
    }

    #[test]
    fn iso_strings_cover_extended_years() {
        assert_eq!(
            to_iso_string(date_utc(275760.0, 8.0, 13.0, 0.0, 0.0, 0.0)).unwrap(),
            "+275760-09-13T00:00:00.000Z"
        );
        assert_eq!(
            to_iso_string(make_date(make_day(-1.0, 0.0, 1.0), 0.0)).unwrap(),
            "-000001-01-01T00:00:00.000Z"
        );
        assert!(date_utc(275760.0, 8.0, 14.0, 0.0, 0.0, 0.0).is_nan());
        assert!(to_iso_string(f64::NAN).is_none());
    }

    #[cfg(feature = "tzdb")]
    #[test]
    fn time_zones_resolve_like_intl() {
        let env = &mut crate::FixedEnvironment::default();
        for name in [
            "+01:00",
            "+0100",
            "+01",
            "-05:30",
            "UTC",
            "utc",
            "cet",
            "Etc/GMT+1",
            "europe/rome",
            "GMT",
            "EST",
            "US/Pacific",
            "-00:00",
        ] {
            assert!(time_zone(name, env).is_some(), "{name}");
        }
        for name in ["Z", "NONSENSE", "", "+1", "+01:0", "+24:00"] {
            assert!(time_zone(name, env).is_none(), "{name}");
        }
        let rome = time_zone("Europe/Rome", env).unwrap();
        let winter = date_utc(2020.0, 0.0, 1.0, 12.0, 0.0, 0.0);
        let summer = date_utc(2020.0, 6.0, 1.0, 12.0, 0.0, 0.0);
        assert_eq!(rome.offset_ms(winter, env), 3_600_000.0);
        assert_eq!(rome.offset_ms(summer, env), 7_200_000.0);
    }

    #[cfg(not(feature = "tzdb"))]
    #[test]
    fn without_the_database_only_offsets_resolve() {
        let env = &mut crate::FixedEnvironment::default();
        assert!(time_zone("+01:00", env).is_some());
        assert!(time_zone("Europe/Rome", env).is_none());
    }
}
