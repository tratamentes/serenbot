/**
 * HTTP client baseado em fetch nativo (Node 18+).
 * Substitui axios — zero dependências externas, zero superfície de CVE.
 *
 * API:
 *   const client = createClient(baseUrl, defaultHeaders, timeoutMs)
 *   client.get(path, { params, headers, timeout })
 *   client.post(path, body, { headers, timeout })
 *   client.patch(path, body, { headers, timeout })
 *   client.delete(path, { headers, timeout })
 *
 * Em caso de resposta não-2xx lança erro com:
 *   err.status          — código HTTP
 *   err.response.data   — corpo da resposta (parsed JSON ou string)
 */

const logger = require('./logger');

function serializeParams(params) {
  return Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${encodeURIComponent(k)}=${String(v).split(',').map(encodeURIComponent).join(',')}`)
    .join('&');
}

function createClient(baseUrl, defaultHeaders = {}, defaultTimeout = 15000) {
  const base = baseUrl.replace(/\/$/, '');

  async function request(path, { method = 'GET', headers = {}, body, params, timeout } = {}) {
    let url = path.startsWith('http') ? path : `${base}/${path.replace(/^\//, '')}`;
    if (params && Object.keys(params).length) {
      url += (url.includes('?') ? '&' : '?') + serializeParams(params);
    }

    const controller = new AbortController();
    const ms = timeout ?? defaultTimeout;
    const timer = setTimeout(() => controller.abort(), ms);
    const start = Date.now();

    try {
      const res = await fetch(url, {
        method,
        headers: {
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...defaultHeaders,
          ...headers,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      const duration = Date.now() - start;
      const text = await res.text();
      let data;
      try { data = JSON.parse(text); } catch { data = text; }

      if (!res.ok) {
        logger.warn(`[HTTP] ${method} ${url} -> ${res.status} (${duration}ms)`, {
          error: data,
          body: body ? '[REDACTED]' : null
        });
        const err = new Error(`HTTP ${res.status}`);
        err.status   = res.status;
        err.response = { status: res.status, data };
        throw err;
      }

      logger.debug(`[HTTP] ${method} ${url} -> ${res.status} (${duration}ms)`);
      return { data, status: res.status };

    } catch (err) {
      const duration = Date.now() - start;
      if (err.name === 'AbortError') {
        logger.error(`[HTTP] TIMEOUT ${method} ${url} (${ms}ms)`);
        const e = new Error(`Timeout após ${ms}ms: ${url}`);
        e.code = 'TIMEOUT';
        throw e;
      }
      logger.error(`[HTTP] FALHA ${method} ${url} (${duration}ms): ${err.message}`);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    get:    (path, opts = {})       => request(path, { ...opts, method: 'GET' }),
    post:   (path, body, opts = {}) => request(path, { ...opts, method: 'POST', body }),
    patch:  (path, body, opts = {}) => request(path, { ...opts, method: 'PATCH', body }),
    delete: (path, opts = {})       => request(path, { ...opts, method: 'DELETE' }),
  };
}

module.exports = { createClient };
