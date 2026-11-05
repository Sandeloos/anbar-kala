'use strict';
/**
 * Starts the server (production and `npm start`). On SIGTERM/SIGINT (docker stop, systemd,
 * Ctrl-C) it stops gracefully: no new syncs, the running ones finish, live streams end,
 * requests in flight complete and the database is checkpointed. A second signal, or a stop
 * that takes longer than SHUTDOWN_TIMEOUT_MS + 5 s, exits at once.
 */
const { loadConfig } = require('./config');
const { buildApp } = require('./app');

(async () => {
  const config = loadConfig();
  const app = await buildApp(config);
  await app.listen({ host: config.host, port: config.port });
  app.log.info(`Anbar listening on http://${config.host}:${config.port}`);

  let stopping = false;
  const stop = async (signal) => {
    if (stopping) { app.log.warn(`${signal} again: exiting now`); process.exit(1); }
    stopping = true;
    app.log.info(`${signal}: shutting down`);
    setTimeout(() => { app.log.error('shutdown took too long; exiting'); process.exit(1); }, config.shutdownTimeoutMs + 5000).unref();
    try {
      await app.shutdown();
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, 'shutdown failed');
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('unhandledRejection', (err) => app.log.error({ err }, 'unhandled rejection'));
})().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
