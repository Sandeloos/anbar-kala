'use strict';
const { nowIso, conflict, notFound } = require('./util');

function createReferenceRequests({ db, client, connection, audit, events }) {
  const list = () => db.all(`SELECT r.*, l.code, p.name AS product_name FROM dk_reference_requests r
    JOIN listings l ON l.id = r.listing_id JOIN products p ON p.id = l.product_id ORDER BY r.updated_at DESC, r.id DESC LIMIT 500`);

  async function submit(job, variant, price) {
    const existing = db.get('SELECT * FROM dk_reference_requests WHERE job_id = ?', job.id);
    if (existing && existing.status !== 'pending') return { id: existing.ticket_id, error: existing.error };
    db.tx(() => db.run(`INSERT INTO dk_reference_requests (job_id, listing_id, target_price, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(job_id) DO NOTHING`, job.id, job.listing_id, price, nowIso(), nowIso()));
    const sub = connection().ticket_sub_category_id;
    if (!sub) {
      db.tx(() => db.run('UPDATE dk_reference_requests SET error = ?, updated_at = ? WHERE job_id = ?', 'مدیر باید زیردستهٔ تیکت قیمت مرجع را تنظیم کند.', nowIso(), job.id));
      return null;
    }
    // Fields can be retried safely; ticket creation cannot (a timeout may have created a ticket).
    let fields;
    try { fields = await client().ticketFields(sub); } catch (err) {
      db.tx(() => db.run('UPDATE dk_reference_requests SET error = ?, updated_at = ? WHERE job_id = ?', err.message, nowIso(), job.id));
      throw err;
    }
    const modal = (fields?.items || fields || []).find((x) => x?.type === 'dynamic_modal');
    if (!modal?.name || !variant.product_id) throw conflict('فرم قیمت مرجع یا شناسهٔ کالا در دسترس نیست.');
    const claimed = db.tx(() => db.run("UPDATE dk_reference_requests SET status = 'sending', error = NULL, updated_at = ? WHERE job_id = ? AND status = 'pending'", nowIso(), job.id).changes);
    if (!claimed) {
      const row = db.get('SELECT ticket_id, error FROM dk_reference_requests WHERE job_id = ?', job.id);
      return { id: row.ticket_id, error: row.error };
    }
    try {
      const t = await client().createTicket(sub, { [modal.name]: [{ product_id: variant.product_id, new_reference_price: price, is_registered_in_124: false, link: variant.product_url || '' }] });
      const id = t?.request?.id || t?.id || t?.ticket_id;
      if (!id) throw new Error('پاسخ ثبت درخواست شناسه ندارد؛ پنل دیجی‌کالا را بررسی کنید.');
      db.tx(() => {
        db.run("UPDATE dk_reference_requests SET ticket_id = ?, status = 'submitted', error = NULL, updated_at = ? WHERE job_id = ?", String(id), nowIso(), job.id);
        events.emit('digikala', {});
      });
      return { id };
    } catch (err) {
      db.tx(() => db.run("UPDATE dk_reference_requests SET status = 'uncertain', error = ?, updated_at = ? WHERE job_id = ?", err.message, nowIso(), job.id));
      return { error: err.message };
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
      if (actor || after.status !== r.status) audit(actor, { action: 'digikala', entity: 'listing', id: r.listing_id, summary: `پیگیری درخواست قیمت مرجع دیجی‌کالا: ${r.status} ← ${after.status}`, changes: audit.diff(r, after, { status: 'وضعیت', ticket_id: 'شناسهٔ تیکت', error: 'خطا' }) });
      events.emit('digikala', {});
    });
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
module.exports = { createReferenceRequests };
