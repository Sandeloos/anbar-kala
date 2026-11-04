'use strict';
/** Starts the server (production and `npm start`). */
const { loadConfig } = require('./config');
const { buildApp } = require('./app');

(async () => {
  const config = loadConfig();
  const app = await buildApp(config);
  await app.listen({ host: config.host, port: config.port });
  app.log.info(`Anbar listening on http://${config.host}:${config.port}`);
  const stop = async () => { await app.close(); process.exit(0); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
