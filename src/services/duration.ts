const H_M = "h:mm";
const H_M_S = "h:mm:ss";
const H_M_S_S = "h:mm:ss.s";
const H_M_S_SS = "h:mm:ss.ss";
const H_M_S_SSS = "h:mm:ss.sss";
const D_H = "d h";
const D_H_M = "d h:mm";
const D_H_M_S = "d h:mm:ss";
const D_H_M_NO_COLONS = "d h mm";
const D_H_M_S_NO_COLONS = "d h mm ss";

type DurationFormat =
  | typeof H_M
  | typeof H_M_S
  | typeof H_M_S_S
  | typeof H_M_S_SS
  | typeof H_M_S_SSS
  | typeof D_H
  | typeof D_H_M
  | typeof D_H_M_S
  | typeof D_H_M_NO_COLONS
  | typeof D_H_M_S_NO_COLONS;

type DurationMatch = {
  regex: RegExp;
  parsers: Partial<Record<DurationFormat | "default", (...groups: string[]) => number>>;
};

function totalSeconds(days?: string | number, hours?: string | number, mins?: string | number, secs?: string | number) {
  return Number(days || 0) * 86400
    + Number(hours || 0) * 3600
    + Number(mins || 0) * 60
    + Number(secs || 0);
}

function roundHalfAwayFromZero(value: number, digits = 0) {
  const factor = 10 ** digits;
  return Math.trunc(value * factor + (value >= 0 ? 0.5 : -0.5)) / factor;
}

function roundForFormat(format: DurationFormat, value: number) {
  switch (format) {
    case H_M:
    case D_H_M:
    case D_H_M_NO_COLONS:
      return roundHalfAwayFromZero(value / 60) * 60;
    case D_H:
      return roundHalfAwayFromZero(value / 3600) * 3600;
    case H_M_S:
    case D_H_M_S:
    case D_H_M_S_NO_COLONS:
      return roundHalfAwayFromZero(value, 0);
    case H_M_S_S:
      return roundHalfAwayFromZero(value, 1);
    case H_M_S_SS:
      return roundHalfAwayFromZero(value, 2);
    case H_M_S_SSS:
      return roundHalfAwayFromZero(value, 3);
  }
}

function durationFormat(value: unknown): DurationFormat {
  const format = String(value || H_M);
  if ([
    H_M,
    H_M_S,
    H_M_S_S,
    H_M_S_SS,
    H_M_S_SSS,
    D_H,
    D_H_M,
    D_H_M_S,
    D_H_M_NO_COLONS,
    D_H_M_S_NO_COLONS,
  ].includes(format)) {
    return format as DurationFormat;
  }
  return H_M;
}

