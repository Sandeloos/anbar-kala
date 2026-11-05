'use strict';
/**
 * Importing orders from a platform's spreadsheet export (Digikala seller panel and the like).
 * The exact columns differ between platforms and change over time, so the admin maps
 * columns to fields once per platform (we guess from the Persian header names), previews
 * every row (matched listing, duplicate, problems) and then imports.
 */
const ExcelJS = require('exceljs');
const { toLatinDigits, searchKey } = require('./util');

const FIELDS = {
  order_number: { label: 'شماره‌ی سفارش', hints: ['شماره سفارش', 'کد سفارش', 'شناسه سفارش', 'order id', 'order number', 'شماره‌ی سفارش'] },
  date: { label: 'تاریخ (و ساعت) سفارش', hints: ['تاریخ ثبت سفارش', 'تاریخ سفارش', 'زمان ثبت', 'تاریخ ثبت', 'تاریخ', 'date', 'created'] },
  time: { label: 'ساعت سفارش (اگر جداست)', hints: ['ساعت ثبت', 'ساعت', 'time'] },
  code: { label: 'کد کالا در پلتفرم', hints: ['کد تنوع', 'شناسه تنوع', 'dkpc', 'کد dkpc', 'variant', 'کد کالا', 'شناسه کالا', 'dkp', 'sku'] },
  title: { label: 'عنوان کالا', hints: ['عنوان کالا', 'نام کالا', 'عنوان تنوع', 'عنوان', 'نام محصول', 'title', 'product'] },
  qty: { label: 'تعداد', hints: ['تعداد', 'quantity', 'qty'] },
  price: { label: 'قیمت هر عدد در پلتفرم', hints: ['قیمت فروش', 'مبلغ فروش', 'قیمت واحد', 'قیمت', 'مبلغ', 'price'] },
  status: { label: 'وضعیت (ردیف‌های لغوشده رد می‌شوند)', hints: ['وضعیت سفارش', 'وضعیت', 'status'] }
};

function cellText(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v;
  if (typeof v === 'object') {
    if (v.richText) return v.richText.map((r) => r.text).join('');
    if (v.text !== undefined) return String(v.text);
    if (v.result !== undefined) return cellText(v.result);
    if (v.hyperlink) return String(v.text || v.hyperlink);
    return '';
  }
  return typeof v === 'string' ? v.trim() : v;
}

function parseCsv(text) {
  const s = text.replace(/^\uFEFF/, '');
  const first = s.split(/\r?\n/, 1)[0];
  const delim = [',', ';', '\t'].map((d) => [d, first.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"' && s[i + 1] === '"') { field += '"'; i++; } else if (c === '"') quoted = false; else field += c;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === delim) { row.push(field.trim()); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field.trim()); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field || row.length) { row.push(field.trim()); rows.push(row); }
  return rows.filter((r) => r.some((x) => x !== ''));
}

/** Buffer + file name → { headers, rows } (rows are arrays aligned with headers). */
async function parseFile(buffer, fileName) {
  let table;
  if (/\.csv$|\.txt$/i.test(fileName || '')) {
    table = parseCsv(buffer.toString('utf8'));
  } else {
    const wb = new ExcelJS.Workbook();
    try { await wb.xlsx.load(buffer); } catch { throw new Error('فایل اکسل خوانده نشد. فایل باید xlsx یا csv باشد (فایل‌های قدیمی xls را در اکسل با فرمت xlsx ذخیره کنید).'); }
    const ws = wb.worksheets.find((w) => w.actualRowCount > 0);
    if (!ws) throw new Error('فایل خالی است.');
    table = [];
    ws.eachRow({ includeEmpty: false }, (row) => {
      const vals = [];
      for (let c = 1; c <= ws.actualColumnCount || c <= row.cellCount; c++) vals.push(cellText(row.getCell(c).value));
      table.push(vals);
    });
  }
  // The header is the first row with at least two filled cells
  const hi = table.findIndex((r) => r.filter((x) => x !== '' && x !== null).length >= 2);
  if (hi < 0) throw new Error('سطر عنوان ستون‌ها پیدا نشد.');
  const headers = table[hi].map((h, i) => (h === '' || h === null ? `ستون ${i + 1}` : String(h instanceof Date ? h.toISOString() : h)));
  const rows = table.slice(hi + 1).filter((r) => r.some((x) => x !== '' && x !== null)).map((r) => headers.map((_, i) => (r[i] === undefined ? '' : r[i])));
  return { headers, rows };
}

/** Best guess of which column holds which field, from the header names. */
function guessMapping(headers) {
  const keys = headers.map((h) => searchKey(h));
  const used = new Set();
  const mapping = {};
  for (const [field, def] of Object.entries(FIELDS)) {
    for (const hint of def.hints) {
      const k = searchKey(hint);
      const idx = keys.findIndex((h, i) => !used.has(i) && (h === k || h.includes(k)));
      if (idx >= 0) { mapping[field] = idx; used.add(idx); break; }
    }
  }
  return mapping;
}

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(toLatinDigits(String(v)).replace(/[,،٬\s]/g, '').replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : null;
};

module.exports = { FIELDS, parseFile, guessMapping, parseCsv, num, cellText };
