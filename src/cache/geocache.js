/**
 * Cache de geocoding com backend configurável.
 *
 * Configurar em .env:
 *   GEOCACHE_BACKEND=sqlite   # memory | json | sqlite  (default: sqlite)
 *   GEOCACHE_FILE=./data/geocache.db   # caminho para sqlite ou json
 *
 * Interface comum (todos os backends):
 *   cache.get(address)  → { lat, lon, display } | null
 *   cache.set(address, { lat, lon, display })
 *   cache.size()        → número de entradas
 *   cache.close()       → liberta recursos (SQLite fecha a ligação)
 */

const path = require('path');
const fs   = require('fs');
const logger = require('../utils/logger');

const BACKEND  = (process.env.GEOCACHE_BACKEND || 'sqlite').toLowerCase();
const FILEPATH = process.env.GEOCACHE_FILE
  ? path.resolve(process.env.GEOCACHE_FILE)
  : path.resolve(__dirname, '../../data/geocache.' + (BACKEND === 'json' ? 'json' : 'db'));

const TTL_DAYS = 90; // entradas mais antigas que isto são descartadas

// ─── BACKEND: MEMÓRIA ─────────────────────────────────────────────────────────

function createMemoryBackend() {
  const store = new Map();
  return {
    get(key) {
      const entry = store.get(key);
      if (!entry) return null;
      if (Date.now() - entry.ts > TTL_DAYS * 86400000) { store.delete(key); return null; }
      return { lat: entry.lat, lon: entry.lon, display: entry.display };
    },
    set(key, { lat, lon, display }) {
      store.set(key, { lat, lon, display, ts: Date.now() });
    },
    size() { return store.size; },
    close() {},
  };
}

// ─── BACKEND: JSON ────────────────────────────────────────────────────────────

function createJsonBackend(filepath) {
  let store = {};

  // Carrega ficheiro existente
  if (fs.existsSync(filepath)) {
    try {
      store = JSON.parse(fs.readFileSync(filepath, 'utf8'));
      logger.debug(`Geocache JSON carregada: ${Object.keys(store).length} entradas`);
    } catch {
      logger.warn('Geocache JSON corrompida — a começar do zero');
      store = {};
    }
  }

  // Remove entradas expiradas no arranque
  const cutoff = Date.now() - TTL_DAYS * 86400000;
  for (const k of Object.keys(store)) {
    if (store[k].ts < cutoff) delete store[k];
  }

  function save() {
    fs.mkdirSync(path.dirname(filepath), { recursive: true });
    fs.writeFileSync(filepath, JSON.stringify(store), 'utf8');
  }

  return {
    get(key) {
      const entry = store[key];
      if (!entry) return null;
      if (Date.now() - entry.ts > TTL_DAYS * 86400000) { delete store[key]; save(); return null; }
      return { lat: entry.lat, lon: entry.lon, display: entry.display };
    },
    set(key, { lat, lon, display }) {
      store[key] = { lat, lon, display, ts: Date.now() };
      save();
    },
    size() { return Object.keys(store).length; },
    close() { save(); },
  };
}

// ─── BACKEND: SQLITE ──────────────────────────────────────────────────────────

function createSqliteBackend(filepath) {
  let db;
  try {
    const Database = require('better-sqlite3');
    fs.mkdirSync(path.dirname(filepath), { recursive: true });
    db = new Database(filepath);

    db.exec(`
      CREATE TABLE IF NOT EXISTS geocache (
        key      TEXT PRIMARY KEY,
        lat      REAL NOT NULL,
        lon      REAL NOT NULL,
        display  TEXT NOT NULL,
        ts       INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS geocache_ts ON geocache(ts);
    `);

    // Limpar entradas expiradas no arranque
    const cutoff = Date.now() - TTL_DAYS * 86400 * 1000;
    const deleted = db.prepare('DELETE FROM geocache WHERE ts < ?').run(cutoff);
    if (deleted.changes > 0) logger.debug(`Geocache SQLite: ${deleted.changes} entradas expiradas removidas`);

    const count = db.prepare('SELECT COUNT(*) as n FROM geocache').get();
    logger.debug(`Geocache SQLite carregada: ${count.n} entradas (${filepath})`);

  } catch (err) {
    logger.error('Geocache SQLite: falha ao iniciar', err.message);
    const fallback = createMemoryBackend();
    fallback._isMemoryFallback = true;
    return fallback;
  }

  const stmtGet = db.prepare('SELECT lat, lon, display, ts FROM geocache WHERE key = ?');
  const stmtSet = db.prepare('INSERT OR REPLACE INTO geocache (key, lat, lon, display, ts) VALUES (?, ?, ?, ?, ?)');

  return {
    get(key) {
      const row = stmtGet.get(key);
      if (!row) return null;
      if (Date.now() - row.ts > TTL_DAYS * 86400000) {
        db.prepare('DELETE FROM geocache WHERE key = ?').run(key);
        return null;
      }
      return { lat: row.lat, lon: row.lon, display: row.display };
    },
    set(key, { lat, lon, display }) {
      stmtSet.run(key, lat, lon, display, Date.now());
    },
    size() {
      return db.prepare('SELECT COUNT(*) as n FROM geocache').get().n;
    },
    close() { db.close(); },
  };
}

// ─── FACTORY (SQLite → JSON → memory) ────────────────────────────────────────
//
// Cascade de fallback automático:
//   1. Tenta o backend configurado (default: sqlite)
//   2. Se sqlite falhar → tenta json no mesmo directório
//   3. Se json também falhar → usa memória e avisa nos logs
//
// O SQLite já faz internamente try/catch e devolve createMemoryBackend() se
// better-sqlite3 não estiver disponível. Aqui tratamos os outros casos.

function createCache() {
  switch (BACKEND) {
    case 'memory':
      logger.info('Geocache: memória (não persiste entre restarts)');
      return createMemoryBackend();

    case 'json': {
      logger.info(`Geocache: JSON (${FILEPATH})`);
      try {
        return createJsonBackend(FILEPATH);
      } catch (err) {
        logger.warn(`Geocache JSON falhou (${err.message}) → memória`);
        return createMemoryBackend();
      }
    }

    case 'sqlite':
    default: {
      logger.info(`Geocache: SQLite (${FILEPATH})`);
      const sqliteBackend = createSqliteBackend(FILEPATH);

      // createSqliteBackend já faz fallback para memória internamente se
      // better-sqlite3 falhar. Detectamos isso pelo size() ser uma função Map.
      // Se isso acontecer, tentamos JSON como passo intermédio.
      if (sqliteBackend._isMemoryFallback) {
        const jsonPath = FILEPATH.replace(/\.db$/, '.json');
        logger.warn(`SQLite indisponível → a tentar JSON (${jsonPath})`);
        try {
          return createJsonBackend(jsonPath);
        } catch (err) {
          logger.warn(`JSON também falhou (${err.message}) → memória`);
          return createMemoryBackend();
        }
      }

      return sqliteBackend;
    }
  }
}

module.exports = createCache();