const durationMatchers: DurationMatch[] = [
  {
    regex: /^((\d+)(?:d\s*))?((\d+)(?:h\s*))?((\d+)(?:m\s*|\s+))?((\d+|\d+\.\d+)?(?:s\s*))?$/,
    parsers: { default: (_dayPart, days, _hourPart, hours, _minPart, mins, _secPart, secs) => totalSeconds(days, hours, mins, secs) },
  },
  {
    regex: /^(\d+)(?:d\s*|\s+)(\d+):(\d+):(\d+|\d+\.\d+)$/,
    parsers: { default: (d, h, m, s) => totalSeconds(d, h, m, s) },
  },
  {
    regex: /^(\d+):(\d+):(\d+|\d+\.\d+)$/,
    parsers: { default: (h, m, s) => totalSeconds(0, h, m, s) },
  },
  {
    regex: /^(\d+)(?:d\s*|\s+)(\d+)h$/,
    parsers: { default: (d, h) => totalSeconds(d, h) },
  },
  {
    regex: /^(\d+)h$/,
    parsers: { default: (h) => totalSeconds(0, h) },
  },
  {
    regex: /^(\d+)d$/,
    parsers: { default: (d) => totalSeconds(d) },
  },
  {
    regex: /^(\d+)(?:d\s*|\s+)(\d+):(\d+)$/,
    parsers: {
      [H_M]: (d, h, m) => totalSeconds(d, h, m),
      [D_H]: (d, h, m) => totalSeconds(d, h, m),
      [D_H_M]: (d, h, m) => totalSeconds(d, h, m),
      [D_H_M_NO_COLONS]: (d, h, m) => totalSeconds(d, h, m),
      default: (d, m, s) => totalSeconds(d, 0, m, s),
    },
  },
  {
    regex: /^(\d+)(?:d\s*|\s+)(\d+\.\d+)$/,
    parsers: { default: (d, s) => totalSeconds(d, 0, 0, s) },
  },
  {
    regex: /^(\d+):(\d+)$/,
    parsers: {
      [H_M]: (h, m) => totalSeconds(0, h, m),
      [D_H]: (h, m) => totalSeconds(0, h, m),
      [D_H_M]: (h, m) => totalSeconds(0, h, m),
      default: (m, s) => totalSeconds(0, 0, m, s),
    },
  },
  {
    regex: /^(\d+):(\d+\.\d+)$/,
    parsers: { default: (m, s) => totalSeconds(0, 0, m, s) },
  },
  {
    regex: /^(\d+)(?:d\s*|\s+)(\d+)$/,
    parsers: {
      [H_M]: (d, m) => totalSeconds(d, 0, m),
      [D_H]: (d, h) => totalSeconds(d, h),
      [D_H_M]: (d, m) => totalSeconds(d, 0, m),
      [D_H_M_NO_COLONS]: (d, m) => totalSeconds(d, 0, m),
      default: (d, s) => totalSeconds(d, 0, 0, s),
    },
  },
  {
    regex: /^(\d+)(?:d\s*|\s+)(\d+\.\d+)$/,
    parsers: { default: (d, s) => totalSeconds(d, 0, 0, s) },
  },
  {
    regex: /^(\d+)$/,
    parsers: {
      [H_M]: (m) => totalSeconds(0, 0, m),
      [D_H]: (h) => totalSeconds(0, h),
      [D_H_M]: (m) => totalSeconds(0, 0, m),
      [D_H_M_NO_COLONS]: (m) => totalSeconds(0, 0, m),
      default: (s) => totalSeconds(0, 0, 0, s),
    },
  },
  {
    regex: /^(\d+\.\d+)$/,
    parsers: { default: (s) => totalSeconds(0, 0, 0, s) },
  },
];

function parsePostgresInterval(value: string): number | null {
  const matcher = /(?:(-?\d+)\s+years?\s*)|(?:(-?\d+)\s+mons?\s*)|(?:(-?\d+)\s+days?\s*)|(?:(-?\d{1,2}):(\d{2}):(\d{2}))/g;
  let days = 0;
  let seconds = 0;
  let valid = false;
  for (const match of value.matchAll(matcher)) {
    if (match[1] !== undefined) {
      days += Number(match[1]) * 365;
      valid = true;
    } else if (match[2] !== undefined) {
      days += Number(match[2]) * 30;
      valid = true;
    } else if (match[3] !== undefined) {
      days += Number(match[3]);
      valid = true;
    } else if (match[4] !== undefined) {
      seconds += totalSeconds(0, match[4], match[5], match[6]);
      valid = true;
    }
  }
  return valid ? days * 86400 + seconds : null;
}

function parseDurationString(value: string, format: DurationFormat): number | null {
  let text = value.trim();
  if (!text) return null;
  let sign = 1;
  if (text.startsWith("-")) {
    sign = -1;
    text = text.slice(1);
  }
  for (const matcher of durationMatchers) {
    const match = matcher.regex.exec(text);
    if (!match) continue;
    const parser = matcher.parsers[format] || matcher.parsers.default;
    if (!parser) continue;
    const total = parser(...match.slice(1));
    return Number.isFinite(total) ? total * sign : null;
  }
  const postgresInterval = parsePostgresInterval(text);
  return postgresInterval === null ? null : postgresInterval * sign;
}

export function parseDurationSeconds(value: unknown, formatValue?: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const format = durationFormat(formatValue);
  let rawSeconds: number | null = null;
  if (typeof value === "number") {
    rawSeconds = Number.isFinite(value) ? value : null;
  } else if (typeof value === "string") {
    const text = value.trim();
    if (!text) return null;
    const numeric = Number(text);
    rawSeconds = Number.isFinite(numeric) ? numeric : parseDurationString(text, format);
  } else {
    return null;
  }
  return rawSeconds === null ? null : roundForFormat(format, rawSeconds);
}
