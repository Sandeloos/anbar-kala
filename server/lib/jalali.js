'use strict';
/**
 * Jalali (Solar Hijri) ↔ Gregorian, and parsing the date/time strings people
 * type or platforms export ("۱۴۰۵/۰۸/۱۴ ۱۴:۲۰", "2026-11-05 14:20").
 * Tehran is UTC+03:30 all year (Iran dropped daylight saving in 2022).
 * The same algorithm lives in public/assets/js/jalali.js for the browser.
 */
const { toLatinDigits } = require('./util');

const TEHRAN_OFFSET = '+03:30';

function toJalali(gy, gm, gd) {
  const gdm = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
  const gy2 = gm > 2 ? gy + 1 : gy;
  let days = 355666 + 365 * gy + Math.floor((gy2 + 3) / 4) - Math.floor((gy2 + 99) / 100) + Math.floor((gy2 + 399) / 400) + gd + gdm[gm - 1];
  let jy = -1595 + 33 * Math.floor(days / 12053);
  days %= 12053;
  jy += 4 * Math.floor(days / 1461);
  days %= 1461;
  if (days > 365) { jy += Math.floor((days - 1) / 365); days = (days - 1) % 365; }
  const jm = days < 186 ? 1 + Math.floor(days / 31) : 7 + Math.floor((days - 186) / 30);
  const jd = days < 186 ? 1 + (days % 31) : 1 + ((days - 186) % 30);
  return [jy, jm, jd];
}

function toGregorian(jy, jm, jd) {
  jy += 1595;
  let days = -355668 + 365 * jy + Math.floor(jy / 33) * 8 + Math.floor(((jy % 33) + 3) / 4) + jd + (jm < 7 ? (jm - 1) * 31 : (jm - 7) * 30 + 186);
  let gy = 400 * Math.floor(days / 146097);
  days %= 146097;
  if (days > 36524) { gy += 100 * Math.floor(--days / 36524); days %= 36524; if (days >= 365) days++; }
  gy += 4 * Math.floor(days / 1461);
  days %= 1461;
  if (days > 365) { gy += Math.floor((days - 1) / 365); days = (days - 1) % 365; }
  let gd = days + 1;
  const sal = [0, 31, (gy % 4 === 0 && gy % 100 !== 0) || gy % 400 === 0 ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  let gm;
  for (gm = 0; gm < 13 && gd > sal[gm]; gm++) gd -= sal[gm];
  return [gy, gm, gd];
}

const pad = (n) => String(n).padStart(2, '0');

/**
 * "1405/08/14 14:20[:05]" (Jalali) or "2026-11-05 14:20" / ISO / Excel Date → ISO UTC string,
 * reading wall-clock times as Tehran time. null when it cannot be understood.
 */
function parseDateTime(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) {
    // Spreadsheet dates come as UTC midnight-based wall clock: re-read the wall clock as Tehran time
    if (Number.isNaN(value.getTime())) return null;
    return wall(value.getUTCFullYear(), value.getUTCMonth() + 1, value.getUTCDate(), value.getUTCHours(), value.getUTCMinutes(), value.getUTCSeconds());
  }
  const s = toLatinDigits(String(value)).trim().replace(/[‎‏]/g, '');
  if (/Z$|[+-]\d\d:?\d\d$/.test(s) && /^\d{4}-\d\d-\d\dT/.test(s)) {
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const m = /^(\d{4})[/\-.](\d{1,2})[/\-.](\d{1,2})(?:[ T،,]+(\d{1,2})[:.](\d{1,2})(?:[:.](\d{1,2}))?)?/.exec(s);
  if (!m) {
    // "14:20 1405/08/14" (time first)
    const r = /^(\d{1,2})[:.](\d{1,2})(?:[:.](\d{1,2}))?\s+(\d{4})[/\-.](\d{1,2})[/\-.](\d{1,2})$/.exec(s);
    if (!r) return null;
    return fromParts(+r[4], +r[5], +r[6], +r[1], +r[2], +(r[3] || 0));
  }
  return fromParts(+m[1], +m[2], +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
}

function fromParts(y, mo, d, h, mi, se) {
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || se > 59) return null;
  if (y < 1700) {
    // Jalali
    if (mo > 6 && d > 30) return null;
    const [gy, gm, gd] = toGregorian(y, mo, d);
    const back = toJalali(gy, gm, gd);
    if (back[0] !== y || back[1] !== mo || back[2] !== d) return null; // e.g. 30 Esfand of a common year
    return wall(gy, gm, gd, h, mi, se);
  }
  const t = new Date(Date.UTC(y, mo - 1, d));
  if (t.getUTCMonth() !== mo - 1) return null;
  return wall(y, mo, d, h, mi, se);
}

/** A Tehran wall-clock time → ISO UTC */
function wall(y, mo, d, h = 0, mi = 0, se = 0) {
  return new Date(`${y}-${pad(mo)}-${pad(d)}T${pad(h)}:${pad(mi)}:${pad(se)}${TEHRAN_OFFSET}`).toISOString();
}

/** ISO → { date: 'YYYY-MM-DD' (Gregorian, Tehran), jalali: [y, m, d] } */
function tehranDay(iso) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tehran', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
  const [y, m, d] = p.split('-').map(Number);
  return { date: p, jalali: toJalali(y, m, d) };
}
/** Start of a Tehran calendar day (Gregorian 'YYYY-MM-DD') as ISO UTC */
const dayStart = (date) => new Date(`${date}T00:00:00${TEHRAN_OFFSET}`).toISOString();

