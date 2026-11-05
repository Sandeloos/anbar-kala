'use strict';
/**
 * Orders, daily receiving and stock — the business rules of phase 2.
 *
 * Price: an order line is worth to the company the site's regular price of the product at the
 * order time (price_history), scaled to the units sold: site_price × units_per_sale ÷ units_per_pack
 * (a "25 pieces" sale of a 100-piece product is a quarter of its price). Admins may set the site
 * price or the per-sale amount by hand, always with a reason.
 *
 * Receiving (the five cases): for each waiting line the warehouse records what arrived:
 *   ok      everything right, shipped                        → units_from_company = units_total
 *   excess  more than ordered (100 instead of 25)            → ship what was ordered, the rest into
 *                                                               our warehouse, still owned by the company
 *   short   less or nothing                                  → the rest from our stock (case 4) or cancelled
 *   wrong   another item                                     → it goes into stock or back to the company;
 *                                                               the order from our stock or cancelled
 *   cancelled  the customer order was cancelled before shipping
 * Stock picks default to the company's own surplus first (decision 5), then our own stock.
 * Every stock change is a row in stock_moves; undo writes opposite rows, nothing is deleted.
 */
const { nowIso, badRequest, notFound, conflict, HttpError } = require('./util');

/** An order up to this long before we first read a product still takes that first price (marked uncertain). */
const FIRST_SEEN_GRACE_MS = 15 * 60e3;

const OUTCOME_LABEL = { ok: 'درست رسید', excess: 'اضافه رسید', short: 'کم رسید / نرسید', wrong: 'اشتباه رسید', cancelled: 'لغو شد' };

