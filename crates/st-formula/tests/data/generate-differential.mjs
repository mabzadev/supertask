// Generates the differential corpus of crates/st-formula/tests/differential.rs:
// formulas evaluated and typed by the TS engine, for the Rust port to match.
//
//   npx esbuild crates/st-formula/tests/data/engine.ts --bundle --format=esm \
//     --platform=node --outfile=/tmp/st-formula-engine.mjs
//   TZ=UTC node crates/st-formula/tests/data/generate-differential.mjs \
//     /tmp/st-formula-engine.mjs crates/st-formula/tests/data/differential.json --sample
//
// Without --sample it writes the full corpus (about 100k formulas, 75 MB), for
// ST_FORMULA_CORPUS. Formulas reading the clock or randomness are left out.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [enginePath, out, mode] = process.argv.slice(2);
const sample = mode === "--sample";
const {
  evaluateFormula, validateFormulaType, inferFormulaType, inferFormulaNumberDecimalPlaces,
  extractFormulaFieldReferences, extractLookupReferences, evaluateCommonRuntimeFormulaCall,
} = await import(pathToFileURL(path.resolve(enginePath)).href);

let seed = 12345;
const random = () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const pick = (items) => items[Math.floor(random() * items.length)];

const NONDETERMINISTIC = new Set(["NOW", "TODAY", "RANDOM_INT", "RANDOM_FLOAT", "RANDOM_BOOL", "GENERATE_UUID"]);
// Every function the TS evaluator handles, read from its source.
const engineSource = fs.readFileSync(new URL("../../../../src/services/formula-engine.ts", import.meta.url), "utf8");
const functions = [...new Set([...engineSource.matchAll(/case "([A-Z_0-9]+)"/g)].map((match) => match[1]))].sort()
  .filter((name) => !NONDETERMINISTIC.has(name)).concat(["ERROR_TO_NAN", "ERROR_TO_NULL", "DOES_NOT_EXIST"]);
/** How many of each kind of case to draw: everything, or a sample small enough to commit. */
const take = (full, sampled) => (sample ? sampled : full);
const sampleOf = (items, count) => (sample ? Array.from({ length: Math.min(count, items.length) }, () => pick(items)) : items);

const context = {
  Num: 5, Neg: -2.5, Zero: 0, Big: 1e21, Small: 1e-7, Text: "Hello World", Upper: "ÉCOLE ß", Emoji: "a😀b",
  Arr: [3, null, 1, "x"], Names: ["Alice", "Bob", "Carol"], Checks: [true, false, true], Empty: "", Null: null, Bool: true,
  Obj: { b: 1, a: [1, 2], "2": "two", "1": "one" }, Date: "2021-03-04", DateTime: "2021-03-04T05:06:07.000Z",
  Legacy: "2021-03-04 05:06", NumStr: "n:12.50", Spaces: "  padded  ", Json: "[1, 2, 3]", JsonObj: '{"value": "Done", "id": 2}',
  Files: [{ visible_name: "a.pdf", size: 10, mime_type: "application/pdf", is_image: false }, { name: "b.png", size: "20", mime_type: "image/png", image_width: 4, image_height: "3" }],
  Tags: [{ id: 1, value: "Urgent", color: "red" }, { id: 2, value: "Later", color: "blue" }],
  TagLookups: [[{ id: 1, value: "Urgent", color: "red" }], [{ id: 3, value: "Other", color: "green" }]],
  Links: [{ url: "https://a.example", label: "A" }, { url: "https://b.example", label: null }],
  Nested: [[1, 2], [3]], People: [{ id: 21, first_name: "Ada" }, { id: 22, email: "g@example.com" }],
  Aggregates: [{ id: 5, value: [1, 2] }, { id: "7", value: "[3]" }],
  Dur: "1:30:00", Interval: "2 mons 3 days 04:05:06", Probe: "abcAZ x]{}a{1 😀 é0 uu",
  __row_id: 7, "lookup:Customer:Score": [1, 2, 3], "lookup:customer:name": ["X", "Y"],
  "data.rows": "exact", data: { rows: [{ name: "Ada" }, { name: "Grace" }] }, field_8: 42,
};

