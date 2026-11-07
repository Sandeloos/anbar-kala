/**
 * Search-as-you-type picker for listings and products (an ARIA combobox).
 * Arrow keys move, Enter picks, Escape closes. A pasted listing code matches exactly.
 *
 *   const picker = createPicker(input, { params: () => ({ platform: 1 }), onPick: (item) => … });
 */
import { get } from './api.js';
import { esc, fa, money, debounce } from './ui.js';

let uid = 0;

export function createPicker(input, { params = () => ({}), onPick, render } = {}) {
  const id = `picker-${++uid}`;
  const wrap = input.closest('.picker') || input.parentElement;
  const list = document.createElement('ul');
  list.className = 'picker-list';
  list.id = id;
  list.setAttribute('role', 'listbox');
  list.hidden = true;
  wrap.appendChild(list);
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-controls', id);
  input.setAttribute('aria-expanded', 'false');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('autocomplete', 'off');

  let items = [];
  let index = 0;
  let token = 0;

  const row = render || ((it) => `<span class="grow"><span class="pk-name">${esc(it.name)}</span>
      <span class="pk-sub">${it.kind === 'listing' ? `<span class="badge badge-blue">آگهی${it.code ? ` ${esc(it.code)}` : ''}</span>` : ''}
      <span>${esc(it.company_name)}</span><span>${fa(it.units)} عدد${it.units !== it.units_per_pack ? ` از ${fa(it.units_per_pack)}` : ''}</span></span></span>
    <span class="price">${money(it.regular_price === null ? null : Math.round((it.regular_price * it.units) / it.units_per_pack), it.currency)}${it.units !== it.units_per_pack ? '<small> هر فروش</small>' : ''}</span>`);

  function close() { list.hidden = true; input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant'); }
  function paint(message) {
    if (message) { list.innerHTML = `<li class="pk-none" role="presentation">${esc(message)}</li>`; list.hidden = false; return; }
    list.innerHTML = items.map((it, i) => `<li role="option" id="${id}-${i}" data-i="${i}" aria-selected="${i === index}">${row(it)}</li>`).join('');
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    const cur = list.querySelector(`[data-i="${index}"]`);
    if (cur) { input.setAttribute('aria-activedescendant', cur.id); cur.scrollIntoView({ block: 'nearest' }); }
  }
  const search = debounce(async () => {
    const q = input.value.trim();
    const t = ++token;
    if (q.length < 2) { close(); return; }
    paint('در حال جستجو…');
    try {
      const r = await get('/pick', { q, ...params() });
      if (t !== token) return;
      items = r.items;
      index = 0;
      if (!items.length) paint('چیزی پیدا نشد. نام، کد کالا یا کد آگهی را امتحان کنید.');
      else paint();
    } catch (err) { if (t === token) paint(err.message); }
  }, 180);
  function choose(i) {
    const it = items[i];
    if (!it) return;
    close();
    input.value = '';
    onPick(it);
  }
  input.addEventListener('input', search);
  input.addEventListener('keydown', (e) => {
    if (list.hidden) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); index = Math.min(items.length - 1, index + 1); paint(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); index = Math.max(0, index - 1); paint(); }
    else if (e.key === 'Enter') { e.preventDefault(); choose(index); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); }
  });
  input.addEventListener('blur', () => setTimeout(close, 150));
  list.addEventListener('mousedown', (e) => {
    const o = e.target.closest('[role="option"]');
    if (o) { e.preventDefault(); choose(Number(o.dataset.i)); }
  });
  return { close, focus: () => input.focus() };
}
