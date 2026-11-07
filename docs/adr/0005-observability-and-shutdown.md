# 0005 — Health, metrics and graceful shutdown without extra services

**Status:** accepted (engineering pass)

## Context
The server runs in Iran, often without access to SaaS monitoring. Docker restarts it on updates; a stop in
the middle of a sync or a write must not lose work.

## Decision
- `/health` (process alive) and `/ready` (database reachable, not shutting down) for Docker and Caddy.
- `/metrics` in Prometheus text format from a ~90-line in-process registry (no dependency), off unless
  `METRICS_TOKEN` is set and then bearer-protected. Any Prometheus/Grafana/VictoriaMetrics can scrape it.
- Request ids (`X-Request-Id`, taken from Caddy) on every response and log line; secrets redacted.
- SIGTERM → `/ready` 503 → scheduler stops → running syncs finish (bounded) → SSE streams end → in-flight
  requests complete → WAL checkpoint → exit 0. A second signal exits at once. CI checks the exit code.
- Configuration is validated with zod on start.

## Consequences
- Operable with or without a monitoring stack; nothing leaves the server unless someone scrapes it.
- Metrics are per process and reset on restart (counters), which Prometheus handles natively.
