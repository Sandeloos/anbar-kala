/**
 * Jalali dates in the browser: conversion (same algorithm as server/lib/jalali.js),
 * today's date, and reading what people type ("۱۴۰۵/۸/۱۴", "14:20", "1420").
 * Tehran is UTC+03:30 all year.
 */
import { latin, faDigits } from './ui.js';

export const MONTHS = ['فروردین', 'اردیبهشت', 'خرداد', 'تیر', 'مرداد', 'شهریور', 'مهر', 'آبان', 'آذر', 'دی', 'بهمن', 'اسفند'];

export function toJalali(gy, gm, gd) {
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

export function toGregorian(jy, jm, jd) {
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
const tehranParts = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tehran', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
  .formatToParts(d).reduce((o, p) => ((o[p.type] = p.value), o), {});

/** Today (or n days ago) in Tehran as "1405/08/14" with Persian digits. */
export function jalaliToday(offsetDays = 0) {
  const p = tehranParts(new Date(Date.now() + offsetDays * 864e5));
  const [y, m, d] = toJalali(+p.year, +p.month, +p.day);
  return faDigits(`${y}/${pad(m)}/${pad(d)}`);
}
/** Tehran wall-clock time now: "14:20" in Persian digits. */
export function timeNow() {
  const p = tehranParts();
  return faDigits(`${p.hour}:${p.minute}`);
}
/** Gregorian "YYYY-MM-DD" of a Tehran day n days from today. */
export function gregorianDay(offsetDays = 0) {
  const p = tehranParts(new Date(Date.now() + offsetDays * 864e5));
  return `${p.year}-${p.month}-${p.day}`;
}

/** "1405/8/14" → [1405, 8, 14] or null */
export function readDate(s) {
  const m = /^(\d{4})[/\-.](\d{1,2})[/\-.](\d{1,2})$/.exec(latin(s).trim());
  if (!m) return null;
  const [y, mo, d] = [+m[1], +m[2], +m[3]];
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || (mo > 6 && d > 30)) return null;
  const g = toGregorian(y, mo, d);
  const back = toJalali(...g);
  if (back[0] !== y || back[1] !== mo || back[2] !== d) return null;
  return [y, mo, d];
}
/** "14:20" / "1420" / "14.20" / "9" → [14, 20] or null */
export function readTime(s) {
  const t = latin(s).trim();
  let m = /^(\d{1,2})[:.](\d{1,2})$/.exec(t) || /^(\d{2})(\d{2})$/.exec(t) || /^(\d{1,2})$/.exec(t);
  if (!m) return null;
  const h = +m[1], mi = +(m[2] || 0);
  return h > 23 || mi > 59 ? null : [h, mi];
}
/** Jalali date + time typed in Tehran → ISO UTC string, or null */
export function toIso(dateStr, timeStr) {
  const d = readDate(dateStr);
  const t = readTime(timeStr || '0');
  if (!d || !t) return null;
  const [gy, gm, gd] = toGregorian(...d);
  return new Date(`${gy}-${pad(gm)}-${pad(gd)}T${pad(t[0])}:${pad(t[1])}:00+03:30`).toISOString();
}
/** ISO → { date: "۱۴۰۵/۰۸/۱۴", time: "۱۴:۲۰" } in Tehran */
export function fromIso(iso) {
  const p = tehranParts(new Date(iso));
  const [y, m, d] = toJalali(+p.year, +p.month, +p.day);
  return { date: faDigits(`${y}/${pad(m)}/${pad(d)}`), time: faDigits(`${p.hour}:${p.minute}`) };
}
/** "چهارشنبه ۱۴ آبان ۱۴۰۵" for a typed date, or '' */
export function describeDate(dateStr) {
  const d = readDate(dateStr);
  if (!d) return '';
  const [gy, gm, gd] = toGregorian(...d);
  const wd = new Intl.DateTimeFormat('fa-IR', { weekday: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(gy, gm - 1, gd)));
  return `${wd} ${faDigits(d[2])} ${MONTHS[d[1] - 1]} ${faDigits(d[0])}`;
}
