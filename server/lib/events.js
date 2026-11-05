'use strict';
/**
 * In-process event bus. The server-sent events route forwards these to every
 * open browser so lists and the dashboard update live without reloading.
 * Streams register themselves so a shutdown can end them (the browser reconnects
 * to the new process on its own).
 */
const { EventEmitter } = require('events');

function createEvents() {
  const bus = new EventEmitter();
  bus.setMaxListeners(1000);
  const streams = new Set();
  return {
    emit(type, data) { bus.emit('event', { type, data, at: new Date().toISOString() }); },
    subscribe(fn) { bus.on('event', fn); return () => bus.off('event', fn); },
    /** close: () => void, called on shutdown; returns the function that unregisters it. */
    track(close) { streams.add(close); return () => streams.delete(close); },
    get clients() { return streams.size; },
    closeAll() { for (const close of [...streams]) { try { close(); } catch { /* already gone */ } } streams.clear(); }
  };
}

module.exports = { createEvents };
