'use strict';
/**
 * A tiny in-process metrics registry in the Prometheus text format (no dependency).
 * Counters and histograms are updated by the app; gauges are read when /metrics is scraped.
 * Exposed at GET /metrics, only with `Authorization: Bearer <METRICS_TOKEN>`.
 */

const DEFAULT_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

function labelKey(labels = {}) {
  const keys = Object.keys(labels).sort();
  return keys.map((k) => `${k}="${String(labels[k]).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ')}"`).join(',');
}

function createMetrics() {
  const help = new Map();
  const counters = new Map();   // name → Map(labelKey → value)
  const histograms = new Map(); // name → { buckets, series: Map(labelKey → { counts, sum, count }) }
  const gauges = new Map();     // name → () => [{ labels, value }]

  function describe(name, type, text) { help.set(name, { type, text }); }

  function inc(name, labels, by = 1) {
    if (!counters.has(name)) counters.set(name, new Map());
    const m = counters.get(name);
    const k = labelKey(labels);
    m.set(k, (m.get(k) || 0) + by);
  }

  function observe(name, labels, value, buckets = DEFAULT_BUCKETS) {
    if (!histograms.has(name)) histograms.set(name, { buckets, series: new Map() });
    const h = histograms.get(name);
    const k = labelKey(labels);
    let s = h.series.get(k);
    if (!s) { s = { counts: h.buckets.map(() => 0), sum: 0, count: 0 }; h.series.set(k, s); }
    h.buckets.forEach((b, i) => { if (value <= b) s.counts[i]++; });
    s.sum += value;
    s.count++;
  }

  /** fn returns a number or [{ labels, value }] each time metrics are scraped. */
  function gauge(name, text, fn) {
    describe(name, 'gauge', text);
    gauges.set(name, fn);
  }

  function render() {
    const out = [];
    const head = (name, fallbackType) => {
      const h = help.get(name);
      out.push(`# HELP ${name} ${h ? h.text : name}`);
      out.push(`# TYPE ${name} ${h ? h.type : fallbackType}`);
    };
    for (const [name, m] of counters) {
      head(name, 'counter');
      for (const [k, v] of m) out.push(`${name}${k ? `{${k}}` : ''} ${v}`);
    }
    for (const [name, h] of histograms) {
      head(name, 'histogram');
      for (const [k, s] of h.series) {
        const sep = k ? ',' : '';
        h.buckets.forEach((b, i) => out.push(`${name}_bucket{${k}${sep}le="${b}"} ${s.counts[i]}`));
        out.push(`${name}_bucket{${k}${sep}le="+Inf"} ${s.count}`);
        out.push(`${name}_sum${k ? `{${k}}` : ''} ${s.sum}`);
        out.push(`${name}_count${k ? `{${k}}` : ''} ${s.count}`);
      }
    }
    for (const [name, fn] of gauges) {
      let v;
      try { v = fn(); } catch { continue; }
      head(name, 'gauge');
      if (typeof v === 'number') out.push(`${name} ${v}`);
      else for (const g of v || []) out.push(`${name}${labelKey(g.labels) ? `{${labelKey(g.labels)}}` : ''} ${g.value}`);
    }
    return out.join('\n') + '\n';
  }

  describe('anbar_http_requests_total', 'counter', 'HTTP requests by method, route and status');
  describe('anbar_http_request_duration_seconds', 'histogram', 'HTTP request duration by method and route');
  describe('anbar_sync_runs_total', 'counter', 'WooCommerce sync runs by kind and result');
  describe('anbar_sync_duration_seconds', 'histogram', 'WooCommerce sync run duration by kind');
  describe('anbar_woo_requests_total', 'counter', 'Requests to company sites by outcome');
  describe('anbar_webhooks_total', 'counter', 'Plugin pushes by result');

  return { inc, observe, gauge, describe, render };
}

module.exports = { createMetrics, labelKey };