const literals = [
  "null", "true", "false", "0", "1", "-1", "2", "2.5", "-2.5", "0.1", "1e3", "100", "9999", "1/0", "-0",
  "'a'", "''", "' '", "'abc'", "'ABC def'", "'Hello'", "'1'", "'10'", "'-5'", "'1.5'", "'n:5'", "'false'", "'true'", "'0x1F'",
  "'2020-01-15'", "'2020-01-15T10:30:00Z'", "'2020-02-29'", "'2020-01-15 10:30'", "'Jan 5 2020'", "'1'", "'13'",
  "'1 day'", "'2 months'", "'3 years'", "'1 week'", "'1:30'", "'90'", "'[1,2,3]'", "'{\"a\":1}'", "'[\"x\",\"y\"]'",
  "'YYYY-MM-DD'", "'YYYYMMDD'", "'DD/MM/YYYY HH24:MI'", "'day'", "'HH:MI:SS'", "'Europe/Paris'", "'UTC'", "'America/New_York'", "'+05:30'",
  "'yy'", "'month'", "'d'", "'mi'", "', '", "','", "'\\\\d+'", "'(a)(b)?'", "'$1-$&'", "'.'", "'https://example.com/a b?q=1#x'",
];
const fieldRefs = Object.keys(context).filter((key) => !key.includes(":") && !key.includes(".")).map((key) => `field('${key}')`)
  .concat(["{Num}", "{Text}", "{Missing}", "Num", "field_by_id(8)", "get('data.rows.0.name')", "get('data.rows')", "get('Obj.a.1')", "lookup('Customer', 'Score')", "lookup('customer', 'NAME')", "row_id()"]);
const composites = [
  "date_interval('1 day')", "date_interval('2 months')", "date_interval('1 year')", "date_interval('90')", "toduration(3600)",
  "todate('20200131', 'YYYYMMDD')", "todate('2020-02-29', 'YYYY-MM-DD')", "todate_tz('20200101 1200', 'YYYYMMDD HH24MI', 'Europe/Rome')",
  "link('https://x.example', 'X')", "button('https://y.example', 'Y')", "link('https://z.example')",
  "split('a,b,c', ',')", "to_array('a, b')", "filter(field('Names'), field('Checks'))", "array_agg(field('Names'))",
  "field('Names') = 'Bob'", "field('Arr') + 1", "error_to_null(1)", "concat('x', 1)",
];
const pool = literals.concat(fieldRefs, composites);
const operators = ["+", "-", "*", "/", "%", "=", "!=", "<>", "<", "<=", ">", ">=", "&&", "||", "and", "or"];

const cases = [];
const seen = new Set();
function addCase(formula) {
  if (seen.has(formula)) return;
  seen.add(formula);
  cases.push(formula);
}
// Every function with 0 to 3 arguments: all single arguments, sampled pairs and triples.
for (const name of functions) {
  addCase(`${name.toLowerCase()}()`);
  for (const arg of sampleOf(pool, 8)) addCase(`${name.toLowerCase()}(${arg})`);
  for (let i = 0; i < take(120, 4); i++) addCase(`${name.toLowerCase()}(${pick(pool)}, ${pick(pool)})`);
  for (let i = 0; i < take(80, 2); i++) addCase(`${name.toLowerCase()}(${pick(pool)}, ${pick(pool)}, ${pick(pool)})`);
}
// Every operator with every pair from a smaller pool, plus unary operators.
const operands = literals.slice(0, 40).concat(fieldRefs.slice(0, 30), composites.slice(0, 12));
for (const op of operators) for (const left of operands) for (const right of operands) {
  if (random() < take(0.35, 0.012)) addCase(`${left} ${op} ${right}`);
}
for (const operand of sampleOf(pool, 30)) { addCase(`-${operand}`); addCase(`not ${operand}`); addCase(`-(${operand})`); addCase(`not(${operand})`); }
// Nested calls.
for (let i = 0; i < take(6000, 300); i++) {
  const inner = `${pick(functions).toLowerCase()}(${pick(pool)}, ${pick(pool)})`;
  addCase(`${pick(functions).toLowerCase()}(${inner}${random() < 0.5 ? ", " + pick(pool) : ""})`);
}
// Date strings through the date functions and comparisons.
const dateTexts = ["2020", "2020-1-1", "2020-01-01", "2020-01-01T10:00", "2020-01-01T10:00:00.123Z", "2020-01-01 10:00", "2020/01/02",
  "01/02/2020", "Jan 5", "5 Jan 2020", "January 5, 2020 10:00:00 GMT+0200", "Tue Jan 01 2020", "n:5", "1", "13", "32", "99", "0",
  "10:00", "2020-01-01 10:00 PM", "12/31/1999 23:59:59 UTC+1", "2020-02-30", "2020-13-01", "Mon, 01 Jan 2024 10:00:00 GMT", "1.5", "-5",
  "(c) 2020", "+002020-01-01", "-000001-06-15", "2020-06-15T23:59:59+05:30", "2020-06-15T12:00:00-0800", "2019-12-31T23:59:60Z",
  "20200101", "2020-W01", "1e3", "Infinity", "  2020-03-04  ", "2020-03-04\tx", "275760-09-13", "+275760-09-13T00:00:00Z", "1970-01-01T00:00:00Z"];
