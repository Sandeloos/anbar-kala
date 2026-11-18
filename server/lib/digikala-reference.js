'use strict';
const { nowIso, conflict, notFound, searchKey } = require('./util');

const STATUS = { pending: 'در انتظار ارسال', sending: 'در حال ارسال', uncertain: 'نتیجهٔ ارسال نامشخص', submitted: 'ثبت‌شده', open: 'باز', assigned: 'ارجاع‌شده', in_progress: 'در حال بررسی', closed: 'بسته‌شده', on_hold: 'در انتظار پاسخ', resolved: 'پاسخ داده‌شده' };
const SETUP_ERROR = 'درخواست ارسال نشده؛ در «قیمت دیجی‌کالا» زیردستهٔ تیکت قیمت مرجع را تنظیم کنید.';

/** Build the product-selection branch from the actual form, including its controlling select. */
function referenceForm(fields, variant, price) {
  const items = fields?.items || fields || [];
  const modal = items.find((x) => x?.type === 'dynamic_modal');
  if (!modal?.name || !variant.product_id) throw conflict('فرم قیمت مرجع یا شناسهٔ کالا در دسترس نیست.');
  if (modal.extra?.price_type && modal.extra.price_type !== variant.price_type) throw conflict('زیردستهٔ تنظیم‌شده با نوع قیمت کالا سازگار نیست.');
  const form = { [modal.name]: [{ product_id: variant.product_id, new_reference_price: price, is_registered_in_124: false, link: variant.product_url || '' }] };
  if (modal.condition) {
    const condition = modal.condition;
    const parent = items.find((x) => x.name === condition.field_name);
    if (condition.operation !== 'eq' || parent?.type !== 'select' || !parent.extra?.options?.some((o) => o.value === condition.value)) throw conflict('شرط انتخاب کالا در فرم قیمت مرجع شناخته‌شده نیست.');
    // The Open API requires arrays for select fields, even when is_multi is false.
    form[parent.name] = [condition.value];
  }
  for (const field of items) {
    if (!field.is_required || form[field.name] !== undefined || ['hint_box'].includes(field.type)) continue;
    if (field.condition?.operation === 'eq') {
      const selected = form[field.condition.field_name];
      if (!(Array.isArray(selected) ? selected.includes(field.condition.value) : selected === field.condition.value)) continue;
    }
    throw conflict(`فرم قیمت مرجع به «${field.label || field.name}» نیاز دارد؛ از پنل دیجی‌کالا تکمیل کنید.`);
  }
  return form;
}