const MONTHS = ['فروردین', 'اردیبهشت', 'خرداد', 'تیر', 'مرداد', 'شهریور', 'مهر', 'آبان', 'آذر', 'دی', 'بهمن', 'اسفند'];
const FA = (s) => String(s).replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[d]);

/** The Jalali month ("1405-08") an ISO time falls in, Tehran time. */
function monthOf(iso) {
  const [jy, jm] = tehranDay(iso).jalali;
  return `${jy}-${pad(jm)}`;
}
/** "1405-08" → { start, end } ISO UTC (end exclusive) */
function monthBounds(month) {
  const [jy, jm] = month.split('-').map(Number);
  const [gy, gm, gd] = toGregorian(jy, jm, 1);
  const [ny, nm] = jm === 12 ? [jy + 1, 1] : [jy, jm + 1];
  const [ey, em, ed] = toGregorian(ny, nm, 1);
  return { start: wall(gy, gm, gd), end: wall(ey, em, ed) };
}
/** "1405-08" → "آبان ۱۴۰۵" */
function monthLabel(month) {
  const [jy, jm] = month.split('-').map(Number);
  return `${MONTHS[jm - 1]} ${FA(jy)}`;
}
const isMonth = (s) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(s || ''));
/** Months from `from` to `to` inclusive, newest first. */
function monthsBetween(from, to) {
  const out = [];
  let [y, m] = to.split('-').map(Number);
  const [fy, fm] = from.split('-').map(Number);
  while (y > fy || (y === fy && m >= fm)) {
    out.push(`${y}-${pad(m)}`);
    m--; if (m === 0) { m = 12; y--; }
    if (out.length > 240) break;
  }
  return out;
}
/** "1404/09/03 ۱۴:۲۰" style label for spreadsheets */
function jalaliDateTime(iso) {
  const { jalali: [y, m, d] } = tehranDay(iso);
  const t = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Tehran', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
  return `${y}/${pad(m)}/${pad(d)} ${t}`;
}

module.exports = {
  toJalali, toGregorian, parseDateTime, wall, tehranDay, dayStart, TEHRAN_OFFSET,
  MONTHS, monthOf, monthBounds, monthLabel, isMonth, monthsBetween, jalaliDateTime
};
