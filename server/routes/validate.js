'use strict';
/** Shared zod pieces with Persian messages. */
const { z } = require('zod');
const { toLatinDigits, normalisePhone } = require('../lib/util');

const text = (label, max = 200) => z.preprocess((v) => (typeof v === 'string' ? v.trim() : v),
  z.string({ error: `${label} را وارد کنید.` }).min(1, `${label} را وارد کنید.`).max(max, `${label} طولانی است.`));
const optText = (max = 2000) => z.preprocess((v) => (typeof v === 'string' ? (v.trim() || null) : v ?? null),
  z.string().max(max, 'متن طولانی است.').nullable());
const phone = z.preprocess((v) => (v ? normalisePhone(v) || null : null),
  z.string().regex(/^0\d{9,10}$/, 'شماره تلفن معتبر نیست.').nullable());
const email = z.preprocess((v) => (typeof v === 'string' ? (v.trim().toLowerCase() || null) : v ?? null),
  z.string().email('ایمیل معتبر نیست.').nullable());
const intIn = (label, min, max) => z.preprocess((v) => (typeof v === 'string' ? Number(toLatinDigits(v).replace(/[,،\s]/g, '')) : v),
  z.number({ error: `${label} باید عدد باشد.` }).int(`${label} باید عدد صحیح باشد.`).min(min, `${label} حداقل ${min} است.`).max(max, `${label} حداکثر ${max} است.`));
const amount = (label) => z.preprocess((v) => (typeof v === 'string' ? Number(toLatinDigits(v).replace(/[,،\s]/g, '')) : v),
  z.number({ error: `${label} باید عدد باشد.` }).min(0, `${label} نمی‌تواند منفی باشد.`).max(1e13, `${label} خیلی بزرگ است.`));
const password = z.string({ error: 'رمز عبور را وارد کنید.' }).min(8, 'رمز عبور باید دست‌کم ۸ نویسه باشد.').max(200, 'رمز عبور طولانی است.');
const username = z.preprocess((v) => (typeof v === 'string' ? v.trim().toLowerCase() : v),
  z.string({ error: 'نام کاربری را وارد کنید.' }).regex(/^[a-z][a-z0-9._-]{2,31}$/, 'نام کاربری: ۳ تا ۳۲ حرف انگلیسی، عدد، نقطه یا خط تیره و با حرف شروع شود.'));
const bool = z.preprocess((v) => v === true || v === 1 || v === '1' || v === 'true' || v === 'on', z.boolean());
const isoTime = z.preprocess((v) => (v ? v : null), z.string().refine((s) => !Number.isNaN(new Date(s).getTime()), 'زمان معتبر نیست.').nullable());

module.exports = { z, text, optText, phone, email, intIn, amount, password, username, bool, isoTime };
