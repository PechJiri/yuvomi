/** Pure server-side fasting summaries; resource use scales with record count. */
import { fastingDateKeyFactory } from './fasting-dates.js';
import { shiftDateKey } from '../utils/timezone.js';

const DAY = 24 * 60;

function duration(row) {
  const start = Date.parse(row?.start_at);
  const end = Date.parse(row?.end_at);
  const milliseconds = end - start;
  return Number.isFinite(milliseconds) && milliseconds > 0
    ? { milliseconds, minutes: Math.floor(milliseconds / 60000) }
    : null;
}

export function dateKeyInZone(value, timeZone) {
  requireTimeZone(timeZone);
  return fastingDateKeyFactory(timeZone)(value);
}

function requireTimeZone(timeZone) {
  if (typeof timeZone !== 'string' || !timeZone.trim()) {
    throw new TypeError('A display timeZone is required for fasting calendar calculations.');
  }
}

function requireDateKey(dateKey, name) {
  if (typeof dateKey !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) {
    throw new TypeError(`A YYYY-MM-DD ${name} is required for fasting calendar calculations.`);
  }
}

export function summarizeFastingRows(rows = []) {
  const durations = rows.map(duration).filter(Boolean);
  const totalMinutes = durations.reduce((sum, item) => sum + item.minutes, 0);
  return { count: durations.length, totalMinutes, averageMinutes: durations.length ? Math.round(totalMinutes / durations.length) : 0 };
}

// Gregorian calendar-day ordinal, without Date's year-0..99 remapping or
// TimeClip limits at the edges of the supported instant range.
function calendarDay(year, month, day) {
  const previousYear = year - 1;
  const beforeMonth = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return 365 * year + Math.floor(previousYear / 4) - Math.floor(previousYear / 100)
    + Math.floor(previousYear / 400) + beforeMonth[month - 1] + day - 1
    + (leap && month > 2 ? 1 : 0);
}

function completionDay(value, formatter) {
  const parts = Object.fromEntries(formatter.formatToParts(new Date(value)).map(({ type, value: part }) => [type, part]));
  const year = parts.era === 'BC' ? 1 - Number(parts.year) : Number(parts.year);
  return calendarDay(year, Number(parts.month), Number(parts.day));
}

export function fastingStreaks(rows = [], { today, timeZone } = {}) {
  requireDateKey(today, 'today');
  requireTimeZone(timeZone);
  // One inclusive interval per qualifying record. Actual fast duration is
  // deliberately unbounded, so neither memory nor work may grow per day.
  const intervals = [];
  const formatter = new Intl.DateTimeFormat('en-US', { timeZone, calendar: 'gregory', numberingSystem: 'latn', era: 'short', year: 'numeric', month: 'numeric', day: 'numeric' });
  for (const row of rows) {
    const elapsed = duration(row);
    if (elapsed && row?.goal_minutes !== null && row?.goal_minutes !== undefined && elapsed.milliseconds >= Number(row.goal_minutes) * 60000) {
      const end = completionDay(row.end_at, formatter);
      intervals.push([end - Math.ceil(elapsed.milliseconds / (DAY * 60000)) + 1, end]);
    }
  }
  intervals.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const interval of intervals) {
    const previous = merged.at(-1);
    if (previous && interval[0] <= previous[1] + 1) previous[1] = Math.max(previous[1], interval[1]);
    else merged.push(interval);
  }
  const match = /^([+-]?\d{4,6})-(\d{2})-(\d{2})$/.exec(today);
  const todayDay = match ? calendarDay(Number(match[1]), Number(match[2]), Number(match[3])) : NaN;
  let longest = 0;
  let current = 0;
  for (const [start, end] of merged) {
    const length = end - start + 1;
    longest = Math.max(longest, length);
    if (end === todayDay || end === todayDay - 1) current = length;
  }
  return { current, longest };
}

export function weeklyFastingSeries(rows = [], { endDate, timeZone } = {}) {
  requireDateKey(endDate, 'endDate');
  requireTimeZone(timeZone);
  const dates = Array.from({ length: 7 }, (_, index) => shiftDateKey(endDate, index - 6));
  const buckets = new Map(dates.map((date) => [date, {
    count: 0, totalMinutes: 0, goalMinutes: 0, goalCount: 0,
  }]));
  const dateKey = fastingDateKeyFactory(timeZone);
  for (const row of rows) {
    const elapsed = duration(row);
    const date = elapsed ? dateKey(row.end_at) : null;
    const bucket = buckets.get(date);
    if (!bucket) continue;
    bucket.count += 1;
    bucket.totalMinutes += elapsed.minutes;
    if (row.goal_minutes !== null && row.goal_minutes !== undefined) {
      bucket.goalMinutes += Number(row.goal_minutes);
      bucket.goalCount += 1;
    }
  }
  return dates.map((date) => {
    const bucket = buckets.get(date);
    return {
      date,
      count: bucket.count,
      totalMinutes: bucket.totalMinutes,
      goalMinutes: bucket.goalCount ? bucket.goalMinutes : null,
      goalCount: bucket.goalCount,
      hasRecord: bucket.count > 0,
    };
  });
}
