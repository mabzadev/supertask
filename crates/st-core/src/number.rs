//! Number display.
//!
//! The API sends numbers as decimal strings (`"27700.00"`) because D1 stores
//! them as text to keep exact decimals. Formatting therefore works on the
//! decimal digits directly: going through `f64` would print `0.1 + 0.2`-style
//! artefacts and lose precision past 15 digits, which the web app does not.

/// Thousands and decimal separators of a number field (`number_separator`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum NumberSeparator {
    /// No thousands separator, period for decimals (`1234.5`).
    #[default]
    None,
    /// `1 234,5`
    SpaceComma,
    /// `1 234.5`
    SpacePeriod,
    /// `1,234.5`
    CommaPeriod,
    /// `1.234,5`
    PeriodComma,
}

impl NumberSeparator {
    /// Reads the `number_separator` setting; unknown values mean no formatting,
    /// like the web app.
    pub fn from_setting(setting: Option<&str>) -> Self {
        match setting {
            Some("SPACE_COMMA") => Self::SpaceComma,
            Some("SPACE_PERIOD") => Self::SpacePeriod,
            Some("COMMA_PERIOD") => Self::CommaPeriod,
            Some("PERIOD_COMMA") => Self::PeriodComma,
            _ => Self::None,
        }
    }

    fn thousands(self) -> &'static str {
        match self {
            Self::None => "",
            Self::SpaceComma | Self::SpacePeriod => " ",
            Self::CommaPeriod => ",",
            Self::PeriodComma => ".",
        }
    }

    fn decimal(self) -> char {
        match self {
            Self::SpaceComma | Self::PeriodComma => ',',
            Self::None | Self::SpacePeriod | Self::CommaPeriod => '.',
        }
    }
}

/// How a number field writes its values.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct NumberFormat {
    /// Digits after the decimal separator; `None` keeps the digits as sent.
    pub decimal_places: Option<u32>,
    pub prefix: String,
    pub suffix: String,
    pub separator: NumberSeparator,
}

impl NumberFormat {
    /// Formats a decimal string such as `"-1234.5"` or `"1e3"`.
    ///
    /// Returns `None` when the text is not a number, so that the caller can
    /// show it as is instead of hiding a value it does not understand.
    pub fn format(&self, text: &str) -> Option<String> {
        let mut decimal = Decimal::parse(text)?;
        if let Some(places) = self.decimal_places {
            decimal.round_to(places as usize);
        }
        let integer = group_thousands(&decimal.integer, self.separator.thousands());
        let mut body = integer;
        if !decimal.fraction.is_empty() {
            body.push(self.separator.decimal());
            body.push_str(&decimal.fraction);
        }
        let sign = if decimal.negative && !decimal.is_zero() {
            "-"
        } else {
            ""
        };
        let formatted = format!("{sign}{}{body}{}", self.prefix, self.suffix);
        Some(formatted.trim().to_owned())
    }
}

/// Inserts `separator` between groups of three digits of an integer part.
pub fn group_thousands(digits: &str, separator: &str) -> String {
    if separator.is_empty() || digits.len() <= 3 {
        return digits.to_owned();
    }
    let mut grouped = String::with_capacity(digits.len() + digits.len() / 3 * separator.len());
    for (index, digit) in digits.chars().enumerate() {
        if index > 0 && (digits.len() - index).is_multiple_of(3) {
            grouped.push_str(separator);
        }
        grouped.push(digit);
    }
    grouped
}

/// A decimal number split into digits, without any floating point.
#[derive(Debug, PartialEq, Eq)]
struct Decimal {
    negative: bool,
    /// Integer digits without leading zeros ("0" for zero).
    integer: String,
    /// Fraction digits, possibly empty.
    fraction: String,
}

impl Decimal {
    fn parse(text: &str) -> Option<Self> {
        let text = text.trim();
        let (negative, unsigned) = match text.as_bytes().first()? {
            b'-' => (true, &text[1..]),
            b'+' => (false, &text[1..]),
            _ => (false, text),
        };
        let (mantissa, exponent) = match unsigned.find(['e', 'E']) {
            Some(index) => (
                &unsigned[..index],
                unsigned[index + 1..].parse::<i32>().ok()?,
            ),
            None => (unsigned, 0),
        };
        let (integer, fraction) = mantissa.split_once('.').unwrap_or((mantissa, ""));
        let all_digits = |part: &str| part.bytes().all(|byte| byte.is_ascii_digit());
        if (integer.is_empty() && fraction.is_empty())
            || !all_digits(integer)
            || !all_digits(fraction)
        {
            return None;
        }
        // Shift the decimal point by the exponent on the digit string.
        let digits = format!("{integer}{fraction}");
        let point = integer.len() as i64 + i64::from(exponent);
        let (integer, fraction) = if point <= 0 {
            (
                String::new(),
                format!("{}{digits}", "0".repeat(point.unsigned_abs() as usize)),
            )
        } else if point as usize >= digits.len() {
            (
                format!("{digits}{}", "0".repeat(point as usize - digits.len())),
                String::new(),
            )
        } else {
            let (left, right) = digits.split_at(point as usize);
            (left.to_owned(), right.to_owned())
        };
        let integer = integer.trim_start_matches('0');
        Some(Self {
            negative,
            integer: if integer.is_empty() {
                "0".to_owned()
            } else {
                integer.to_owned()
            },
            fraction,
        })
    }

