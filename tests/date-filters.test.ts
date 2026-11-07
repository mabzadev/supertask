import { describe, expect, it } from "vitest";
import { supertaskDateFilterBounds, supertaskDateIsWithinBounds, supertaskDateKey, supertaskLegacyDateFilterBounds } from "../src/services/date-filters";

describe("Supertask date filter values", () => {
  it("parses multi-step exact date filter values", () => {
    expect(supertaskDateFilterBounds("Europe/Zurich?2025-01-15T10:00:00.000Z?exact_date")).toEqual({
      start: "2025-01-15",
      end: "2025-01-16",
    });
  });

  it("parses relative date ranges deterministically", () => {
    const now = new Date("2026-05-28T12:00:00.000Z");
    expect(supertaskDateFilterBounds("Europe/Zurich?7?nr_days_ago", now)).toEqual({
      start: "2026-05-21",
      end: "2026-05-22",
    });
    expect(supertaskDateIsWithinBounds("Europe/Zurich?7?nr_days_ago", now)).toEqual({
      start: "2026-05-21",
      end: "2026-05-29",
    });
  });

  it("normalizes stored date and datetime cells to comparable date keys", () => {
    expect(supertaskDateKey("2025-01-15T10:00:00.000+00:00")).toBe("2025-01-15");
    expect(supertaskDateKey("2025-01-15")).toBe("2025-01-15");
  });

  it("parses legacy Supertask date filters with optional timezone prefixes", () => {
    const now = new Date("2026-05-28T12:00:00.000Z");
    expect(supertaskLegacyDateFilterBounds("date_within_weeks", "Europe/Zurich?1", now)).toEqual({
      start: "2026-05-28",
      end: "2026-06-05",
    });
    expect(supertaskLegacyDateFilterBounds("date_equals_months_ago", "Europe/Zurich?2", now)).toEqual({
      start: "2026-03-01",
      end: "2026-04-01",
    });
    expect(supertaskLegacyDateFilterBounds("date_equals_years_ago", "3", now)).toEqual({
      start: "2023-01-01",
      end: "2024-01-01",
    });
    expect(supertaskLegacyDateFilterBounds("date_after_days_ago", "7", now)?.start).toBe("2026-05-21");
  });
});
