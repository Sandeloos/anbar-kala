'use strict';
/**
 * GET /api/events — server-sent events for the signed-in browser.
 * Types: products (ids that changed), sync (company sync state/progress),
 * company (settings or plugin ping), activity (a new log row), orders, stock, listings, tasks.
 */

module.exports = async function eventRoutes(app) {
  const { events, auth } = app.ctx;

  app.get('/events', async (req, reply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // nginx: do not buffer the stream
      'X-Request-Id': req.id
    });
    res.write('retry: 5000\n\n');
    const send = (e) => {
      res.write(`event: ${e.type}\ndata: ${JSON.stringify(e.data)}\n\n`);
    };
    const unsubscribe = events.subscribe(send);
    let closed = false;
    function cleanup() {
      if (closed) return;
      closed = true;
      clearInterval(ping);
      unsubscribe();
      untrack();
    }
    const end = () => { cleanup(); res.end(); };
    const untrack = events.track(end);
    // Comments keep proxies from closing an idle stream; also notice sign-outs
    const ping = setInterval(() => {
      if (!auth.userFrom(req)) { res.write('event: signedout\ndata: {}\n\n'); end(); return; }
      res.write(': ping\n\n');
    }, 25000);
    req.raw.on('close', cleanup);
  });
};