function createOrders({ db, sync, events, audit }) {
  /* ------------------------------------------------------------ lookups */
  function productRow(id) {
    const p = db.get(`SELECT p.*, c.name AS company_name, c.currency, c.active AS company_active, c.warehouse_id AS company_warehouse_id
                      FROM products p JOIN companies c ON c.id = p.company_id WHERE p.id = ?`, id);
    if (!p) throw notFound('کالا پیدا نشد.');
    return p;
  }
  function platform(id) {
    const pl = db.get('SELECT * FROM platforms WHERE id = ?', id);
    if (!pl) throw badRequest('پلتفرم معتبر نیست.', { platform_id: 'معتبر نیست.' });
    return pl;
  }

  /**
   * The site price for a product at an order time. When the order is recent we first read the
   * product from its site (so "now" really is now); failures fall back to what we know.
   */
  async function quote(productId, orderedAt, { refresh = true } = {}) {
    let p = productRow(productId);
    let refreshed = false;
    let refreshError = null;
    const age = Date.now() - new Date(orderedAt).getTime();
    if (refresh && age < 30 * 60e3 && age > -5 * 60e3) {
      try {
        await Promise.race([sync.refreshProduct(productId), new Promise((_, rej) => setTimeout(() => rej(new Error('سایت دیر جواب داد.')), 8000))]);
        refreshed = true;
      } catch (err) {
        refreshError = err.message;
      }
      p = productRow(productId);
    }
    const at = sync.priceAt(productId, orderedAt, { graceMs: FIRST_SEEN_GRACE_MS });
    return {
      product: { id: p.id, name: p.name, company_id: p.company_id, company_name: p.company_name, currency: p.currency, units_per_pack: p.units_per_pack,
        configured: !!p.configured_at, regular_price: p.regular_price, stock_status: p.stock_status, stock_quantity: p.stock_quantity, last_checked_at: p.last_checked_at, removed: !!p.removed_at },
      price: at,
      // We have not looked at the site since the order time: the price may have changed in between
      uncertain: !!at && (!!at.before_first_seen || !p.last_checked_at || p.last_checked_at < orderedAt),
      refreshed, refresh_error: refreshError
    };
  }

  /** One line of a new order → the row to insert (throws with a Persian message per line). */
  function prepareLine(line, orderedAt, n) {
    const where = `ردیف ${n}`;
    let listing = null;
    let productId = line.product_id;
    if (line.listing_id) {
      listing = db.get('SELECT * FROM listings WHERE id = ?', line.listing_id);
      if (!listing) throw badRequest(`${where}: آگهی پیدا نشد.`);
      productId = listing.product_id;
    }
    if (!productId) throw badRequest(`${where}: کالا را انتخاب کنید.`);
    const p = productRow(productId);
    const qty = Number(line.qty);
    if (!Number.isInteger(qty) || qty < 1) throw badRequest(`${where}: تعداد باید عدد صحیح ۱ یا بیشتر باشد.`);
    const unitsPerSale = listing ? listing.units : Number(line.units_per_sale || p.units_per_pack);
    if (!Number.isInteger(unitsPerSale) || unitsPerSale < 1) throw badRequest(`${where}: تعداد عدد در هر فروش معتبر نیست.`);
    let sitePrice;
    let priceAt = null;
    let source;
    let historyId = null;
    let uncertain = 0;
    if (line.site_price_manual !== undefined && line.site_price_manual !== null && line.site_price_manual !== '') {
      if (!line.reason) throw badRequest(`${where}: برای قیمت دستی دلیل بنویسید.`);
      sitePrice = Math.round(Number(line.site_price_manual));
      source = 'manual';
    } else {
      const at = sync.priceAt(p.id, orderedAt, { graceMs: FIRST_SEEN_GRACE_MS });
      if (!at || at.regular_price === null) {
        throw new HttpError(400, `${where} (${p.name}): قیمت سایت در زمان سفارش معلوم نیست (آن زمان هنوز خوانده نشده بود). قیمت را دستی وارد کنید.`, { code: 'needs_manual_price', line: n });
      }
      sitePrice = at.regular_price;
      priceAt = at.effective_at;
      source = at.source;
      historyId = at.id;
      uncertain = at.before_first_seen || !p.last_checked_at || p.last_checked_at < orderedAt ? 1 : 0;
    }
    let settle = Math.round((sitePrice * unitsPerSale) / p.units_per_pack);
    let manual = 0;
    if (line.settle_unit_price_manual !== undefined && line.settle_unit_price_manual !== null && line.settle_unit_price_manual !== '') {
      if (!line.reason) throw badRequest(`${where}: برای مبلغ دستی دلیل بنویسید.`);
      settle = Math.round(Number(line.settle_unit_price_manual));
      manual = 1;
    }
    return {
      company_id: p.company_id, product_id: p.id, listing_id: listing ? listing.id : null, qty, units_per_sale: unitsPerSale,
      units_total: qty * unitsPerSale, units_per_pack: p.units_per_pack,
      platform_price: line.platform_price === undefined || line.platform_price === '' || line.platform_price === null ? null : Math.round(Number(line.platform_price)),
      site_price: sitePrice, site_price_at: priceAt, site_price_source: source, site_price_history_id: historyId, price_uncertain: uncertain,
      settle_unit_price: settle, settle_manual: manual || (source === 'manual' ? 1 : 0), settle_reason: line.reason || null, name: p.name
    };
  }

  function insertLine(orderId, l, now) {
    return Number(db.run(`INSERT INTO order_lines (order_id, company_id, product_id, listing_id, qty, units_per_sale, units_total, units_per_pack,
        platform_price, site_price, site_price_at, site_price_source, site_price_history_id, price_uncertain, settle_unit_price, settle_manual,
        settle_reason, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    orderId, l.company_id, l.product_id, l.listing_id, l.qty, l.units_per_sale, l.units_total, l.units_per_pack, l.platform_price, l.site_price,
    l.site_price_at, l.site_price_source, l.site_price_history_id, l.price_uncertain, l.settle_unit_price, l.settle_manual, l.settle_reason, now, now).lastInsertRowid);
  }

  /** Creates an order with its lines in one transaction. */
  function createOrder(req, body, { source = 'manual', importId = null } = {}) {
    const pl = platform(body.platform_id);
    const orderedAt = body.ordered_at;
    if (new Date(orderedAt).getTime() > Date.now() + 5 * 60e3) throw badRequest('زمان سفارش نمی‌تواند در آینده باشد.', { ordered_at: 'در آینده است.' });
    const number = body.order_number ? String(body.order_number).trim() : null;
    if (number) {
      const dupe = db.get('SELECT id FROM orders WHERE platform_id = ? AND order_number = ?', pl.id, number);
      if (dupe) throw new HttpError(409, `سفارش ${number} در ${pl.name} قبلاً ثبت شده است.`, { fields: { order_number: 'تکراری است.' }, code: 'duplicate_order', existing_id: dupe.id });
    }
    if (!Array.isArray(body.lines) || !body.lines.length) throw badRequest('دست‌کم یک کالا به سفارش اضافه کنید.');
    const lines = body.lines.map((l, i) => prepareLine(l, orderedAt, i + 1));
    const now = nowIso();
    const user = req && req.user ? req.user : null;
    const id = db.tx(() => {
      const orderId = Number(db.run(`INSERT INTO orders (platform_id, order_number, ordered_at, customer, note, source, import_id, created_by, created_at, updated_at)
                                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      pl.id, number, orderedAt, body.customer || null, body.note || null, source, importId, user ? user.id : null, now, now).lastInsertRowid);
      for (const l of lines) insertLine(orderId, l, now);
      const manual = lines.filter((l) => l.settle_manual);
      audit(req, {
        action: 'create', entity: 'order', id: orderId,
        summary: `ثبت سفارش ${number ? `${number} ` : ''}${pl.name} با ${lines.length} قلم (${lines.map((l) => l.name).slice(0, 3).join('، ')}${lines.length > 3 ? '، …' : ''})` +
          (manual.length ? ` — مبلغ دستی: ${manual.map((l) => l.settle_reason).join('؛ ')}` : '') + (source === 'import' ? ' (از فایل)' : '')
      });
      return orderId;
    });
    events.emit('orders', { ids: [id] });
    return id;
  }

  function orderDetail(id) {
    const o = db.get(`SELECT o.*, pl.name AS platform_name, pl.code AS platform_code, u.name AS created_by_name FROM orders o
                      JOIN platforms pl ON pl.id = o.platform_id LEFT JOIN users u ON u.id = o.created_by WHERE o.id = ?`, Number(id));
    if (!o) throw notFound('سفارش پیدا نشد.');
    const lines = db.all(`SELECT l.*, p.name AS product_name, p.permalink, p.attributes, c.name AS company_name, c.currency,
                            li.title AS listing_title, li.code AS listing_code, ru.name AS received_by_name
                          FROM order_lines l JOIN products p ON p.id = l.product_id JOIN companies c ON c.id = l.company_id
                          LEFT JOIN listings li ON li.id = l.listing_id LEFT JOIN users ru ON ru.id = l.received_by
                          WHERE l.order_id = ? ORDER BY l.id`, o.id);
    for (const l of lines) {
      l.arrivals = db.all(`SELECT a.*, p.name AS product_name, w.name AS warehouse_name FROM arrivals a LEFT JOIN products p ON p.id = a.product_id
                           LEFT JOIN warehouses w ON w.id = a.warehouse_id WHERE a.order_line_id = ? AND a.voided_at IS NULL ORDER BY a.id`, l.id);
      l.moves = db.all(`SELECT m.*, p.name AS product_name, w.name AS warehouse_name, oc.name AS owner_name FROM stock_moves m
                        JOIN products p ON p.id = m.product_id JOIN warehouses w ON w.id = m.warehouse_id LEFT JOIN companies oc ON oc.id = m.owner_company_id
                        WHERE m.order_line_id = ? AND m.reversed_by IS NULL AND m.reverses IS NULL ORDER BY m.id`, l.id);
    }
    const activity = db.all(`SELECT a.id, a.action, a.summary, a.changes, a.created_at, u.name AS user_name FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
                             WHERE (a.entity = 'order' AND a.entity_id = ?) OR (a.entity = 'order_line' AND a.entity_id IN (SELECT CAST(id AS TEXT) FROM order_lines WHERE order_id = ?))
                             ORDER BY a.id DESC`, String(o.id), o.id).map((r) => ({ ...r, changes: r.changes ? JSON.parse(r.changes) : [] }));
    return { order: o, lines, activity };
  }

  /* ------------------------------------------------------------ stock */
  function balance(productId, warehouseId, ownerId) {
    return db.get(`SELECT COALESCE(SUM(units), 0) AS n FROM stock_moves WHERE product_id = ? AND warehouse_id = ? AND owner_company_id IS ?`,
      productId, warehouseId, ownerId ?? null).n;
  }

  /** Writes one ledger row after checking the balance cannot go below zero. */
  function move({ productId, warehouseId, ownerId = null, units, kind, lineId = null, arrivalId = null, value = null, note = null, userId = null, reverses = null }) {
    if (!units) return null;
    if (!db.get('SELECT 1 FROM warehouses WHERE id = ?', warehouseId)) throw badRequest('انبار پیدا نشد.');
    if (units < 0) {
      const have = balance(productId, warehouseId, ownerId);
      if (have + units < 0) {
        const p = db.get('SELECT name FROM products WHERE id = ?', productId);
        throw conflict(`موجودی «${p ? p.name : productId}» در این انبار کافی نیست (موجود: ${have} عدد، لازم: ${-units} عدد).`);
      }
    }
    const id = Number(db.run(`INSERT INTO stock_moves (product_id, warehouse_id, owner_company_id, units, kind, order_line_id, arrival_id, value, reverses, note, user_id, created_at)
                              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    productId, warehouseId, ownerId ?? null, units, kind, lineId, arrivalId, value, reverses, note, userId, nowIso()).lastInsertRowid);
    if (reverses) db.run('UPDATE stock_moves SET reversed_by = ? WHERE id = ?', id, reverses);
    return id;
  }

  /**
   * Stock that can fill an order line of a product: the same product first, then the other
   * variations of the same site product (same company). Company surplus before our own stock.
   */
  function available(productId, { companyOnly = false } = {}) {
    const p = productRow(productId);
    const family = p.parent_woo_id
      ? db.all('SELECT id FROM products WHERE company_id = ? AND parent_woo_id = ?', p.company_id, p.parent_woo_id).map((r) => r.id)
      : [p.id];
    const rows = db.all(`SELECT m.product_id, m.warehouse_id, m.owner_company_id, SUM(m.units) AS units, pr.name AS product_name, pr.units_per_pack,
                           w.name AS warehouse_name, oc.name AS owner_name
                         FROM stock_moves m JOIN products pr ON pr.id = m.product_id JOIN warehouses w ON w.id = m.warehouse_id
                         LEFT JOIN companies oc ON oc.id = m.owner_company_id
                         WHERE m.product_id IN (${family.map(() => '?').join(',')})
                         GROUP BY m.product_id, m.warehouse_id, m.owner_company_id HAVING SUM(m.units) > 0`, ...family);
    const filtered = companyOnly ? rows.filter((r) => r.owner_company_id === p.company_id) : rows.filter((r) => r.owner_company_id === null || r.owner_company_id === p.company_id);
    // Order: this company's surplus first (decision 5), same product before its siblings, then bigger piles
    return filtered.sort((a, b) =>
      (a.owner_company_id === null) - (b.owner_company_id === null) ||
      (a.product_id !== p.id) - (b.product_id !== p.id) ||
      b.units - a.units);
  }

  /** Default allocation of `units` over the available rows (in the order above). */
  function suggestPicks(productId, units) {
    const picks = [];
    let left = units;
    for (const r of available(productId)) {
      if (left <= 0) break;
      const take = Math.min(left, r.units);
      picks.push({ product_id: r.product_id, warehouse_id: r.warehouse_id, owner_company_id: r.owner_company_id, units: take });
      left -= take;
    }
    return { picks, missing: left };
  }

  /* ------------------------------------------------------------ receiving */
  function lineRow(id) {
    const l = db.get(`SELECT l.*, o.ordered_at, o.order_number, o.cancelled_at AS order_cancelled_at, pl.name AS platform_name, p.name AS product_name,
                        p.warehouse_id AS product_warehouse_id, c.warehouse_id AS company_warehouse_id, c.name AS company_name
                      FROM order_lines l JOIN orders o ON o.id = l.order_id JOIN platforms pl ON pl.id = o.platform_id
                      JOIN products p ON p.id = l.product_id JOIN companies c ON c.id = l.company_id WHERE l.id = ?`, Number(id));
    if (!l) throw notFound('ردیف سفارش پیدا نشد.');
    return l;
  }
  const surplusWarehouse = (l, productId) => {
    const p = productId && productId !== l.product_id ? db.get('SELECT warehouse_id FROM products WHERE id = ?', productId) : { warehouse_id: l.product_warehouse_id };
    const id = (p && p.warehouse_id) || l.company_warehouse_id || (db.get('SELECT id FROM warehouses WHERE active = 1 ORDER BY id LIMIT 1') || {}).id;
    return id;
  };
  function companyProduct(l, productId) {
    if (!productId) return null;
    const p = db.get('SELECT id, company_id, name FROM products WHERE id = ?', productId);
    if (!p) throw badRequest('کالای رسیده پیدا نشد.');
    if (p.company_id !== l.company_id) throw badRequest('کالای رسیده باید از همان شرکت باشد.');
    return p;
  }

  /**
   * Fills the rest of a line from our stock: validates the picks (or makes the default ones),
   * writes ship_out moves; company-owned units carry their value for the settlement.
   */
  function shipFromStock(l, units, picks, userId) {
    if (units <= 0) return 0;
    const list = picks && picks.length ? picks : suggestPicks(l.product_id, units).picks;
    const total = list.reduce((s, p) => s + Number(p.units || 0), 0);
    if (total !== units) throw badRequest(`از انبار باید دقیقاً ${units} عدد برداشته شود (الان ${total} عدد انتخاب شده). اگر موجودی کافی نیست، باقی را لغو کنید.`);
    const allowed = new Set(available(l.product_id).map((r) => `${r.product_id}:${r.warehouse_id}:${r.owner_company_id ?? ''}`));
    for (const p of list) {
      const n = Number(p.units);
      if (!Number.isInteger(n) || n <= 0) continue;
      const key = `${p.product_id}:${p.warehouse_id}:${p.owner_company_id ?? ''}`;
      if (!allowed.has(key)) throw badRequest('یکی از ردیف‌های انتخاب‌شده‌ی انبار برای این کالا مجاز نیست.');
      const owner = p.owner_company_id ?? null;
      const value = owner ? Math.round((l.settle_unit_price * n) / l.units_per_sale) : null;
      move({ productId: p.product_id, warehouseId: p.warehouse_id, ownerId: owner, units: -n, kind: 'ship_out', lineId: l.id, value, userId });
    }
    return units;
  }

  function addArrival(l, { productId, description, units, disposition, warehouseId = null, wrong = 0 }, userId) {
    return Number(db.run(`INSERT INTO arrivals (company_id, order_line_id, product_id, description, units, disposition, warehouse_id, wrong, user_id, created_at)
                          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    l.company_id, l.id, productId || null, description || null, units, disposition, warehouseId, wrong, userId, nowIso()).lastInsertRowid);
  }

  /**
   * Records what happened to a waiting line. body: { outcome, arrived_units, arrived_product_id,
   * arrived_description, warehouse_id, wrong_to: stock|returned, rest: stock|cancel, picks: [...], note }
   */
  function receive(req, lineId, body) {
    const userId = req.user ? req.user.id : null;
    const result = db.tx(() => {
      const l = lineRow(lineId);
      if (l.status !== 'pending') throw conflict('وضعیت این ردیف قبلاً ثبت شده است؛ اول «برگرداندن به انتظار» را بزنید.');
      const outcome = body.outcome;
      const need = l.units_total;
      let fromCompany = 0, fromStock = 0, cancelled = 0;
      const details = [];
      if (outcome === 'ok') {
        addArrival(l, { productId: l.product_id, units: need, disposition: 'shipped' }, userId);
        fromCompany = need;
      } else if (outcome === 'cancelled') {
        cancelled = need;
      } else if (outcome === 'excess') {
        const arrived = Number(body.arrived_units);
        if (!Number.isInteger(arrived) || arrived <= need) throw badRequest(`برای «اضافه رسید» تعداد رسیده باید بیشتر از ${need} عدد باشد.`, { arrived_units: `بیشتر از ${need}` });
        const prod = companyProduct(l, body.arrived_product_id) || { id: l.product_id };
        const wh = Number(body.warehouse_id) || surplusWarehouse(l, prod.id);
        addArrival(l, { productId: prod.id, units: need, disposition: 'shipped' }, userId);
        const aid = addArrival(l, { productId: prod.id, units: arrived - need, disposition: 'stock', warehouseId: wh }, userId);
        move({ productId: prod.id, warehouseId: wh, ownerId: l.company_id, units: arrived - need, kind: 'surplus_in', lineId: l.id, arrivalId: aid, userId });
        fromCompany = need;
        details.push(`${arrived} عدد رسید؛ ${need} ارسال شد و ${arrived - need} عدد به انبار رفت (مال ${l.company_name})`);
      } else if (outcome === 'short') {
        const arrived = Number(body.arrived_units || 0);
        if (!Number.isInteger(arrived) || arrived < 0 || arrived >= need) throw badRequest(`برای «کم رسید» تعداد رسیده باید بین ۰ و ${need - 1} باشد.`, { arrived_units: `کمتر از ${need}` });
        if (arrived) addArrival(l, { productId: l.product_id, units: arrived, disposition: 'shipped' }, userId);
        fromCompany = arrived;
        const rest = need - arrived;
        if (body.rest === 'stock') fromStock = shipFromStock(l, rest, body.picks, userId);
        else cancelled = rest;
        details.push(arrived ? `${arrived} عدد از ${need} رسید` : 'چیزی نرسید');
      } else if (outcome === 'wrong') {
        const arrived = Number(body.arrived_units || 0);
        if (!Number.isInteger(arrived) || arrived < 0) throw badRequest('تعداد کالای اشتباه را درست وارد کنید.', { arrived_units: 'عدد صحیح' });
        const prod = companyProduct(l, body.arrived_product_id);
        if (arrived > 0) {
          if (!prod && !body.arrived_description) throw badRequest('بنویسید چه کالایی رسید (یا از کالاهای شرکت انتخاب کنید).', { arrived_description: 'لازم است' });
          if (body.wrong_to === 'stock') {
            if (!prod) throw badRequest('برای بردن به انبار، کالای رسیده را از کالاهای شرکت انتخاب کنید.', { arrived_product_id: 'لازم است' });
            const wh = Number(body.warehouse_id) || surplusWarehouse(l, prod.id);
            const aid = addArrival(l, { productId: prod.id, units: arrived, disposition: 'stock', warehouseId: wh, wrong: 1 }, userId);
            move({ productId: prod.id, warehouseId: wh, ownerId: l.company_id, units: arrived, kind: 'wrong_in', lineId: l.id, arrivalId: aid, userId });
          } else {
            addArrival(l, { productId: prod ? prod.id : null, description: body.arrived_description, units: arrived, disposition: 'returned', wrong: 1 }, userId);
          }
          details.push(`به‌جای سفارش «${prod ? prod.name : body.arrived_description}» (${arrived} عدد) رسید و ${body.wrong_to === 'stock' ? 'به انبار رفت' : 'به شرکت برگشت'}`);
        }
        if (body.rest === 'stock') fromStock = shipFromStock(l, need, body.picks, userId);
        else cancelled = need;
      } else {
        throw badRequest('نتیجه‌ی دریافت را انتخاب کنید.');
      }
      if (fromStock) details.push(`${fromStock} عدد از انبار ما ارسال شد`);
      if (cancelled) details.push(`${cancelled} عدد لغو شد`);
      const status = cancelled === need ? 'cancelled' : 'done';
      db.run(`UPDATE order_lines SET status = ?, outcome = ?, units_from_company = ?, units_from_stock = ?, units_cancelled = ?, received_at = ?, received_by = ?,
                receive_note = ?, updated_at = ? WHERE id = ?`,
      status, outcome, fromCompany, fromStock, cancelled, nowIso(), userId, body.note || null, nowIso(), l.id);
      audit(req, {
        action: 'receive', entity: 'order_line', id: l.id,
        summary: `دریافت «${l.product_name}» (${l.platform_name}${l.order_number ? ` ${l.order_number}` : ''}): ${OUTCOME_LABEL[outcome]}${details.length ? ' — ' + details.join('، ') : ''}${body.note ? ` — ${body.note}` : ''}`
      });
      return { companyId: l.company_id, orderId: l.order_id };
    });
    events.emit('orders', { ids: [result.orderId], lines: [Number(lineId)] });
    events.emit('stock', { companyId: result.companyId });
    return lineRow(lineId);
  }

  /** Puts a received line back to "waiting": opposite stock rows, arrivals voided. */
  function undoReceive(req, lineId) {
    const userId = req.user ? req.user.id : null;
    const result = db.tx(() => {
      const l = lineRow(lineId);
      if (l.status === 'pending') throw conflict('این ردیف هنوز منتظر دریافت است.');
      const moves = db.all('SELECT * FROM stock_moves WHERE order_line_id = ? AND reversed_by IS NULL AND reverses IS NULL ORDER BY id DESC', l.id);
      for (const m of moves) {
        try {
          move({ productId: m.product_id, warehouseId: m.warehouse_id, ownerId: m.owner_company_id, units: -m.units, kind: 'reversal', lineId: l.id, reverses: m.id, userId, note: 'برگرداندن دریافت' });
        } catch (err) {
          if (err.statusCode === 409) throw conflict('کالاهایی که با این دریافت به انبار رفته بودند بعداً استفاده شده‌اند؛ اول آن ارسال‌ها را برگردانید.');
          throw err;
        }
      }
      db.run('UPDATE arrivals SET voided_at = ? WHERE order_line_id = ? AND voided_at IS NULL', nowIso(), l.id);
      db.run(`UPDATE order_lines SET status = 'pending', outcome = NULL, units_from_company = 0, units_from_stock = 0, units_cancelled = 0,
                received_at = NULL, received_by = NULL, receive_note = NULL, updated_at = ? WHERE id = ?`, nowIso(), l.id);
      audit(req, { action: 'undo', entity: 'order_line', id: l.id, summary: `برگرداندن دریافت «${l.product_name}» به حالت انتظار (قبلاً: ${OUTCOME_LABEL[l.outcome] || l.outcome})` });
      return { companyId: l.company_id, orderId: l.order_id };
    });
    events.emit('orders', { ids: [result.orderId], lines: [Number(lineId)] });
    events.emit('stock', { companyId: result.companyId });
    return lineRow(lineId);
  }

  /** Adds lines to an existing order (e.g. an item forgotten at entry). */
  function addLines(req, orderId, lines) {
    const o = db.get('SELECT * FROM orders WHERE id = ?', Number(orderId));
    if (!o) throw notFound('سفارش پیدا نشد.');
    if (o.cancelled_at) throw conflict('این سفارش لغو شده است.');
    const prepared = lines.map((l, i) => prepareLine(l, o.ordered_at, i + 1));
    const now = nowIso();
    db.tx(() => {
      for (const l of prepared) insertLine(o.id, l, now);
      db.run('UPDATE orders SET updated_at = ? WHERE id = ?', now, o.id);
      audit(req, { action: 'update', entity: 'order', id: o.id, summary: `افزودن ${prepared.map((l) => `«${l.name}»`).join('، ')} به سفارش ${o.order_number || o.id}` });
    });
    events.emit('orders', { ids: [o.id] });
  }

  /** Cancels a whole order; lines already received must be put back to waiting first. */
  function cancelOrder(req, orderId, reason) {
    const o = db.get('SELECT * FROM orders WHERE id = ?', Number(orderId));
    if (!o) throw notFound('سفارش پیدا نشد.');
    if (o.cancelled_at) throw conflict('این سفارش قبلاً لغو شده است.');
    if (!reason) throw badRequest('دلیل لغو را بنویسید.', { reason: 'لازم است' });
    if (db.get("SELECT 1 FROM order_lines WHERE order_id = ? AND status = 'done'", o.id)) {
      throw conflict('بعضی ردیف‌های این سفارش دریافت و ارسال شده‌اند؛ اول دریافت آن‌ها را برگردانید.');
    }
    const now = nowIso();
    db.tx(() => {
      db.run('UPDATE orders SET cancelled_at = ?, cancel_reason = ?, updated_at = ? WHERE id = ?', now, reason, now, o.id);
      db.run(`UPDATE order_lines SET status = 'cancelled', outcome = 'cancelled', units_cancelled = units_total, updated_at = ? WHERE order_id = ? AND status = 'pending'`, now, o.id);
      audit(req, { action: 'cancel', entity: 'order', id: o.id, summary: `لغو سفارش ${o.order_number || o.id} — دلیل: ${reason}` });
    });
    events.emit('orders', { ids: [o.id] });
  }

  /**
   * Changes the price of a line by hand: the site price at the order time (per product row)
   * and/or the amount one sale is worth to the company. Always with a reason, always logged.
   */
  function setLinePrice(req, lineId, { site_price, settle_unit_price, reason }) {
    if (!reason) throw badRequest('دلیل تغییر قیمت را بنویسید.', { reason: 'لازم است' });
    const l = lineRow(lineId);
    const changes = [];
    let site = l.site_price;
    let settle = l.settle_unit_price;
    if (site_price !== undefined && site_price !== null && site_price !== '' && Math.round(site_price) !== l.site_price) {
      site = Math.round(site_price);
      changes.push({ field: 'site_price', label: 'قیمت سایت در زمان سفارش (ریال)', from: l.site_price, to: site });
      settle = Math.round((site * l.units_per_sale) / l.units_per_pack);
    }
    if (settle_unit_price !== undefined && settle_unit_price !== null && settle_unit_price !== '') settle = Math.round(settle_unit_price);
    if (settle !== l.settle_unit_price) changes.push({ field: 'settle_unit_price', label: 'مبلغ هر فروش برای شرکت (ریال)', from: l.settle_unit_price, to: settle });
    if (!changes.length) return lineRow(lineId);
    db.tx(() => {
      db.run(`UPDATE order_lines SET site_price = ?, site_price_source = CASE WHEN ? THEN 'manual' ELSE site_price_source END, settle_unit_price = ?,
                settle_manual = 1, settle_reason = ?, updated_at = ? WHERE id = ?`, site, site !== l.site_price ? 1 : 0, settle, reason, nowIso(), l.id);
      // Units already sent from the company's stock carry their value: keep it in step
      for (const m of db.all("SELECT * FROM stock_moves WHERE order_line_id = ? AND kind = 'ship_out' AND owner_company_id IS NOT NULL AND reversed_by IS NULL", l.id)) {
        db.run('UPDATE stock_moves SET value = ? WHERE id = ?', Math.round((settle * -m.units) / l.units_per_sale), m.id);
      }
      audit(req, { action: 'price', entity: 'order_line', id: l.id, summary: `تغییر دستی قیمت «${l.product_name}» در سفارش ${l.order_number || l.order_id} — دلیل: ${reason}`, changes });
    });
    events.emit('orders', { ids: [l.order_id], lines: [l.id] });
    return lineRow(lineId);
  }

  /** Lines waiting for (or received on) a day for one company. */
  function receivingList({ companyId, until, status }) {
    const where = ['o.cancelled_at IS NULL'];
    const params = [];
    if (companyId) { where.push('l.company_id = ?'); params.push(companyId); }
    if (status === 'pending') where.push("l.status = 'pending'");
    else if (status === 'done') where.push("l.status <> 'pending'");
    if (until) { where.push('o.ordered_at < ?'); params.push(until); }
    return db.all(`SELECT l.*, o.ordered_at, o.order_number, pl.name AS platform_name, p.name AS product_name, p.attributes, p.permalink, p.units_per_pack AS product_units,
                     p.parent_woo_id, c.name AS company_name, c.currency, li.title AS listing_title, ru.name AS received_by_name,
                     (SELECT COALESCE(SUM(m.units), 0) FROM stock_moves m JOIN products pp ON pp.id = m.product_id
                       WHERE (m.product_id = l.product_id OR (p.parent_woo_id IS NOT NULL AND pp.company_id = p.company_id AND pp.parent_woo_id = p.parent_woo_id))
                         AND (m.owner_company_id IS NULL OR m.owner_company_id = l.company_id)) AS stock_available
                   FROM order_lines l JOIN orders o ON o.id = l.order_id JOIN platforms pl ON pl.id = o.platform_id
                   JOIN products p ON p.id = l.product_id JOIN companies c ON c.id = l.company_id LEFT JOIN listings li ON li.id = l.listing_id
                   LEFT JOIN users ru ON ru.id = l.received_by
                   WHERE ${where.join(' AND ')} ORDER BY o.ordered_at, l.id LIMIT 2000`, ...params);
  }

  return {
    quote, prepareLine, createOrder, insertLine, addLines, cancelOrder, setLinePrice, orderDetail,
    available, suggestPicks, move, balance, receive, undoReceive, receivingList, lineRow, OUTCOME_LABEL
  };
}

module.exports = { createOrders, OUTCOME_LABEL };