for (const text of sampleOf(dateTexts, 25)) {
  const lit = `'${text.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
  for (const fn of ["year", "month", "day", "hour", "minute", "second", "weekday", "totext", "todate"]) addCase(`${fn}(${lit}${fn === "todate" ? ", 'x'" : ""})`);
  addCase(`datetime_format(${lit}, 'YYYY-MM-DD HH24:MI:SS')`);
  addCase(`datetime_format_tz(${lit}, 'YYYY-MM-DD HH:MI YY', 'Asia/Kolkata')`);
  addCase(`datetime_format(${lit}, 'day')`);
  addCase(`${lit} < '2020-06-01'`);
  addCase(`${lit} - '2020-01-01'`);
  addCase(`${lit} + date_interval('1 month')`);
  addCase(`dateadd(${lit}, 1, 'months')`);
  addCase(`date_diff('mm', ${lit}, '2021-01-01')`);
}

// User regular expressions: V8 reads them as UTF-16 code units, with Annex B syntax.
const patterns = ["a{", "a{1", "]", "x]", "\\c", "\\cA", "\\1(a)", "(a)\\2", "[\\d-z]", "\\k", "\\k<a>", "(?<a>x)\\k<a>", "a{2,1}", "\\p{L}", "\\u{61}", "\\x4", "\\8", "\\0", "\\01", "[\\b]", "\\/", "(?=a)*", "a**", "+", "(?:", "[z-a]", "\\-", "\\a", "^*", "$+", "\\B+", "(?<=a)b", "(?<!a)b", "[^]", "[]", ".", "\\s+", "\\w", "[\\u0041-\\u005A]", "\\uD83D\\uDE00", "\ud83d\ude00", "(a|b)*c", "a{,5}", "{", "}", "a}", "x{2}{3}", "[\ud83d\ude00]", "[\\uD83D\\uDE00]", "\\uD83D", "\\uDE00", "[\\uD800-\\uDFFF]", "\ud83d\ude00+", "(?:\ud83d\ude00)+", "\\u0041", "\\u004", "\\u{", "\\\\u{2}", "[\\u{61}]", "\\b*", "\\B{2}", "\\b{2,}", "\\b{,2}", "x\\b?", "[\\B]", "(?=x)+", "\\x41"];
const formulaText = (text) => `'${text.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
for (const pattern of patterns) {
  addCase(`regex_replace(field('Probe'), ${formulaText(pattern)}, '[$&]')`);
  addCase(`regex_match(field('Probe'), ${formulaText(pattern)})`);
}

// Malformed formulas: the error messages reach users.
for (const formula of ["1 @ 1", "'unterminated", "\"unterminated", "{unterminated", "1 1", "concat('a'", "concat(", "--1", "- -1",
  "(1, 2)", "f(,1)", ")", "}", "{a}(1)", "1 +", "a b", "true()", "blank()", "null()", "1..2", ".5.5", "1.2.3", "!1", "1 == 1", "1 & 1",
  "1 | 2", "'a\\", "", "   ", "not", "not not true", "and", "and(true)", "or(false, true)", "AND(1)", "__field__Num", "{__field__x}",
  "(((1)))", "((1)", "(1))", "f(1 2 3)", "upper('a' 'b')", "concat('a',,'b')", "1 <> 2", "1 =< 2", "€", "a😀", "'😀' + 1",
  `'${"x".repeat(10000)}'`, `'${"x".repeat(10001)}'`, Array(1024).fill("1").join("+"), Array(1025).fill("1").join("+"),
  "(".repeat(1023) + "1" + ")".repeat(1023), "upper(".repeat(682) + "'a'" + ")".repeat(682)]) {
  addCase(formula);
}

// Time zones: DST gaps and overlaps, odd offsets, historical and far dates.
const zones = ["Europe/Paris", "America/New_York", "Asia/Kathmandu", "Australia/Lord_Howe", "Pacific/Chatham", "UTC", "utc",
  "+05:30", "-0800", "+01", "Etc/GMT-14", "America/Sao_Paulo", "Africa/Casablanca", "Europe/London", "europe/rome", "CET", "EST",
  "US/Pacific", "Asia/Tokyo", "America/St_Johns", "NONSENSE", "", "Z", "+24:00"];
const localTimes = ["20200329 0230", "20201025 0230", "20200308 0230", "20201101 0130", "19000101 0000", "19500615 1200",
  "20500701 1200", "99991231 2359", "10000101 0000", "20200229 2359", "20240331 0300"];
const instants = ["2020-03-29T00:59:59Z", "2020-03-29T01:00:00Z", "2020-10-25T00:30:00Z", "2020-10-25T01:30:00Z",
  "1900-01-01T00:00:00Z", "1950-06-15T12:00:00Z", "2050-07-01T12:00:00Z", "9999-12-31T23:59:59Z", "0500-01-01T00:00:00Z",
  "-000100-01-01T00:00:00Z", "+020000-01-01T00:00:00Z"];
for (const zone of sampleOf(zones, 12)) {
  for (const local of sampleOf(localTimes, 4)) addCase(`todate_tz('${local}', 'YYYYMMDD HH24MI', '${zone}')`);
  for (const instant of sampleOf(instants, 4)) {
    addCase(`datetime_format_tz('${instant}', 'YYYY-MM-DD HH24:MI:SS YY', '${zone}')`);
    addCase(`datetime_format_tz('${instant}', 'day', '${zone}')`);
  }
}
// Calendar arithmetic around month ends and leap years.
for (const start of sampleOf(["2020-01-31", "2020-02-29", "2019-02-28", "2020-12-31", "2020-01-31T23:30:00Z", "2020-03-31 12:00"], 6)) {
  for (const interval of sampleOf(["1 month", "-1 month", "1 year", "-1 year", "13 months", "1.5 months", "2 weeks", "-3 days", "36 hours", "1 mo", "2 y"], 6)) {
    addCase(`'${start}' + date_interval('${interval}')`);
    addCase(`'${start}' - date_interval('${interval}')`);
  }
  for (const unit of sampleOf(["days", "months", "years", "hours", "minutes", "weeks"], 4)) addCase(`dateadd('${start}', 1.7, '${unit}')`);
}

// Rust strings cannot hold lone surrogates; the port turns them into U+FFFD.
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
const wellFormed = (text) => typeof text === "string" ? text.replace(LONE_SURROGATE, "\ufffd") : text;
function encode(value) {
  if (value === undefined) return { $undefined: true };
  if (typeof value === "string") return wellFormed(value);
  if (typeof value === "number") {
    if (Number.isNaN(value)) return { $number: "NaN" };
    if (!Number.isFinite(value)) return { $number: value > 0 ? "Infinity" : "-Infinity" };
    if (Object.is(value, -0)) return { $number: "-0" };
    return value;
  }
  if (typeof value === "function") return { $function: true };
  if (Array.isArray(value)) return value.map(encode);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encode(item)]));
  return value;
}

