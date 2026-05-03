/**
 * Proxy local para OpenRouter — injeta transforms:[] em cada pedido.
 * Desactiva o Presidio PII redaction que substituía nomes por [PERSON_NAME].
 *
 * Porta: 3003 (127.0.0.1 apenas — não instalado por defeito)
 */
require('dotenv').config();

const http  = require('http');
const https = require('https');

const PORT           = 3002;
const TARGET_HOST    = 'openrouter.ai';
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY;
const SITE_URL       = process.env.SITE_URL || 'https://localhost';
const APP_NAME       = process.env.APP_NAME || 'SerenBot';

if (!OPENROUTER_KEY) {
  console.error('[openrouter-proxy] OPENROUTER_API_KEY não está definido no .env');
  process.exit(1);
}

const server = http.createServer((req, res) => {
  let chunks = [];

  req.on('data', chunk => chunks.push(chunk));

  req.on('end', () => {
    const rawBody = Buffer.concat(chunks);

    let parsed;
    try {
      parsed = JSON.parse(rawBody.toString('utf8'));
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid JSON body' }));
      return;
    }

    // Desactivar todos os transforms do OpenRouter (inclui Presidio PII)
    parsed.transforms = [];

    const newBody    = JSON.stringify(parsed);
    const bodyBuffer = Buffer.from(newBody, 'utf8');

    // Caminho original (ex: /chat/completions ou /v1/chat/completions)
    // O OpenAI SDK envia para /chat/completions quando baseUrl já tem /api/v1
    const targetPath = '/api/v1' + (req.url || '/chat/completions');

    const headers = {
      'content-type':   'application/json',
      'authorization':  `Bearer ${OPENROUTER_KEY}`,
      'http-referer':   SITE_URL,
      'x-title':        APP_NAME,
      'content-length': bodyBuffer.length,
    };

    const proxyReq = https.request({
      hostname: TARGET_HOST,
      port:     443,
      path:     targetPath,
      method:   req.method,
      headers,
    }, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    });

    proxyReq.on('error', (err) => {
      console.error('[openrouter-proxy] Erro ao encaminhar pedido:', err.message);
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'proxy error', detail: err.message }));
      }
    });

    proxyReq.write(bodyBuffer);
    proxyReq.end();
  });

  req.on('error', (err) => {
    console.error('[openrouter-proxy] Erro na request de entrada:', err.message);
  });
});

server.on('error', (err) => {
  console.error('[openrouter-proxy] Erro no servidor:', err.message);
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[openrouter-proxy] A escutar em 127.0.0.1:${PORT} → openrouter.ai`);
});
