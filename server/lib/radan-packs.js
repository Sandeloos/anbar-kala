'use strict';

const ORIGIN = 'https://radiantajhiz.com';
const MAX_BYTES = 2 * 1024 * 1024;
const positiveInteger = (value) => Number.isSafeInteger(value) && value > 0;
const attribute = (tag, name) => new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(tag)?.slice(1).find((value) => value !== undefined);

// Radan's RPQ selector publishes monetary values in toman. Verify the Woo
// reference price in rial independently of the selector's current sale price.
function radanPackEvidence(html, regularRial) {
  if (!positiveInteger(regularRial)) return null;
  let evidence = null;
  for (const [tag] of html.matchAll(/<div\s+(?:"[^"]*"|'[^']*'|[^"'<>])*?>/gi)) {
    if (!attribute(tag, 'class')?.split(/\s+/).includes('rpq-selector')) continue;
    const encoded = attribute(tag, 'data-options');
    let options;
    try { options = JSON.parse(encoded?.replace(/&quot;|&#34;|&#x22;/gi, '"')); } catch { return null; }
    if (!Array.isArray(options) || !options.length || !options.every((o) => o &&
      positiveInteger(o.size) && o.size <= 100000 && positiveInteger(o.unitPrice) &&
      o.refUnit * 10 === regularRial && positiveInteger(o.refUnit) &&
      positiveInteger(o.packPrice) && o.packPrice === o.size * o.unitPrice)) return null;
    const sizes = [...new Set(options.map((o) => o.size))].sort((a, b) => a - b);
    if (evidence && String(evidence.sizes) !== String(sizes)) return null;
    evidence = { price_units: 1, sale_units: sizes.length === 1 ? sizes[0] : null, sizes };
  }
  return evidence;
}

function radanProductUrl(siteUrl, permalink) {
  try {
    const site = new URL(siteUrl);
    const url = new URL(permalink);
    if (site.origin === ORIGIN && url.origin === ORIGIN && !url.username && !url.password &&
        /^\/product\/[^/]+\/?$/.test(url.pathname)) return url.origin + url.pathname;
  } catch { /* Missing or invalid WooCommerce link. */ }
  return null;
}

async function readRadanPack(url, regularRial, fetchPage) {
  try {
    const response = await fetchPage(url, { redirect: 'error', signal: AbortSignal.timeout(5000) });
    if (!response.ok || !response.headers.get('content-type')?.includes('text/html')) {
      await response.body?.cancel();
      return null;
    }
    const decoder = new TextDecoder();
    let html = '', bytes = 0;
    for await (const chunk of response.body) {
      bytes += chunk.byteLength;
      if (bytes > MAX_BYTES) return null;
      html += decoder.decode(chunk, { stream: true });
    }
    return radanPackEvidence(html + decoder.decode(), regularRial);
  } catch { return null; }
}

module.exports = { radanPackEvidence, radanProductUrl, readRadanPack };
