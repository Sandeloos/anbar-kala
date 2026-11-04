'use strict';
/**
 * In-process event bus. The server-sent events route forwards these to every
 * open browser so lists and the dashboard update live without reloading.
 */
const { EventEmitter } = require('events');

function createEvents() {
  const bus = new EventEmitter();
  bus.setMaxListeners(500);
  return {
    emit(type, data) { bus.emit('event', { type, data, at: new Date().toISOString() }); },
    subscribe(fn) { bus.on('event', fn); return () => bus.off('event', fn); }
  };
}

module.exports = { createEvents };