const fieldTypes = { num: "number", neg: "number", text: "text", arr: "array", names: "array", checks: "array", date: "date", datetime: "date",
  files: "file", tags: "multiple_select", links: "array", bool: "boolean", missing: undefined, field_8: "number", invalidf: "invalid", dur: "duration" };
const fieldNullables = { num: false, text: true, date: true };
const decimals = { num: 2, neg: 1, field_8: 3 };

/** A type result as `[formula_type, array_formula_type, error, nullable]`. */
const compactType = (typed) => [typed.formula_type, typed.array_formula_type, typed.error, typed.nullable];
const records = [];
for (const formula of cases) {
  const result = evaluateFormula(formula, context);
  const empty = evaluateFormula(formula, {});
  const typed = validateFormulaType(formula, fieldTypes, null, fieldNullables);
  const typedLookup = validateFormulaType(formula, fieldTypes, "number", fieldNullables);
  const inferred = inferFormulaType(formula, empty.value, empty.error, fieldTypes, null);
  let decimalPlaces = null; try { decimalPlaces = inferFormulaNumberDecimalPlaces(formula, decimals); } catch (error) { decimalPlaces = { $error: error.message }; }
  let references = null; try { references = extractFormulaFieldReferences(formula); } catch (error) { references = { $error: error.message }; }
  // Fields equal to their fallback are left out to keep the file small: the
  // empty-row result defaults to the row result, `typed_lookup` to `typed`,
  // reference lists to empty.
  const record = { formula, value: encode(result.value), error: wellFormed(result.error) };
  const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
  if (!same(encode(empty.value), record.value) || wellFormed(empty.error) !== record.error) {
    record.empty_value = encode(empty.value);
    record.empty_error = wellFormed(empty.error);
  }
  record.typed = compactType(typed);
  if (!same(compactType(typedLookup), record.typed)) record.typed_lookup = compactType(typedLookup);
  record.inferred = compactType(inferred);
  record.decimal_places = decimalPlaces;
  if (!Array.isArray(references) || references.length > 0) record.references = references;
  const lookups = extractLookupReferences(formula);
  if (lookups.length > 0) record.lookups = lookups;
  records.push(record);
}

