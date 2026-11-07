/**
 * Order import from a platform's Excel/CSV export (#/orders/import), in three steps:
 * file → which column is what (remembered per platform) → preview, link unknown codes to
 * products → import.
 */
import { get, post } from '../api.js';
import { $, $$, esc, icon, fa, toast, busy, latin, moneyText } from '../ui.js';
import { createPicker } from '../picker.js';
import { fromIso } from '../jalali.js';

export async function render(view, ctx) {
  const [{ items: platforms }, { fields }] = await Promise.all([get('/platforms'), get('/imports/fields')]);
  const active = platforms.filter((p) => p.active);
  const state = { platform: active[0].id, token: null, headers: [], sample: [], mapping: {}, price_unit: 'toman', preview: null, links: {} };

  view.innerHTML = `
    <div><a class="back" href="#/orders">${icon('back')}سفارش‌ها</a>
      <div class="page-head"><div><h1>ورود سفارش‌ها از اکسل</h1><p>فایل خروجی سفارش‌های پنل فروشنده (دیجی‌کالا، باسلام، …) را بدهید. ستون‌ها یک بار برای هر پلتفرم مشخص می‌شوند و دفعه‌ی بعد خودکار است.</p></div></div></div>
    <ol class="steps" aria-label="مراحل"><li class="step" id="st-1" aria-current="step"><b>۱</b>فایل</li><li class="step" id="st-2"><b>۲</b>ستون‌ها</li><li class="step" id="st-3"><b>۳</b>بررسی و ثبت</li></ol>
    <section class="card form" id="s-file">
      <div class="field"><span class="field-label" id="im-pl-label">پلتفرم</span>
        <div class="seg" role="radiogroup" aria-labelledby="im-pl-label">${active.map((p) => `<button type="button" role="radio" data-pl="${p.id}" aria-checked="${p.id === state.platform}">${esc(p.name)}</button>`).join('')}</div></div>
      <label class="dropzone" id="drop"><input type="file" id="im-file" accept=".xlsx,.csv,.txt" class="sr-only">
        ${icon('download')}<strong>فایل xlsx یا csv را اینجا بکشید یا بزنید تا انتخاب کنید</strong><span class="small muted">حداکثر ۱۵ مگابایت</span></label>
      <div id="im-file-status" aria-live="polite"></div>
    </section>
    <section class="card form" id="s-map" hidden></section>
    <section id="s-preview" hidden></section>`;

  const setStep = (n) => [1, 2, 3].forEach((i) => {
    const el = $(`#st-${i}`, view);
    el.classList.toggle('done', i < n);
    if (i === n) el.setAttribute('aria-current', 'step'); else el.removeAttribute('aria-current');
  });

  async function readFile(file) {
    if (!file) return;
    if (file.size > 15 * 1024 * 1024) { toast('فایل بزرگ‌تر از ۱۵ مگابایت است.', { error: true }); return; }
    $('#im-file-status', view).innerHTML = `<p class="muted small">${icon('refresh', 'spin')} در حال خواندن «${esc(file.name)}»…</p>`;
    const buf = new Uint8Array(await file.arrayBuffer());
    let bin = '';
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    try {
      const r = await post('/imports/parse', { platform_id: state.platform, file_name: file.name, data: btoa(bin) });
      Object.assign(state, { token: r.token, headers: r.headers, sample: r.sample, mapping: r.mapping, price_unit: r.price_unit, preview: null, links: {} });
      $('#im-file-status', view).innerHTML = `<div class="callout callout-ok small">${icon('check')}<span>«${esc(file.name)}»: ${fa(r.rows)} ردیف خوانده شد.${r.from_saved ? ' ستون‌ها مثل دفعه‌ی قبل تنظیم شد.' : ''}</span></div>`;
      paintMapping();
      setStep(2);
      if (r.from_saved) preview();
    } catch (err) {
      $('#im-file-status', view).innerHTML = `<div class="callout callout-err">${icon('alert')}<span>${esc(err.message)}</span></div>`;
    }
  }

  function paintMapping() {
    const box = $('#s-map', view);
    box.hidden = false;
    const opts = (sel) => `<option value="">— ندارد —</option>${state.headers.map((h, i) => `<option value="${i}"${sel === i ? ' selected' : ''}>${esc(h)}</option>`).join('')}`;
    const sample = (i) => (i === undefined || i === null ? '' : state.sample.map((r) => r[i]).filter((v) => v !== '' && v !== null).slice(0, 2).map((v) => esc(String(v).slice(0, 40))).join(' · '));
    box.innerHTML = `<div class="card-head" style="margin:0"><div><h2>کدام ستون چیست؟</h2><p>حدس زدیم؛ اگر جایی اشتباه است درستش کنید. نمونه‌ی مقدار هر ستون کنارش دیده می‌شود.</p></div></div>
      <div class="map-grid">${Object.entries(fields).map(([k, label]) => `<div class="field"><label for="m-${k}">${esc(label)}${['order_number', 'date', 'qty'].includes(k) ? ' *' : ''}</label>
        <select id="m-${k}" data-map="${k}">${opts(state.mapping[k])}</select><span class="hint ltr" id="m-${k}-s">${sample(state.mapping[k])}</span></div>`).join('')}</div>
      <div class="field" style="max-width:320px"><label for="m-unit">قیمت‌های فایل به</label><select id="m-unit"><option value="rial"${state.price_unit === 'rial' ? ' selected' : ''}>ریال</option><option value="toman"${state.price_unit === 'toman' ? ' selected' : ''}>تومان</option></select></div>
      <div class="form-actions"><button class="btn btn-primary" type="button" data-preview>${icon('search')}بررسی ردیف‌ها</button></div>`;
  }

  async function preview() {
    const btn = $('[data-preview]', view);
    busy(btn, true, 'در حال بررسی…');
    try {
      state.preview = await post('/imports/preview', { token: state.token, platform_id: state.platform, mapping: state.mapping, price_unit: state.price_unit });
      paintPreview();
      setStep(3);
      $('#s-preview', view).scrollIntoView({ block: 'start' });
    } catch (err) { toast(err.message, { error: true }); } finally { busy(btn, false); }
  }

  function paintPreview() {
    const p = state.preview;
    const box = $('#s-preview', view);
    box.hidden = false;
    const linked = Object.keys(state.links).length;
    const willImport = p.ready + p.rows.filter((r) => !r.listing && !r.skip && !r.problems.length && state.links[r.key]).length;
    box.innerHTML = `
      <div class="metrics">
        <div class="metric tone-green">${icon('check')}<strong>${fa(willImport)}</strong><span>ردیف آماده‌ی ثبت</span></div>
        <div class="metric tone-orange">${icon('link')}<strong>${fa(p.unmatched.length - linked)}</strong><span>کد ناشناخته (وصل کنید)</span></div>
        <div class="metric">${icon('x')}<strong>${fa(p.skipped)}</strong><span>رد می‌شود (لغوشده یا تکراری)</span></div>
        <div class="metric tone-red">${icon('alert')}<strong>${fa(p.problems)}</strong><span>ردیف مشکل‌دار</span></div>
      </div>
      ${p.unmatched.length ? `<section class="card" style="margin-top:16px"><div class="card-head"><div><h2>کدهای ناشناخته</h2><p>هر کد را به کالای سایت شرکت وصل کنید و بگویید هر فروشش چند عدد است. آگهی ساخته می‌شود و دفعه‌ی بعد خودکار شناخته می‌شود.</p></div></div>
        <div class="list">${p.unmatched.map((u, i) => {
          const link = state.links[u.key];
          return `<div class="unmatched" data-u="${i}"><div class="grow"><strong class="ltr">${esc(u.code || '')}</strong> ${esc(u.title || '')} <span class="small muted">(${fa(u.rows)} ردیف)</span>
            ${link ? `<div class="small linked">${icon('check')} ${esc(link.name)} <button class="link" type="button" data-unlink="${i}">تغییر</button></div>
              <label class="small">هر فروش <input class="pack-input" data-units="${i}" inputmode="numeric" value="${fa(link.units)}" aria-label="هر فروش چند عدد است"> عدد از بسته‌ی ${fa(link.units_per_pack)} عددی</label>` : ''}</div>
            ${link ? '' : `<div class="picker"><label class="sr-only" for="u-pick-${i}">کالای سایت برای ${esc(u.key)}</label><div class="search">${icon('search')}<input id="u-pick-${i}" type="search" data-upick="${i}" placeholder="جستجوی کالای سایت…" value=""></div></div>`}
          </div>`;
        }).join('')}</div></section>` : ''}
      <section class="card card-flush" style="margin-top:16px"><div class="card-head"><h2>ردیف‌ها${p.total > p.rows.length ? ` (${fa(p.rows.length)} ردیف اول از ${fa(p.total)})` : ''}</h2></div>
        <div class="table-wrap"><table class="table"><thead><tr><th scope="col">سفارش</th><th scope="col">کالا</th><th scope="col" class="col-num">تعداد</th><th scope="col" class="col-num">قیمت</th><th scope="col">وضعیت</th></tr></thead>
        <tbody>${p.rows.map((r) => {
          const l = r.listing || state.links[r.key];
          const status = r.skip ? `<span class="badge">${esc(r.skip)}</span>` : r.problems.length ? `<span class="badge badge-red">${esc(r.problems.join('، '))}</span>` : l ? '<span class="badge badge-green">آماده</span>' : '<span class="badge badge-orange">کد ناشناخته</span>';
          const t = r.ordered_at ? fromIso(r.ordered_at) : null;
          return `<tr><td class="cell-main"><div class="cell-title"><strong class="ltr">${esc(r.order_number)}</strong><small>${t ? `${t.date} ${t.time}` : ''}</small></div></td>
            <td data-label="کالا">${esc(r.title || r.code)}${l ? `<div class="small muted">← ${esc(l.product_name || l.name)} (${fa(l.units)} عدد)</div>` : ''}</td>
            <td class="col-num" data-label="تعداد">${fa(r.qty)}</td><td class="col-num" data-label="قیمت">${r.platform_price ? moneyText(r.platform_price, 'toman') : '—'}</td><td data-label="وضعیت">${status}</td></tr>`;
        }).join('')}</tbody></table></div></section>
      <div class="card" style="margin-top:16px"><div class="form-actions">
        <button class="btn btn-primary btn-lg" type="button" data-commit ${willImport ? '' : 'disabled'}>${icon('check')}ثبت ${fa(willImport)} ردیف</button>
        <span class="small muted">ردیف‌های همان شماره‌ی سفارش یک سفارش می‌شوند. سفارشی که قیمت سایتِ آن ساعت را نداشته باشد ثبت نمی‌شود و در نتیجه می‌آید.</span></div></div>`;
    $$('[data-upick]', box).forEach((input) => {
      const u = p.unmatched[Number(input.dataset.upick)];
      createPicker(input, {
        params: () => ({ products_only: 1 }),
        onPick(it) {
          // A whole pack by default; a "25 pieces" listing of a 100-piece product is changed right there
          state.links[u.key] = { product_id: it.product_id, units: it.units_per_pack, units_per_pack: it.units_per_pack, name: it.name, product_name: it.name };
          paintPreview();
          const input = $(`[data-units="${p.unmatched.indexOf(u)}"]`, view);
          if (input) { input.focus(); input.select(); }
        }
      });
    });
  }

  view.onclick = async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.pl) {
      state.platform = Number(b.dataset.pl);
      $$('[data-pl]', view).forEach((x) => x.setAttribute('aria-checked', String(x === b)));
      if (state.token) { $('#im-file-status', view).innerHTML = '<p class="small muted">پلتفرم عوض شد؛ فایل را دوباره انتخاب کنید.</p>'; state.token = null; $('#s-map', view).hidden = true; $('#s-preview', view).hidden = true; setStep(1); }
      return;
    }
    if (b.hasAttribute('data-preview')) return preview();
    if (b.dataset.unlink !== undefined) { delete state.links[state.preview.unmatched[Number(b.dataset.unlink)].key]; return paintPreview(); }
    if (b.hasAttribute('data-commit')) {
      busy(b, true, 'در حال ثبت…');
      try {
        const links = Object.fromEntries(Object.entries(state.links).map(([k, v]) => [k, { product_id: v.product_id, units: v.units }]));
        const r = await post('/imports/commit', { token: state.token, platform_id: state.platform, mapping: state.mapping, price_unit: state.price_unit, links });
        $('#s-preview', view).innerHTML = `<div class="card">
          <div class="callout callout-ok">${icon('check')}<span>${fa(r.orders_created)} سفارش و ${fa(r.lines_created)} قلم ثبت شد${r.listings_created ? `؛ ${fa(r.listings_created)} آگهی جدید ساخته شد` : ''}.</span></div>
          ${r.errors.length ? `<div class="callout callout-err" style="margin-top:12px">${icon('alert')}<div><strong>${fa(r.errors.length)} سفارش ثبت نشد:</strong><ul style="list-style:disc;padding-inline-start:20px">${r.errors.map((x) => `<li><span class="ltr">${esc(x.order_number)}</span>: ${esc(x.error)}</li>`).join('')}</ul>این‌ها را از «سفارش جدید» با قیمت دستی ثبت کنید.</div></div>` : ''}
          <div class="form-actions" style="margin-top:12px"><a class="btn btn-primary" href="#/orders">دیدن سفارش‌ها</a><a class="btn" href="#/receiving">دریافت روزانه</a></div></div>`;
        $('#s-map', view).hidden = true;
        ctx.refreshCounts();
      } catch (err) { toast(err.message, { error: true }); busy(b, false); }
    }
  };
  view.onchange = (e) => {
    const el = e.target;
    if (el.id === 'im-file') return readFile(el.files[0]);
    if (el.dataset.map) {
      state.mapping[el.dataset.map] = el.value === '' ? undefined : Number(el.value);
      const i = state.mapping[el.dataset.map];
      $(`#m-${el.dataset.map}-s`, view).textContent = i === undefined ? '' : state.sample.map((r) => r[i]).filter((v) => v !== '' && v !== null).slice(0, 2).join(' · ');
    }
    if (el.id === 'm-unit') state.price_unit = el.value;
    if (el.dataset.units !== undefined) {
      const link = state.links[state.preview.unmatched[Number(el.dataset.units)].key];
      const n = Number(latin(el.value).replace(/[,،٬\s]/g, ''));
      if (Number.isInteger(n) && n > 0) link.units = n;
      else { toast('تعداد عدد در هر فروش باید عدد صحیح ۱ یا بیشتر باشد.', { error: true }); el.value = fa(link.units); }
    }
  };
  const drop = $('#drop', view);
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('is-over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('is-over'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('is-over'); readFile(e.dataTransfer.files[0]); });
}
