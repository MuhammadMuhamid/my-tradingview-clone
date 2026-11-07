/**
 * When cohorts start and end.
 *
 * Every package runs one cohort at a time, back to back, on calendar boundaries
 * in Asia/Karachi. Pakistan has kept a fixed UTC+5 with no daylight saving since
 * 2009, so local midnight is exactly 19:00 UTC on the day before.
 *
 * A window is half-open: `startsAt` is the first instant, `endsAt` the first
 * instant of the next cohort. The deposit cutoff is `startsAt`: a deposit counts
 * for a cohort only if it was recorded strictly before the cohort began, which is
 * "by 23:59:59 the day before" in the reader's terms.
 */
export type Term = "half_month" | "month" | "quarter" | "half_year";

export const TERMS: readonly Term[] = ["half_month", "month", "quarter", "half_year"];
export const TIME_ZONE = "Asia/Karachi";
const OFFSET_MS = 5 * 60 * 60 * 1000;

export interface CohortWindow {
  startsAt: Date;
  endsAt: Date;
  depositCutoffAt: Date;
}

/** Karachi midnight at the start of this calendar date, as an instant. */
export function karachiMidnight(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month - 1, day) - OFFSET_MS);
}

/** The Karachi calendar date an instant falls on. */
export function karachiDate(at: Date): { year: number; month: number; day: number } {
  const shifted = new Date(at.getTime() + OFFSET_MS);
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() };
}

function addMonths(year: number, month: number, months: number): { year: number; month: number } {
  const index = year * 12 + (month - 1) + months;
  return { year: Math.floor(index / 12), month: (index % 12) + 1 };
}

/** Whether a cohort of this term may begin on this local date. */
export function isValidStart(term: Term, year: number, month: number, day: number): boolean {
  if (!Number.isInteger(year) || month < 1 || month > 12) return false;
  return term === "half_month" ? day === 1 || day === 16 : day === 1;
}

export function cohortWindow(term: Term, year: number, month: number, day: number): CohortWindow {
  if (!isValidStart(term, year, month, day)) {
    throw new RangeError(`a ${term} cohort can't start on ${year}-${month}-${day}`);
  }
  const startsAt = karachiMidnight(year, month, day);
  let end: { year: number; month: number; day: number };
  if (term === "half_month") {
    end = day === 1 ? { year, month, day: 16 } : { ...addMonths(year, month, 1), day: 1 };
  } else {
    const months = term === "month" ? 1 : term === "quarter" ? 3 : 6;
    end = { ...addMonths(year, month, months), day: 1 };
  }
  return { startsAt, endsAt: karachiMidnight(end.year, end.month, end.day), depositCutoffAt: startsAt };
}

/** The cohort that follows one ending at `previousEnd`: back to back, one at a time. */
export function nextWindow(term: Term, previousEnd: Date): CohortWindow {
  const { year, month, day } = karachiDate(previousEnd);
  return cohortWindow(term, year, month, day);
}

/** The first cohort a package can start on or after `from`. */
export function firstWindowFrom(term: Term, from: Date): CohortWindow {
  const { year, month, day } = karachiDate(from);
  if (isValidStart(term, year, month, day) && karachiMidnight(year, month, day).getTime() >= from.getTime()) {
    return cohortWindow(term, year, month, day);
  }
  if (term === "half_month" && day < 16) return cohortWindow(term, year, month, 16);
  const next = addMonths(year, month, 1);
  return cohortWindow(term, next.year, next.month, 1);
}