// Runtime helpers of builder and automation formulas.
const runtimeNames = ["concat", "and", "or", "not", "if", "tonumber", "totext", "lower", "upper", "capitalize", "get_property", "add", "minus",
  "multiply", "divide", "round", "is_even", "is_odd", "is_empty", "length", "contains", "replace", "join", "split", "strip", "to_array", "at", "nope"];
const runtimeArgs = [null, true, false, 0, 1, -1, 2.5, 1.005, 2.345, NaN, "", " ", "a", "abc", "A,B", "1", "2", "n", "$&", "[1,2]", '{"a":1}', [], [1, "a", null], ["a", "b"], {}, { a: 1, email: "x" }, "a$1"];
const runtime = [];
for (const name of runtimeNames) {
  runtime.push({ name, args: [] });
  for (const a of sampleOf(runtimeArgs, 6)) runtime.push({ name, args: [a] });
  for (let i = 0; i < take(60, 4); i++) runtime.push({ name, args: [pick(runtimeArgs), pick(runtimeArgs)] });
  for (let i = 0; i < take(30, 2); i++) runtime.push({ name, args: [pick(runtimeArgs), pick(runtimeArgs), pick(runtimeArgs)] });
}
const runtimeRecords = runtime.map(({ name, args }) => {
  let outcome;
  try { const r = evaluateCommonRuntimeFormulaCall(name, args); outcome = { handled: r.handled, value: encode(r.value) }; }
  catch (error) { outcome = { error: error.message }; }
  return { name, args: encode(args), ...outcome };
});

// One record per line, so that regenerating gives readable diffs.
const lines = (items) => items.map((item) => "    " + JSON.stringify(item)).join(",\n");
fs.writeFileSync(out, `{
  "context": ${JSON.stringify(encode(context))},
  "field_types": ${JSON.stringify(fieldTypes)},
  "field_nullables": ${JSON.stringify(fieldNullables)},
  "decimal_places": ${JSON.stringify(decimals)},
  "cases": [
${lines(records)}
  ],
  "runtime": [
${lines(runtimeRecords)}
  ]
}
`);
console.log(`${records.length} formulas, ${runtimeRecords.length} runtime calls -> ${out}`);
