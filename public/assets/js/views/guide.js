/** The training page: the rhythm of the work, and the guide of every section the person can use. */
import { esc, icon, toast } from '../ui.js';
import { GUIDES, ROUTINES, guideKey, openGuide, resetSeen } from '../help.js';

export function render(view, ctx) {
  const sections = ctx.sections.filter((s) => !s.manager || ctx.me.role === 'manager');
  const groups = new Map();
  for (const s of sections.filter((x) => !x.hidden && x.path !== 'guide')) {
    if (!groups.has(s.group)) groups.set(s.group, []);
    groups.get(s.group).push(s);
  }
  const subPages = (path) => Object.keys(GUIDES).filter((k) => k.startsWith(`${path}/`));
  view.innerHTML = `
    <div class="page-head">
      <div><h1>آموزش</h1><p>هر بخش انبار چه کاری می‌کند و شما آنجا چه کار باید بکنید. در هر صفحه هم دکمه‌ی «آموزش این بخش» بالای صفحه هست.</p></div>
      <div class="page-actions"><button class="btn" type="button" data-reset>${icon('refresh')}نمایش دوباره‌ی کارت‌های آموزش</button></div>
    </div>
    <div class="grid guide-routines">${ROUTINES.map((r) => `<section class="card guide-card"><h2>${esc(r.title)}</h2>
      <ol class="howto">${r.items.map(([href, text]) => `<li><a class="link" href="${href}">${esc(text)}</a></li>`).join('')}</ol></section>`).join('')}</div>
    ${[...groups].map(([title, items]) => `<section class="card guide-card" aria-label="${esc(title)}"><h2>${esc(title)}</h2>
      <div class="list">${items.map((s) => `<div class="list-item">${icon(s.icon)}<span class="grow"><span class="title">${esc(GUIDES[guideKey(s.path)].title)}</span>
        <span class="sub"><span>${esc(GUIDES[guideKey(s.path)].intro)}</span></span></span>
        <span class="guide-buttons"><button class="btn btn-sm" type="button" data-guide="${s.path}">آموزش</button>
        ${subPages(s.path).map((k) => `<button class="btn btn-sm btn-ghost" type="button" data-guide="${k}">${esc(GUIDES[k].title)}</button>`).join('')}</span></div>`).join('')}</div></section>`).join('')}`;
  view.onclick = (e) => {
    const b = e.target.closest('[data-guide]');
    if (b) return openGuide(b.dataset.guide);
    if (e.target.closest('[data-reset]')) {
      resetSeen(ctx.me.username);
      toast('کارت‌های آموزش در هر بخش دوباره نشان داده می‌شوند.');
    }
  };
}