    fn is_zero(&self) -> bool {
        self.integer == "0" && self.fraction.bytes().all(|byte| byte == b'0')
    }

    /// Rounds half away from zero, as `Intl.NumberFormat` does in the web app.
    fn round_to(&mut self, places: usize) {
        if self.fraction.len() <= places {
            self.fraction
                .push_str(&"0".repeat(places - self.fraction.len()));
            return;
        }
        let round_up = self.fraction.as_bytes()[places] >= b'5';
        self.fraction.truncate(places);
        if !round_up {
            return;
        }
        // Add one unit in the last kept place, carrying through the digits.
        let mut digits: Vec<u8> = format!("{}{}", self.integer, self.fraction).into_bytes();
        let mut index = digits.len();
        loop {
            if index == 0 {
                digits.insert(0, b'1');
                break;
            }
            index -= 1;
            if digits[index] == b'9' {
                digits[index] = b'0';
            } else {
                digits[index] += 1;
                break;
            }
        }
        let split = digits.len() - places;
        let digits = String::from_utf8(digits).expect("ASCII digits");
        self.integer = digits[..split].to_owned();
        self.fraction = digits[split..].to_owned();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn format(places: Option<u32>, separator: NumberSeparator, text: &str) -> String {
        let format = NumberFormat {
            decimal_places: places,
            separator,
            ..Default::default()
        };
        format.format(text).unwrap()
    }

    #[test]
    fn keeps_api_digits_without_settings() {
        assert_eq!(format(None, NumberSeparator::None, "27700.00"), "27700.00");
        assert_eq!(format(None, NumberSeparator::None, "-29"), "-29");
        assert_eq!(format(None, NumberSeparator::None, "0.1"), "0.1");
    }

    #[test]
    fn pads_and_rounds_to_decimal_places() {
        assert_eq!(format(Some(2), NumberSeparator::None, "3"), "3.00");
        assert_eq!(format(Some(2), NumberSeparator::None, "1.005"), "1.01");
        assert_eq!(format(Some(0), NumberSeparator::None, "2.5"), "3");
        assert_eq!(format(Some(0), NumberSeparator::None, "-2.5"), "-3");
        assert_eq!(format(Some(1), NumberSeparator::None, "9.96"), "10.0");
        assert_eq!(format(Some(0), NumberSeparator::None, "999.9"), "1000");
    }

    #[test]
    fn negative_zero_has_no_sign() {
        assert_eq!(format(Some(0), NumberSeparator::None, "-0.2"), "0");
    }

    #[test]
    fn applies_separators() {
        assert_eq!(
            format(Some(2), NumberSeparator::SpaceComma, "1234567.891"),
            "1 234 567,89"
        );
        assert_eq!(
            format(Some(1), NumberSeparator::CommaPeriod, "-1234.5"),
            "-1,234.5"
        );
        assert_eq!(format(None, NumberSeparator::PeriodComma, "1000"), "1.000");
        assert_eq!(format(None, NumberSeparator::SpacePeriod, "999"), "999");
    }

    #[test]
    fn reads_exponents() {
        assert_eq!(format(None, NumberSeparator::None, "1e3"), "1000");
        assert_eq!(format(None, NumberSeparator::None, "1.5E-2"), "0.015");
        assert_eq!(format(Some(2), NumberSeparator::None, "2.5e-1"), "0.25");
    }

    #[test]
    fn prefix_and_suffix_surround_the_digits_after_the_sign() {
        let euro = NumberFormat {
            decimal_places: Some(2),
            prefix: String::new(),
            suffix: " €".into(),
            separator: NumberSeparator::SpaceComma,
        };
        assert_eq!(euro.format("68400").unwrap(), "68 400,00 €");
        let dollar = NumberFormat {
            prefix: "$".into(),
            ..Default::default()
        };
        assert_eq!(dollar.format("-5").unwrap(), "-$5");
    }

    #[test]
    fn rejects_text_that_is_not_a_number() {
        let plain = NumberFormat::default();
        assert_eq!(plain.format("abc"), None);
        assert_eq!(plain.format(""), None);
        assert_eq!(plain.format("1.2.3"), None);
        assert_eq!(plain.format("-"), None);
    }

    #[test]
    fn groups_thousands() {
        assert_eq!(group_thousands("10000", "\u{202f}"), "10\u{202f}000");
        assert_eq!(group_thousands("123", " "), "123");
        assert_eq!(group_thousands("1234", ""), "1234");
    }
}
