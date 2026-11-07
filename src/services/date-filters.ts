export type DateFilterBounds = {
  start: string;
  end: string;
};

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function dateKey(date: Date): string {
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

function dateFromKey(value: string): Date | null {
  const match = String(value || "").match(/^(\d{1,4})-(\d{2})-(\d{2})/);
  if (!match) return null;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return Number.isNaN(date.getTime()) ? null : date;
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function addMonths(date: Date, months: number): Date {
  const next = new Date(date.getTime());
  next.setUTCMonth(next.getUTCMonth() + months);
  return next;
}

function addYears(date: Date, years: number): Date {
  const next = new Date(date.getTime());
  next.setUTCFullYear(next.getUTCFullYear() + years);
  return next;
}

function startOfWeek(date: Date): Date {
  const day = date.getUTCDay() || 7;
  return addDays(date, 1 - day);
}

function startOfMonth(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function startOfYear(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
}

function dayBounds(date: Date): DateFilterBounds {
  return { start: dateKey(date), end: dateKey(addDays(date, 1)) };
}

function rangeBounds(start: Date, end: Date): DateFilterBounds {
  return { start: dateKey(start), end: dateKey(end) };
}

function splitSupertaskDateFilter(value: string): { dateValue: string; operator: string } {
  const parts = String(value || "").split("?");
  if (parts.length >= 3) return { dateValue: parts[1] || "", operator: parts[2] || "" };
  return { dateValue: String(value || ""), operator: "exact_date" };
}

function splitTimezoneDateFilter(value: string): string {
  const parts = String(value || "").split("?");
  return parts.length >= 2 ? parts.slice(1).join("?") : String(value || "");
}

export function supertaskDateFilterBounds(value: string, now = new Date()): DateFilterBounds | null {
  const today = dateFromKey(dateKey(now)) || new Date();
  const { dateValue, operator } = splitSupertaskDateFilter(value);
  const amount = Number.parseInt(dateValue || "0", 10);
  switch (operator) {
    case "exact_date": {
      const date = dateFromKey(dateValue);
      return date ? dayBounds(date) : null;
    }
    case "today":
      return dayBounds(today);
    case "tomorrow":
      return dayBounds(addDays(today, 1));
    case "yesterday":
      return dayBounds(addDays(today, -1));
    case "nr_days_ago":
      return dayBounds(addDays(today, -amount));
    case "nr_days_from_now":
      return dayBounds(addDays(today, amount));
    case "nr_weeks_ago":
      return dayBounds(addDays(today, -amount * 7));
    case "nr_weeks_from_now":
      return dayBounds(addDays(today, amount * 7));
    case "nr_months_ago":
      return dayBounds(addMonths(today, -amount));
    case "nr_months_from_now":
      return dayBounds(addMonths(today, amount));
    case "nr_years_ago":
      return dayBounds(addYears(today, -amount));
    case "nr_years_from_now":
      return dayBounds(addYears(today, amount));
    case "this_week": {
      const start = startOfWeek(today);
      return rangeBounds(start, addDays(start, 7));
    }
    case "next_week": {
      const start = addDays(startOfWeek(today), 7);
      return rangeBounds(start, addDays(start, 7));
    }
    case "this_month": {
      const start = startOfMonth(today);
      return rangeBounds(start, addMonths(start, 1));
    }
    case "next_month": {
      const start = addMonths(startOfMonth(today), 1);
      return rangeBounds(start, addMonths(start, 1));
    }
    case "this_year": {
      const start = startOfYear(today);
      return rangeBounds(start, addYears(start, 1));
    }
    case "next_year": {
      const start = addYears(startOfYear(today), 1);
      return rangeBounds(start, addYears(start, 1));
    }
    default:
      return null;
  }
}

export function supertaskDateIsWithinBounds(value: string, now = new Date()): DateFilterBounds | null {
  const today = dateFromKey(dateKey(now)) || new Date();
  const { dateValue, operator } = splitSupertaskDateFilter(value);
  const amount = Number.parseInt(dateValue || "0", 10);
  switch (operator) {
    case "nr_days_ago":
      return rangeBounds(addDays(today, -amount), addDays(today, 1));
    case "nr_days_from_now":
      return rangeBounds(today, addDays(today, amount + 1));
    case "nr_weeks_ago":
      return rangeBounds(addDays(today, -amount * 7), addDays(today, 1));
    case "nr_weeks_from_now":
      return rangeBounds(today, addDays(today, amount * 7 + 1));
    case "nr_months_ago":
      return rangeBounds(addMonths(today, -amount), addDays(today, 1));
    case "nr_months_from_now":
      return rangeBounds(today, addDays(addMonths(today, amount), 1));
    case "nr_years_ago":
      return rangeBounds(addYears(today, -amount), addDays(today, 1));
    case "nr_years_from_now":
      return rangeBounds(today, addDays(addYears(today, amount), 1));
    default:
      return supertaskDateFilterBounds(value, now);
  }
}

export function supertaskLegacyDateFilterBounds(type: string, value: string, now = new Date()): DateFilterBounds | null {
  const today = dateFromKey(dateKey(now)) || new Date();
  const filterValue = splitTimezoneDateFilter(value);
  const amount = Number.parseInt(filterValue || "0", 10);
  if (!Number.isFinite(amount)) return null;
  switch (type) {
    case "date_within_days": {
      const target = addDays(today, amount);
      return target >= today ? rangeBounds(today, addDays(target, 1)) : rangeBounds(target, addDays(today, 1));
    }
    case "date_within_weeks": {
      if (amount === 0) return null;
      const target = addDays(today, amount * 7);
      return target >= today ? rangeBounds(today, addDays(target, 1)) : rangeBounds(target, addDays(today, 1));
    }
    case "date_within_months": {
      if (amount === 0) return null;
      const target = addMonths(today, amount);
      return target >= today ? rangeBounds(today, addDays(target, 1)) : rangeBounds(target, addDays(today, 1));
    }
    case "date_equals_days_ago":
      return dayBounds(addDays(today, -amount));
    case "date_equals_months_ago": {
      const target = addMonths(today, -amount);
      const start = startOfMonth(target);
      return rangeBounds(start, addMonths(start, 1));
    }
    case "date_equals_years_ago": {
      const target = addYears(today, -amount);
      const start = startOfYear(target);
      return rangeBounds(start, addYears(start, 1));
    }
    case "date_after_days_ago":
      return amount === 0 ? null : rangeBounds(addDays(today, -amount), addYears(today, 10_000));
    default:
      return null;
  }
}

export function supertaskDateKey(value: unknown): string {
  if (!value) return "";
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? String(value).slice(0, 10) : dateKey(date);
}
