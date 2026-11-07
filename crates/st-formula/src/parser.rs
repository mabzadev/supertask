//! Tokenizer and parser.
//!
//! Both follow `formula-engine.ts` closely, error messages included, because the
//! messages reach users through the API and the quirks are part of the language
//! people already wrote formulas in: commas between arguments are optional,
//! `not` and unary minus bind to a single primary, `blank` is the null literal,
//! and a bare identifier is a field reference.

use std::fmt::Write as _;

use crate::Error;
use crate::js;

const MAX_FORMULA_DIGITS: usize = 50;
const MAX_STRING_LENGTH: usize = 10_000;
/// The TS engine counts the end-of-input token too.
const MAX_TOKENS: usize = 2048;
/// Field references written `{Name}` reach the parser as identifiers with this
/// prefix, exactly as in the TS tokenizer (so a bare `__field__x` is a field too).
const FIELD_PREFIX: &str = "__field__";

/// A parsed formula.
#[derive(Clone, Debug, PartialEq)]
pub enum Expr {
    /// A literal, with the text it was written as (`raw` drives the number of
    /// decimal places inferred for number formulas: `2.50` has two).
    Literal {
        value: Literal,
        raw: String,
    },
    /// `{Name}` or a bare identifier.
    Field(String),
    Unary {
        op: UnaryOp,
        operand: Box<Expr>,
    },
    Binary {
        op: BinaryOp,
        left: Box<Expr>,
        right: Box<Expr>,
    },
    /// A function call; `name` is upper-cased.
    Call {
        name: String,
        args: Vec<Expr>,
    },
}

