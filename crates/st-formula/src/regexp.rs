//! JavaScript regular expressions, through `regress`.
//!
//! The TS code uses regular expressions in two ways: fixed patterns of its own
//! (URL validation, duration and interval syntax), and user patterns passed to
//! `regex_replace` / `regex_match`. Both go through an ECMAScript engine so that
//! backtracking, `\s`, `.` and replacement patterns behave as they do in V8.

use std::ops::Range;
use std::sync::{Arc, Mutex, OnceLock};

use regress::Regex;

use crate::js;

/// A fixed pattern from the TS source, compiled once.
pub(crate) struct Pattern {
    source: &'static str,
    flags: &'static str,
    compiled: OnceLock<Regex>,
}

impl Pattern {
    pub(crate) const fn new(source: &'static str, flags: &'static str) -> Self {
        Pattern {
            source,
            flags,
            compiled: OnceLock::new(),
        }
    }

    fn regex(&self) -> &Regex {
        self.compiled.get_or_init(|| {
            // The patterns are literals of this crate, covered by its tests.
            Regex::with_flags(self.source, self.flags)
                .unwrap_or_else(|error| panic!("invalid pattern {}: {error}", self.source))
        })
    }

    pub(crate) fn is_match(&self, text: &str) -> bool {
        self.regex().find(text).is_some()
    }

    /// The groups of the first match: index 0 is the whole match.
    pub(crate) fn captures<'t>(&self, text: &'t str) -> Option<Vec<Option<&'t str>>> {
        let found = self.regex().find(text)?;
        Some(
            (0..=found.captures.len())
                .map(|index| found.group(index).map(|range| &text[range]))
                .collect(),
        )
    }

    /// The groups of every non-overlapping match, like `matchAll`.
    pub(crate) fn captures_iter<'t>(&self, text: &'t str) -> Vec<Vec<Option<&'t str>>> {
        self.regex()
            .find_iter(text)
            .map(|found| {
                (0..=found.captures.len())
                    .map(|index| found.group(index).map(|range| &text[range]))
                    .collect()
            })
            .collect()
    }
}

/// Recently compiled user patterns: a formula column evaluates the same
/// pattern once per row.
fn compile_user_pattern(pattern: &str) -> Option<Arc<Regex>> {
    const CAPACITY: usize = 16;
    static CACHE: Mutex<Vec<(String, Option<Arc<Regex>>)>> = Mutex::new(Vec::new());
    let mut cache = CACHE
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some(position) = cache.iter().position(|(source, _)| source == pattern) {
        let entry = cache.remove(position);
        let compiled = entry.1.clone();
        cache.push(entry);
        return compiled;
    }
    let compiled = compile_legacy_pattern(pattern).map(Arc::new);
    if cache.len() == CAPACITY {
        cache.remove(0);
    }
    cache.push((pattern.to_owned(), compiled.clone()));
    compiled
}

/// `new RegExp(pattern)`: a pattern without the `u` flag, which JavaScript
/// reads as UTF-16 code units.
///
/// Three adjustments make `regress` agree with V8 there: the pattern is given
/// as code units (so `😀` and `\uD83D\uDE00` match the two units of an emoji),
/// `\u{…}` is the letter `u` and a quantifier rather than a code point escape,
/// and a quantified `\b` or `\B` is a syntax error.
fn compile_legacy_pattern(pattern: &str) -> Option<Regex> {
    let units: Vec<u16> = pattern.encode_utf16().collect();
    let mut rewritten: Vec<u32> = Vec::with_capacity(units.len());
    let mut in_class = false;
    let mut index = 0;
    while index < units.len() {
        let unit = units[index];
        if unit == u16::from(b'\\') && index + 1 < units.len() {
            let escaped = units[index + 1];
            if escaped == u16::from(b'u') && units.get(index + 2) == Some(&u16::from(b'{')) {
                // `\u` without four hex digits is an identity escape: `u`.
                rewritten.push(u32::from(b'u'));
                index += 2;
                continue;
            }
            if let Some(surrogate) = surrogate_escape(&units[index + 1..]) {
                // Each `\uD8xx` escape is one code unit; `regress` would pair them.
                rewritten.push(u32::from(surrogate));
                index += 6;
                continue;
            }
            if !in_class
                && (escaped == u16::from(b'b') || escaped == u16::from(b'B'))
                && starts_quantifier(&units[index + 2..])
            {
                return None;
            }
            rewritten.extend([u32::from(unit), u32::from(escaped)]);
            index += 2;
            continue;
        }
        if unit == u16::from(b'[') {
            in_class = true;
        } else if unit == u16::from(b']') {
            in_class = false;
        }
        rewritten.push(u32::from(unit));
        index += 1;
    }
    Regex::from_unicode(rewritten.into_iter(), "").ok()
}

