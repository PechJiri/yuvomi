export function fastingDateKeyFactory(timeZone) {
  if (typeof timeZone !== 'string' || !timeZone.trim()) {
    throw new TypeError('A timeZone is required to derive a fasting calendar date.');
  }
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    calendar: 'gregory',
    numberingSystem: 'latn',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return (value) => {
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) return null;
    const parts = formatter.formatToParts(date);
    const map = Object.fromEntries(parts.map(({ type, value: part }) => [type, part]));
    const year = String(Number(map.year)).padStart(4, '0');
    return `${year}-${map.month}-${map.day}`;
  };
}

export function fastingDateKey(value, timeZone) {
  return fastingDateKeyFactory(timeZone)(value);
}

export function parseFastingDateRange(from, to, fail) {
  const parse = (value) => {
    if (value === undefined || value === null || value === '') return null;
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value));
    if (!match) fail();
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    if (year < 1900) fail();
    const normalized = new Date(0);
    normalized.setUTCHours(0, 0, 0, 0);
    normalized.setUTCFullYear(year, month - 1, day);
    if (normalized.getUTCFullYear() !== year || normalized.getUTCMonth() !== month - 1 || normalized.getUTCDate() !== day) fail();
    return value;
  };
  const parsed = { from: parse(from), to: parse(to) };
  if (parsed.from && parsed.to && parsed.from > parsed.to) fail();
  return parsed;
}

export function rowMatchesFastingDateRange(row, range, timeZone, dateKey = fastingDateKeyFactory(timeZone)) {
  if (!range.from && !range.to) return true;
  const key = dateKey(row.end_at);
  return !!key && (!range.from || key >= range.from) && (!range.to || key <= range.to);
}
