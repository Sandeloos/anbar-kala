'use strict';
const { searchKey } = require('./util');

function pricingGroup(product) {
  if (['tools', 'other'].includes(product.pricing_group)) return product.pricing_group;
  const text = searchKey(`${product.category_names || ''} ${product.name || product.product_name || ''}`);
  return /ابزار|انبر|پیچ گوشتی|پیچگوشتی|دریل|فرز|آچار|اچار|چکش|(?:^|\s)اره(?:\s|$)|سیم لخت کن|پرس کابلشو/.test(text) ? 'tools' : 'other';
}
const defaultMultiplier = (product) => pricingGroup(product) === 'tools' ? 1.4 : 1.5;

/** A price-based quantity is a reviewable suggestion, never proof of product identity. */
function priceUnitsSuggestion(variant, product) {
  if (!(product.regular_price > 0) || !(variant.price_sale > 0) || product.packaging_pending) return null;
  const factor = defaultMultiplier(product);
  if (Math.abs(variant.price_sale / product.regular_price - 1) <= 0.2) return { units: product.units_per_pack, multiplier: factor, error_pct: Math.round(Math.abs(variant.price_sale / product.regular_price - 1) * 100), source: 'near_price' };
  const ratio = variant.price_sale * product.units_per_pack / (product.regular_price * factor);
  const candidates = new Set([1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 24, 25, 50, 100, 200, 250, 500, 1000, product.sale_pack_units || product.units_per_pack]);
  const ranked = [...candidates].filter((n) => Number.isInteger(n) && n > 0 && n <= 100000)
    .map((units) => ({ units, error: Math.abs(ratio - units) / units })).sort((a, b) => a.error - b.error);
  const best = ranked[0];
  if (!best || best.error > 0.15) return null;
  return { units: best.units, multiplier: factor, error_pct: Math.round(best.error * 100), source: 'price' };
}
module.exports = { pricingGroup, defaultMultiplier, priceUnitsSuggestion };