/// The unit of a `uXXXX` escape (after the backslash) naming a surrogate.
fn surrogate_escape(units: &[u16]) -> Option<u16> {
    if units.first() != Some(&u16::from(b'u')) {
        return None;
    }
    let digits = String::from_utf16(units.get(1..5)?).ok()?;
    let unit = u16::from_str_radix(&digits, 16)
        .ok()
        .filter(|_| digits.bytes().all(|byte| byte.is_ascii_hexdigit()))?;
    (0xd800..=0xdfff).contains(&unit).then_some(unit)
}

/// Whether a quantifier (`*`, `+`, `?` or `{n}`, `{n,}`, `{n,m}`) starts here.
fn starts_quantifier(units: &[u16]) -> bool {
    let is = |index: usize, byte: u8| units.get(index) == Some(&u16::from(byte));
    if is(0, b'*') || is(0, b'+') || is(0, b'?') {
        return true;
    }
    if !is(0, b'{') {
        return false;
    }
    let digits = |from: usize| {
        units[from.min(units.len())..]
            .iter()
            .take_while(|unit| (u16::from(b'0')..=u16::from(b'9')).contains(unit))
            .count()
    };
    let first = digits(1);
    if first == 0 {
        return false;
    }
    let mut index = 1 + first;
    if is(index, b',') {
        index += 1 + digits(index + 1);
    }
    is(index, b'}')
}

/// `text.replace(new RegExp(pattern, "g"), replacement)`, or `None` when the
/// pattern does not compile (`new RegExp` throws).
///
/// Matching runs on UTF-16 code units, as JavaScript does for patterns without
/// the `u` flag.
pub(crate) fn replace_all(text: &str, pattern: &str, replacement: &str) -> Option<String> {
    let regex = compile_user_pattern(pattern)?;
    let units: Vec<u16> = text.encode_utf16().collect();
    let replacement: Vec<u16> = replacement.encode_utf16().collect();
    let mut out = Vec::with_capacity(units.len());
    let mut end_of_last_match = 0;
    for found in regex.find_from_ucs2(&units, 0) {
        let matched: Range<usize> = found.range();
        out.extend_from_slice(&units[end_of_last_match..matched.start]);
        let has_names = found.named_groups().len() > 0;
        let named = |name: &[u16]| found.named_group(&String::from_utf16_lossy(name));
        js::expand_replacement(
            &mut out,
            &replacement,
            &units,
            matched.clone(),
            &found.captures,
            has_names.then_some(&named as js::NamedGroups<'_>),
        );
        end_of_last_match = matched.end;
    }
    out.extend_from_slice(&units[end_of_last_match.min(units.len())..]);
    Some(String::from_utf16_lossy(&out))
}

/// `new RegExp(pattern).test(text)`, or `None` when the pattern does not compile.
pub(crate) fn test(text: &str, pattern: &str) -> Option<bool> {
    let regex = compile_user_pattern(pattern)?;
    let units: Vec<u16> = text.encode_utf16().collect();
    Some(regex.find_from_ucs2(&units, 0).next().is_some())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replaces_with_javascript_patterns() {
        assert_eq!(replace_all("abc", "a", "1").unwrap(), "1bc");
        assert_eq!(
            replace_all("John Smith", "(\\w+)\\s(\\w+)", "$2, $1").unwrap(),
            "Smith, John"
        );
        assert_eq!(replace_all("aaa", "a*", "-").unwrap(), "--");
        assert_eq!(replace_all("abc", "", "-").unwrap(), "-a-b-c-");
        assert_eq!(
            replace_all("2020-01", "(?<y>\\d+)-(?<m>\\d+)", "$<m>/$<y>").unwrap(),
            "01/2020"
        );
        assert_eq!(
            replace_all("ab", "(a)", "[$1$2$&$`$'$$]").unwrap(),
            "[a$2ab$]b"
        );
        assert!(replace_all("abc", "(", "x").is_none());
    }

    #[test]
    fn tests_on_code_units() {
        assert_eq!(test("abc", "^a"), Some(true));
        assert_eq!(test("abc", "^b"), Some(false));
        assert_eq!(test("😀", "^.$"), Some(false));
        assert_eq!(test("😀", "^..$"), Some(true));
        assert_eq!(test("x", "["), None);
        assert_eq!(test("😀", "^😀$"), Some(true));
        assert_eq!(test("😀", "^\\uD83D\\uDE00$"), Some(true));
        assert_eq!(test("uuu", "^\\u{3}$"), Some(true));
        assert_eq!(test("ab", "\\B+"), None);
        assert_eq!(test("ab", "\\b{x}"), Some(false));
        assert_eq!(test("ab", "[\\b]+"), Some(false));
    }
}
