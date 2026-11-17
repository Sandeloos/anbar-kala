'use strict';
const { decodeEntities } = require('./sync');
const plain = (value) => decodeEntities(String(value || '').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim().slice(0, 20000);

/** Read structured product copy from the canonical public product page, never a seller-supplied URL. */
async function readProductDescription(id, fetchImpl = globalThis.fetch) {
  if (!Number.isSafeInteger(Number(id)) || Number(id) < 1) return '';
  const response = await fetchImpl(`https://www.digikala.com/product/dkp-${Number(id)}/`, { signal: AbortSignal.timeout(5000), redirect: 'follow' });
  if (!response.ok) return '';
  const reader = response.body?.getReader();
  let html = '';
  if (reader) {
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        html += decoder.decode(value, { stream: true });
        if (html.length > 2e6) break;
      }
    } finally { await reader.cancel(); }
  } else html = (await response.text()).slice(0, 2e6);
  const found = [];
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(visit);
    if ([node['@type']].flat().includes('Product') && node.description) found.push(plain(node.description));
    if (node['@graph']) visit(node['@graph']);
  };
  for (const match of html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try { visit(JSON.parse(match[1])); } catch { /* Some pages include malformed structured data. */ }
  }
  return found.join(' ').slice(0, 20000);
}
module.exports = { plain, readProductDescription };