function createReferenceRequests({ db, client, connection, audit, events }) {
  const list = () => db.all(`SELECT r.*, l.code, p.name AS product_name FROM dk_reference_requests r
    JOIN listings l ON l.id = r.listing_id JOIN products p ON p.id = l.product_id ORDER BY r.updated_at DESC, r.id DESC LIMIT 500`);

  let categories = null;
  let categoriesAt = 0;
  async function categoryFor(variant) {
    const configured = connection().ticket_sub_category_id;
    if (configured) return configured;
    const kind = { recommended: 'پیشنهادی', printed: 'چاپ شده', regulated: 'مصوب' }[variant.price_type];
    if (!kind) throw conflict('نوع قیمت کالا از دیجی‌کالا مشخص نیست؛ زیردستهٔ تیکت قیمت مرجع را مدیر تنظیم کند.');
    if (!categories || Date.now() - categoriesAt > 3600e3) {
      const data = await client().ticketCategories();
      if (!Array.isArray(data?.items)) throw conflict('فهرست زیردسته‌های تیکت از دیجی‌کالا خوانده نشد.');
      categories = data.items.flatMap((c) => c.sub_categories || []);
      categoriesAt = Date.now();
    }
    const matches = categories.filter((c) => {
      const title = searchKey(c.title || '');
      return (!c.provider || c.provider === 'pricing') && title.includes('ثبت قیمت مرجع') && title.includes(kind);
    });
    if (matches.length !== 1) throw conflict(SETUP_ERROR);
    return matches[0].id;
  }

  async function submit(job, variant, price) {
    const existing = db.get('SELECT * FROM dk_reference_requests WHERE job_id = ?', job.id);
    if (existing && existing.status !== 'pending') return { id: existing.ticket_id, error: existing.error };
    db.tx(() => db.run(`INSERT INTO dk_reference_requests (job_id, listing_id, target_price, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(job_id) DO NOTHING`, job.id, job.listing_id, price, nowIso(), nowIso()));
    // Discover the actual form for this variant's pricing type; never guess an API id.
    let sub;
    let form;
    try {
      sub = await categoryFor(variant);
      form = referenceForm(await client().ticketFields(sub), variant, price);
    } catch (err) {
      db.tx(() => db.run('UPDATE dk_reference_requests SET error = ?, updated_at = ? WHERE job_id = ?', err.message, nowIso(), job.id));
      return { error: err.message };
    }
    const claimed = db.tx(() => db.run("UPDATE dk_reference_requests SET status = 'sending', error = NULL, updated_at = ? WHERE job_id = ? AND status = 'pending'", nowIso(), job.id).changes);
    if (!claimed) {
      const row = db.get('SELECT ticket_id, error FROM dk_reference_requests WHERE job_id = ?', job.id);
      return { id: row.ticket_id, error: row.error };
    }
    try {
      const t = await client().createTicket(sub, form);
      const id = t?.request?.id || t?.id || t?.ticket_id;
      if (!id) throw new Error('پاسخ ثبت درخواست شناسه ندارد؛ پنل دیجی‌کالا را بررسی کنید.');
      db.tx(() => {
        db.run("UPDATE dk_reference_requests SET ticket_id = ?, status = 'submitted', error = NULL, updated_at = ? WHERE job_id = ?", String(id), nowIso(), job.id);
        events.emit('digikala', {});
      });
      return { id };
    } catch (err) {
      const error = [err.message, ...Object.values(err.errors || {}).flat().filter((v) => typeof v === 'string')].join(' — ');
      const status = err.status >= 400 && err.status < 500 && ![408, 429].includes(err.status) ? 'pending' : 'uncertain';
      db.tx(() => db.run('UPDATE dk_reference_requests SET status = ?, error = ?, updated_at = ? WHERE job_id = ?', status, error, nowIso(), job.id));
      return { error };
    }
  }

  async function refresh(actor, id) {
    const r = db.get('SELECT * FROM dk_reference_requests WHERE id = ?', Number(id));
    if (!r) throw notFound();
    if (r.status === 'pending') {
      if (connection().mode !== 'live') throw conflict('ارسال درخواست فقط در حالت فعال انجام می‌شود.');
      const l = db.get('SELECT code FROM listings WHERE id = ?', r.listing_id);
      const v = await client().variant(Number(String(l.code).replace(/\D/g, '')));
      await submit({ id: r.job_id, listing_id: r.listing_id }, v, r.target_price);
    } else if (r.ticket_id) {
      const t = await client().ticket(r.ticket_id);
      const status = typeof t?.status === 'string' ? t.status : t?.status?.title;
      if (!status) throw conflict('وضعیت درخواست در پاسخ دیجی‌کالا مشخص نیست.');
      db.tx(() => db.run('UPDATE dk_reference_requests SET status = ?, error = NULL, updated_at = ? WHERE id = ?', status, nowIso(), r.id));
    } else throw conflict('نتیجهٔ ثبت درخواست نامشخص است؛ برای جلوگیری از تیکت تکراری، ابتدا پنل دیجی‌کالا را بررسی کنید.');
    db.tx(() => {
      const after = db.get('SELECT * FROM dk_reference_requests WHERE id = ?', r.id);
      const changes = audit.diff(r, after, { status: 'وضعیت', ticket_id: 'شناسهٔ تیکت', error: 'خطا' });
      if (changes.length) audit(actor, { action: 'digikala', entity: 'listing', id: r.listing_id, summary: `درخواست قیمت مرجع دیجی‌کالا: ${STATUS[after.status] || after.status}`, changes });
      events.emit('digikala', {});
    });
    const result = db.get('SELECT * FROM dk_reference_requests WHERE id = ?', r.id);
    if (result.error) throw conflict(result.error);
    return result;
  }
  async function poll() {
    for (const r of db.all("SELECT * FROM dk_reference_requests WHERE status NOT IN ('closed', 'resolved', 'sending', 'uncertain') ORDER BY updated_at LIMIT 20")) {
      try { await refresh(null, r.id); } catch (err) {
        db.tx(() => db.run('UPDATE dk_reference_requests SET error = ?, updated_at = ? WHERE id = ?', err.message, nowIso(), r.id));
      }
    }
  }
  return { list, submit, refresh, poll };
}
module.exports = { createReferenceRequests, referenceForm };
