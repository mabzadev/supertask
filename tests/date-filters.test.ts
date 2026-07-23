import { describe, expect, it } from "vitest";
import { baserowDateFilterBounds, baserowDateIsWithinBounds, baserowDateKey, baserowLegacyDateFilterBounds } from "../src/services/date-filters";

describe("Baserow date filter values", () => {
  it("parses multi-step exact date filter values", () => {
    expect(baserowDateFilterBounds("Europe/Zurich?2025-01-15T10:00:00.000Z?exact_date")).toEqual({
      start: "2025-01-15",
      end: "2025-01-16",
    });
  });

  it("parses relative date ranges deterministically", () => {
    const now = new Date("2026-05-28T12:00:00.000Z");
    expect(baserowDateFilterBounds("Europe/Zurich?7?nr_days_ago", now)).toEqual({
      start: "2026-05-21",
      end: "2026-05-22",
    });
    expect(baserowDateIsWithinBounds("Europe/Zurich?7?nr_days_ago", now)).toEqual({
      start: "2026-05-21",
      end: "2026-05-29",
    });
  });

  it("normalizes stored date and datetime cells to comparable date keys", () => {
    expect(baserowDateKey("2025-01-15T10:00:00.000+00:00")).toBe("2025-01-15");
    expect(baserowDateKey("2025-01-15")).toBe("2025-01-15");
  });

  it("parses legacy Baserow date filters with optional timezone prefixes", () => {
    const now = new Date("2026-05-28T12:00:00.000Z");
    expect(baserowLegacyDateFilterBounds("date_within_weeks", "Europe/Zurich?1", now)).toEqual({
      start: "2026-05-28",
      end: "2026-06-05",
    });
    expect(baserowLegacyDateFilterBounds("date_equals_months_ago", "Europe/Zurich?2", now)).toEqual({
      start: "2026-03-01",
      end: "2026-04-01",
    });
    expect(baserowLegacyDateFilterBounds("date_equals_years_ago", "3", now)).toEqual({
      start: "2023-01-01",
      end: "2024-01-01",
    });
    expect(baserowLegacyDateFilterBounds("date_after_days_ago", "7", now)?.start).toBe("2026-05-21");
  });
});