#[derive(Clone, Debug, PartialEq)]
pub enum Literal {
    Null,
    Bool(bool),
    Number(f64),
    Text(String),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UnaryOp {
    Not,
    Neg,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BinaryOp {
    Or,
    And,
    Eq,
    NotEq,
    Lt,
    LtEq,
    Gt,
    GtEq,
    Add,
    Sub,
    Mul,
    Div,
    Mod,
}

impl BinaryOp {
    /// The operator as the TS AST spells it (`"AND"`, `"!="`, `"+"`...).
    pub fn as_str(self) -> &'static str {
        match self {
            BinaryOp::Or => "OR",
            BinaryOp::And => "AND",
            BinaryOp::Eq => "=",
            BinaryOp::NotEq => "!=",
            BinaryOp::Lt => "<",
            BinaryOp::LtEq => "<=",
            BinaryOp::Gt => ">",
            BinaryOp::GtEq => ">=",
            BinaryOp::Add => "+",
            BinaryOp::Sub => "-",
            BinaryOp::Mul => "*",
            BinaryOp::Div => "/",
            BinaryOp::Mod => "%",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Kind {
    Number,
    String,
    Boolean,
    Null,
    Ident,
    LParen,
    RParen,
    Comma,
    Plus,
    Minus,
    Star,
    Slash,
    Mod,
    Eq,
    Neq,
    Lt,
    Lte,
    Gt,
    Gte,
    And,
    Or,
    Not,
    RBrace,
    Eof,
}

impl Kind {
    /// The token type name used in error messages.
    fn name(self) -> &'static str {
        match self {
            Kind::Number => "NUMBER",
            Kind::String => "STRING",
            Kind::Boolean => "BOOLEAN",
            Kind::Null => "NULL",
            Kind::Ident => "IDENT",
            Kind::LParen => "LPAREN",
            Kind::RParen => "RPAREN",
            Kind::Comma => "COMMA",
            Kind::Plus => "PLUS",
            Kind::Minus => "MINUS",
            Kind::Star => "STAR",
            Kind::Slash => "SLASH",
            Kind::Mod => "MOD",
            Kind::Eq => "EQ",
            Kind::Neq => "NEQ",
            Kind::Lt => "LT",
            Kind::Lte => "LTE",
            Kind::Gt => "GT",
            Kind::Gte => "GTE",
            Kind::And => "AND",
            Kind::Or => "OR",
            Kind::Not => "NOT",
            Kind::RBrace => "RBRACE",
            Kind::Eof => "EOF",
        }
    }
}

#[derive(Clone, Debug)]
struct Token {
    kind: Kind,
    /// The literal value, identifier name or string contents.
    value: TokenValue,
    raw: String,
}

#[derive(Clone, Debug)]
enum TokenValue {
    None,
    Number(f64),
    Text(String),
    Bool(bool),
}

/// `formulaNumber`: more than 50 digits, or anything `Number()` cannot read
/// as a finite number, is `NaN`.
pub(crate) fn formula_number(text: &str) -> f64 {
    let text = js::trim(text);
    if text.bytes().filter(u8::is_ascii_digit).count() > MAX_FORMULA_DIGITS {
        return f64::NAN;
    }
    let parsed = js::string_to_number(text);
    if parsed.is_finite() { parsed } else { f64::NAN }
}

fn tokenize(input: &str) -> Result<Vec<Token>, Error> {
    let chars: Vec<char> = input.chars().collect();
    let mut tokens = Vec::new();
    let mut i = 0;
    let at = |index: usize| chars.get(index).copied();
    let simple = |kind: Kind, raw: &str| Token {
        kind,
        value: TokenValue::None,
        raw: raw.to_owned(),
    };

    while i < chars.len() {
        let c = chars[i];
        if js::is_whitespace(c) {
            i += 1;
            continue;
        }

        if c.is_ascii_digit() || (c == '.' && at(i + 1).is_some_and(|next| next.is_ascii_digit())) {
            let mut number = String::new();
            let mut seen_decimal_point = false;
            while let Some(c) = at(i) {
                if c.is_ascii_digit() || (c == '.' && !seen_decimal_point) {
                    seen_decimal_point |= c == '.';
                    number.push(c);
                    i += 1;
                } else {
                    break;
                }
            }
            tokens.push(Token {
                kind: Kind::Number,
                value: TokenValue::Number(formula_number(&number)),
                raw: number,
            });
            continue;
        }

        if c == '"' || c == '\'' {
            let quote = c;
            i += 1;
            let mut text = String::new();
            while i < chars.len() && chars[i] != quote {
                if chars[i] == '\\' {
                    i += 1;
                    if i >= chars.len() {
                        return Err(Error::Syntax("Unterminated string literal.".to_owned()));
                    }
                }
                text.push(chars[i]);
                i += 1;
            }
            if i >= chars.len() {
                return Err(Error::Syntax("Unterminated string literal.".to_owned()));
            }
            i += 1;
            if js::utf16_len(&text) > MAX_STRING_LENGTH {
                return Err(Error::Syntax(format!(
                    "String literals cannot exceed {MAX_STRING_LENGTH} characters."
                )));
            }
            let raw = format!("\"{text}\"");
            tokens.push(Token {
                kind: Kind::String,
                value: TokenValue::Text(text),
                raw,
            });
            continue;
        }

        if c == '{' {
            i += 1;
            let mut field = String::new();
            while i < chars.len() && chars[i] != '}' {
                field.push(chars[i]);
                i += 1;
            }
            if i >= chars.len() {
                return Err(Error::Syntax("Unterminated field reference.".to_owned()));
            }
            i += 1;
            let raw = format!("{{{field}}}");
            tokens.push(Token {
                kind: Kind::Ident,
                value: TokenValue::Text(format!("{FIELD_PREFIX}{field}")),
                raw,
            });
            continue;
        }

        if c.is_ascii_alphabetic() || c == '_' {
            let mut ident = String::new();
            while let Some(c) = at(i).filter(|c| c.is_ascii_alphanumeric() || *c == '_') {
                ident.push(c);
                i += 1;
            }
            let token = match ident.to_ascii_uppercase().as_str() {
                "TRUE" => Token {
                    kind: Kind::Boolean,
                    value: TokenValue::Bool(true),
                    raw: ident,
                },
                "FALSE" => Token {
                    kind: Kind::Boolean,
                    value: TokenValue::Bool(false),
                    raw: ident,
                },
                "NULL" | "BLANK" => Token {
                    kind: Kind::Null,
                    value: TokenValue::None,
                    raw: ident,
                },
                "AND" => Token {
                    kind: Kind::And,
                    value: TokenValue::Text("AND".to_owned()),
                    raw: ident,
                },
                "OR" => Token {
                    kind: Kind::Or,
                    value: TokenValue::Text("OR".to_owned()),
                    raw: ident,
                },
                "NOT" => Token {
                    kind: Kind::Not,
                    value: TokenValue::Text("NOT".to_owned()),
                    raw: ident,
                },
                _ => Token {
                    kind: Kind::Ident,
                    value: TokenValue::Text(ident.clone()),
                    raw: ident,
                },
            };
            tokens.push(token);
            continue;
        }

        let next = at(i + 1);
        let two_char = match (c, next) {
            ('<', Some('=')) => Some((Kind::Lte, "<=")),
            ('>', Some('=')) => Some((Kind::Gte, ">=")),
            ('!', Some('=')) => Some((Kind::Neq, "!=")),
            ('<', Some('>')) => Some((Kind::Neq, "<>")),
            ('&', Some('&')) => Some((Kind::And, "&&")),
            ('|', Some('|')) => Some((Kind::Or, "||")),
            _ => None,
        };
        if let Some((kind, raw)) = two_char {
            tokens.push(simple(kind, raw));
            i += 2;
            continue;
        }
        let one_char = match c {
            '<' => Kind::Lt,
            '>' => Kind::Gt,
            '=' => Kind::Eq,
            '+' => Kind::Plus,
            '-' => Kind::Minus,
            '*' => Kind::Star,
            '/' => Kind::Slash,
            '%' => Kind::Mod,
            '(' => Kind::LParen,
            ')' => Kind::RParen,
            ',' => Kind::Comma,
            '}' => Kind::RBrace,
            _ => {
                // The TS message shows one UTF-16 unit: half of a character
                // outside the BMP, which reaches users as U+FFFD.
                let shown = if c.len_utf16() == 1 {
                    c
                } else {
                    char::REPLACEMENT_CHARACTER
                };
                return Err(Error::Syntax(format!("Unexpected character: \"{shown}\"")));
            }
        };
        tokens.push(simple(one_char, &c.to_string()));
        i += 1;
    }

    tokens.push(simple(Kind::Eof, ""));
    Ok(tokens)
}

/// Parses a formula into its syntax tree.
///
/// Field references are not resolved here: unknown fields evaluate to null,
/// and [`crate::validate_formula_type`] reports them.
pub fn parse(formula: &str) -> Result<Expr, Error> {
    let tokens = tokenize(formula)?;
    if tokens.len() > MAX_TOKENS {
        return Err(Error::Syntax(
            "The formula exceeded the maximum formula size.".to_owned(),
        ));
    }
    Parser {
        tokens,
        position: 0,
    }
    .parse()
}

/// The TS parser's precedence levels (`parseOr` down to `parseMulDiv`), all
/// left-associative.
fn binary_operator(kind: Kind) -> Option<(BinaryOp, u8)> {
    Some(match kind {
        Kind::Or => (BinaryOp::Or, 0),
        Kind::And => (BinaryOp::And, 1),
        Kind::Eq => (BinaryOp::Eq, 2),
        Kind::Neq => (BinaryOp::NotEq, 2),
        Kind::Lt => (BinaryOp::Lt, 2),
        Kind::Lte => (BinaryOp::LtEq, 2),
        Kind::Gt => (BinaryOp::Gt, 2),
        Kind::Gte => (BinaryOp::GtEq, 2),
        Kind::Plus => (BinaryOp::Add, 3),
        Kind::Minus => (BinaryOp::Sub, 3),
        Kind::Star => (BinaryOp::Mul, 4),
        Kind::Slash => (BinaryOp::Div, 4),
        Kind::Mod => (BinaryOp::Mod, 4),
        _ => return None,
    })
}

/// An expression being read: operands and operators waiting for precedence
/// to settle (shunting-yard), and a `not` or `-` waiting for its operand.
#[derive(Default)]
struct Pending {
    operands: Vec<Expr>,
    operators: Vec<(BinaryOp, u8)>,
    unary: Option<UnaryOp>,
}

impl Pending {
    /// Combines the operators of `min_level` and above, left to right.
    fn reduce(&mut self, min_level: u8) {
        while let Some(&(op, level)) = self.operators.last() {
            if level < min_level {
                break;
            }
            self.operators.pop();
            let (Some(right), Some(left)) = (self.operands.pop(), self.operands.pop()) else {
                return;
            };
            self.operands.push(Expr::Binary {
                op,
                left: Box::new(left),
                right: Box::new(right),
            });
        }
    }

    fn finish(mut self) -> Expr {
        self.reduce(0);
        self.operands.pop().unwrap_or(Expr::Literal {
            value: Literal::Null,
            raw: String::new(),
        })
    }
}

/// Where the expression being read sits.
enum Context {
    Top,
    /// Inside `( … )`.
    Paren,
    /// Inside the arguments of a call.
    Call {
        name: String,
        args: Vec<Expr>,
    },
}

struct Parser {
    tokens: Vec<Token>,
    position: usize,
}

impl Parser {
    fn peek(&self) -> &Token {
        &self.tokens[self.position.min(self.tokens.len() - 1)]
    }

    fn peek_kind_at(&self, offset: usize) -> Option<Kind> {
        self.tokens
            .get(self.position + offset)
            .map(|token| token.kind)
    }

    /// Takes the current token out (the parser never looks back).
    fn consume(&mut self) -> Token {
        let index = self.position.min(self.tokens.len() - 1);
        self.position += 1;
        if self.tokens[index].kind == Kind::Eof {
            return self.tokens[index].clone();
        }
        std::mem::replace(
            &mut self.tokens[index],
            Token {
                kind: Kind::Eof,
                value: TokenValue::None,
                raw: String::new(),
            },
        )
    }

    fn expect(&mut self, kind: Kind) -> Result<(), Error> {
        let token = self.consume();
        if token.kind != kind {
            return Err(expected(kind, &token));
        }
        Ok(())
    }

    /// The TS recursive descent (`parseOr` … `parsePrimary`), run with explicit
    /// stacks. Parentheses create no node, so a recursive parser is the only
    /// code that would recurse 1023 levels deep on `((((…))))`; this one does
    /// not recurse at all. Trees and error messages are the same.
    fn parse(&mut self) -> Result<Expr, Error> {
        let mut stack: Vec<(Context, Pending)> = Vec::new();
        let mut context = Context::Top;
        let mut pending = Pending::default();
        'operand: loop {
            // `parseUnary`: `not` and unary minus apply to one primary.
            pending.unary = match self.peek().kind {
                Kind::Not => Some(UnaryOp::Not),
                Kind::Minus => Some(UnaryOp::Neg),
                _ => None,
            };
            if pending.unary.is_some() {
                self.position += 1;
            }
            // `parsePrimary`, up to the point where an inner expression starts.
            let kind = self.peek().kind;
            let next_is_paren = self.peek_kind_at(1) == Some(Kind::LParen);
            let mut operand = match kind {
                Kind::Number | Kind::String | Kind::Boolean | Kind::Null => self.literal(),
                Kind::Ident | Kind::And | Kind::Or if kind == Kind::Ident || next_is_paren => {
                    let name = self.identifier()?;
                    if let Some(field) = name.strip_prefix(FIELD_PREFIX) {
                        Expr::Field(field.to_owned())
                    } else if !next_is_paren {
                        Expr::Field(name)
                    } else {
                        self.expect(Kind::LParen)?;
                        let name = name.to_ascii_uppercase();
                        if matches!(self.peek().kind, Kind::RParen | Kind::Eof) {
                            self.expect(Kind::RParen)?;
                            Expr::Call {
                                name,
                                args: Vec::new(),
                            }
                        } else {
                            stack.push((
                                std::mem::replace(
                                    &mut context,
                                    Context::Call {
                                        name,
                                        args: Vec::new(),
                                    },
                                ),
                                pending,
                            ));
                            pending = Pending::default();
                            continue 'operand;
                        }
                    }
                }
                Kind::LParen => {
                    self.position += 1;
                    stack.push((std::mem::replace(&mut context, Context::Paren), pending));
                    pending = Pending::default();
                    continue 'operand;
                }
                _ => return Err(unexpected(self.peek())),
            };
            loop {
                if let Some(op) = pending.unary.take() {
                    operand = Expr::Unary {
                        op,
                        operand: Box::new(operand),
                    };
                }
                pending.operands.push(operand);
                if let Some((op, level)) = binary_operator(self.peek().kind) {
                    self.position += 1;
                    pending.reduce(level);
                    pending.operators.push((op, level));
                    continue 'operand;
                }
                // No operator follows: the current expression is complete.
                let expr = std::mem::take(&mut pending).finish();
                match context {
                    Context::Top => {
                        let token = self.peek();
                        if token.kind != Kind::Eof {
                            return Err(Error::Syntax(format!(
                                "Unexpected token: \"{}\"",
                                token.raw
                            )));
                        }
                        return Ok(expr);
                    }
                    Context::Paren => {
                        self.expect(Kind::RParen)?;
                        operand = expr;
                    }
                    Context::Call { name, mut args } => {
                        args.push(expr);
                        if self.peek().kind == Kind::Comma {
                            self.position += 1;
                        }
                        if !matches!(self.peek().kind, Kind::RParen | Kind::Eof) {
                            // Commas are optional: whatever follows is the next argument.
                            context = Context::Call { name, args };
                            continue 'operand;
                        }
                        self.expect(Kind::RParen)?;
                        operand = Expr::Call { name, args };
                    }
                }
                // The inner expression is an operand of the enclosing one.
                let Some((outer_context, outer_pending)) = stack.pop() else {
                    return Ok(operand);
                };
                context = outer_context;
                pending = outer_pending;
            }
        }
    }

    #[inline(never)]
    fn literal(&mut self) -> Expr {
        let token = self.consume();
        let value = match token.value {
            TokenValue::Number(number) => Literal::Number(number),
            TokenValue::Text(text) => Literal::Text(text),
            TokenValue::Bool(value) => Literal::Bool(value),
            TokenValue::None => Literal::Null,
        };
        Expr::Literal {
            value,
            raw: token.raw,
        }
    }

    #[inline(never)]
    fn identifier(&mut self) -> Result<String, Error> {
        let token = self.consume();
        match token.value {
            TokenValue::Text(name) => Ok(name),
            _ => Err(unexpected(&token)),
        }
    }
}

#[cold]
#[inline(never)]
fn expected(kind: Kind, token: &Token) -> Error {
    Error::Syntax(format!(
        "Expected {}, got {} (\"{}\")",
        kind.name(),
        token.kind.name(),
        token.raw
    ))
}

#[cold]
#[inline(never)]
fn unexpected(token: &Token) -> Error {
    let mut message = String::new();
    let _ = write!(
        message,
        "Unexpected token: \"{}\" ({})",
        token.raw,
        token.kind.name()
    );
    Error::Syntax(message)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn error(formula: &str) -> String {
        parse(formula).unwrap_err().to_string()
    }

    #[test]
    fn reports_tokenizer_errors_like_the_ts_engine() {
        assert_eq!(error("1 @ 1"), "Unexpected character: \"@\"");
        assert_eq!(error("'unterminated"), "Unterminated string literal.");
        assert_eq!(error("{unterminated"), "Unterminated field reference.");
        assert_eq!(error("1 1"), "Unexpected token: \"1\"");
        assert_eq!(error("concat('a'"), "Expected RPAREN, got EOF (\"\")");
        assert_eq!(error("--1"), "Unexpected token: \"-\" (MINUS)");
        assert_eq!(
            error("not(true, false)"),
            "Expected RPAREN, got COMMA (\",\")"
        );
        assert_eq!(error("blank()"), "Unexpected token: \"(\"");
    }

    #[test]
    fn parses_operators_with_the_ts_precedence() {
        let expr = parse("-2 * 3 + 1 > 0 && not true || false").unwrap();
        let Expr::Binary {
            op: BinaryOp::Or,
            left,
            ..
        } = expr
        else {
            panic!("or at the root")
        };
        let Expr::Binary {
            op: BinaryOp::And,
            left: comparison,
            right: not,
        } = *left
        else {
            panic!("and")
        };
        assert!(matches!(
            *not,
            Expr::Unary {
                op: UnaryOp::Not,
                ..
            }
        ));
        assert!(matches!(
            *comparison,
            Expr::Binary {
                op: BinaryOp::Gt,
                ..
            }
        ));
    }

    #[test]
    fn arguments_need_no_commas_and_names_are_upper_cased() {
        let expr = parse("concat('a' 'b',)").unwrap();
        let Expr::Call { name, args } = expr else {
            panic!("call")
        };
        assert_eq!(name, "CONCAT");
        assert_eq!(args.len(), 2);
        assert_eq!(
            parse("{My field}").unwrap(),
            Expr::Field("My field".to_owned())
        );
        assert_eq!(parse("__field__x").unwrap(), Expr::Field("x".to_owned()));
        assert!(matches!(parse("and(true)").unwrap(), Expr::Call { name, .. } if name == "AND"));
    }

    #[test]
    fn enforces_the_size_limits() {
        assert!(parse(&format!("'{}'", "x".repeat(10_000))).is_ok());
        assert!(error(&format!("'{}'", "x".repeat(10_001))).contains("10000"));
        // 1024 numbers, 1023 operators and the end token make 2048 tokens: the
        // largest formula allowed.
        assert!(parse(&["1"; 1024].join("+")).is_ok());
        assert_eq!(
            error(&["1"; 1025].join("+")),
            "The formula exceeded the maximum formula size."
        );
    }

    #[test]
    fn parses_the_deepest_nesting_without_recursion() {
        let nested = format!("{}1{}", "(".repeat(1023), ")".repeat(1023));
        assert!(parse(&nested).is_ok());
        let calls = format!("{}'a'{}", "upper(".repeat(682), ")".repeat(682));
        assert!(parse(&calls).is_ok());
    }

    #[test]
    fn unary_operators_wrap_whole_primaries() {
        let Expr::Binary {
            op: BinaryOp::Eq,
            left,
            ..
        } = parse("not(true) = false").unwrap()
        else {
            panic!("eq")
        };
        assert!(matches!(
            *left,
            Expr::Unary {
                op: UnaryOp::Not,
                ..
            }
        ));
        let Expr::Unary {
            op: UnaryOp::Neg,
            operand,
        } = parse("-abs(1)").unwrap()
        else {
            panic!("neg")
        };
        assert!(matches!(*operand, Expr::Call { .. }));
        assert_eq!(error("-"), "Unexpected token: \"\" (EOF)");
        assert_eq!(error("("), "Unexpected token: \"\" (EOF)");
        assert_eq!(error("(1, 2)"), "Expected RPAREN, got COMMA (\",\")");
        assert_eq!(error("concat('a',"), "Expected RPAREN, got EOF (\"\")");
        assert_eq!(error("f(})"), "Unexpected token: \"}\" (RBRACE)");
    }
}
