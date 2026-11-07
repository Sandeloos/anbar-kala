'use strict';
/**
 * In-process event bus. The server-sent events route forwards these to every
 * open browser so lists and the dashboard update live without reloading.
 *
 * emit() inside a database transaction is delivered after COMMIT and dropped on
 * ROLLBACK (db.afterCommit), so an event always describes data that exists.
 * Streams register themselves so a shutdown can end them (the browser reconnects
 * to the new process on its own).
 */
const { EventEmitter } = require('events');

function createEvents({ db } = {}) {
  const bus = new EventEmitter();
  bus.setMaxListeners(1000);
  const streams = new Set();
  const deliver = (e) => bus.emit('event', e);
  return {
    emit(type, data) {
      const e = { type, data, at: new Date().toISOString() };
      if (db) db.afterCommit(() => deliver(e));
      else deliver(e);
    },
    subscribe(fn) { bus.on('event', fn); return () => bus.off('event', fn); },
    /** close: () => void, called on shutdown; returns the function that unregisters it. */
    track(close) { streams.add(close); return () => streams.delete(close); },
    get clients() { return streams.size; },
    closeAll() { for (const close of [...streams]) { try { close(); } catch { /* already gone */ } } streams.clear(); }
  };
}

module.exports = { createEvents };
