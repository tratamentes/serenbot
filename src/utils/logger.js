const isDev = process.env.NODE_ENV !== 'production';

function timestamp() {
  return new Date().toISOString();
}

const logger = {
  info: (msg, data = '') => console.log(`[${timestamp()}] INFO  ${msg}`, data),
  warn: (msg, data = '') => console.warn(`[${timestamp()}] WARN  ${msg}`, data),
  error: (msg, err = '') => console.error(`[${timestamp()}] ERROR ${msg}`, err?.message || err),
  debug: (msg, data = '') => { if (isDev) console.log(`[${timestamp()}] DEBUG ${msg}`, data); },
};

module.exports = logger;
