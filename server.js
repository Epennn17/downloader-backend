'use strict';

/**
 * Minimal Downloader Backend (Vercel ready)
 *
 * USER → POST /api/download → server.js → API Clutch (dengan API key) → server.js → USER
 *
 * API key HANYA dari process.env.CLUTCH_API_KEY (di-set di Vercel Dashboard).
 */

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const axios = require('axios');
const crypto = require('crypto');

// ---------- ENV ----------
const ENV = {
  NODE_ENV: process.env.NODE_ENV || 'production',
  PORT: parseInt(process.env.PORT || '3000', 10),

  CLUTCH_API_KEY: process.env.CLUTCH_API_KEY || '',
  CLUTCH_API_URL: process.env.CLUTCH_API_URL || 'https://api.clutch.web.id/download/aio',

  REQUEST_TIMEOUT_MS: parseInt(process.env.REQUEST_TIMEOUT_MS || '30000', 10),

  RATE_LIMIT_WINDOW_MS: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000', 10),
  RATE_LIMIT_MAX: parseInt(process.env.RATE_LIMIT_MAX || '100', 10),

  ALLOWED_ORIGINS: (process.env.ALLOWED_ORIGINS || '*')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  JSON_BODY_LIMIT: process.env.JSON_BODY_LIMIT || '10kb',
};

const IS_PROD = ENV.NODE_ENV === 'production';

// ---------- LOGGER (scrub API key) ----------
function scrub(str) {
  if (typeof str !== 'string') return str;
  return str
    .replace(/apikey=[^&\s"]+/gi, 'apikey=[REDACTED]')
    .replace(/"apikey"\s*:\s*"[^"]+"/gi, '"apikey":"[REDACTED]"');
}

function log(level, msg, meta) {
  const ts = new Date().toISOString();
  let line = `[${ts}] [${level}] ${scrub(msg)}`;
  if (meta) {
    try {
      line += ' ' + scrub(JSON.stringify(meta));
    } catch {
      line += ' [unserializable]';
    }
  }
  if (level === 'ERROR') console.error(line);
  else if (level === 'WARN') console.warn(line);
  else console.log(line);
}

const logger = {
  info: (m, x) => log('INFO', m, x),
  warn: (m, x) => log('WARN', m, x),
  error: (m, x) => log('ERROR', m, x),
  debug: (m, x) => {
    if (!IS_PROD) log('DEBUG', m, x);
  },
};

// ---------- IN-FLIGHT DEDUP ----------
const inflight = new Map();
function runInflight(key, fn) {
  if (inflight.has(key)) return inflight.get(key);
  const p = Promise.resolve()
    .then(fn)
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

// ---------- AXIOS ----------
const http = axios.create({
  timeout: ENV.REQUEST_TIMEOUT_MS,
  validateStatus: () => true,
  headers: {
    'User-Agent': 'downloader-backend/1.0',
    Accept: 'application/json',
  },
});

http.interceptors.response.use(
  (res) => res,
  (error) => {
    if (error && error.config) {
      if (error.config.params && error.config.params.apikey) {
        error.config.params.apikey = '[REDACTED]';
      }
      if (error.config.url) {
        error.config.url = String(error.config.url).replace(
          /apikey=[^&]+/gi,
          'apikey=[REDACTED]'
        );
      }
    }
    return Promise.reject(error);
  }
);

// ---------- ERROR HELPER ----------
function AppError(code, message, status = 400) {
  const e = new Error(message);
  e.isApp = true;
  e.code = code;
  e.status = status;
  return e;
}

// ---------- URL VALIDATION ----------
const MAX_URL_LENGTH = 2048;

function isValidHttpUrl(value) {
  if (typeof value !== 'string') return false;
  if (value.length === 0 || value.length > MAX_URL_LENGTH) return false;
  let u;
  try {
    u = new URL(value);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  if (!u.hostname) return false;
  return true;
}

// ---------- NORMALIZER ----------
function normalizeMediaItem(item, fallbackThumb) {
  if (!item) return null;
  if (typeof item === 'string') {
    return {
      url: item,
      type: 'unknown',
      quality: null,
      resolution: null,
      format: null,
      thumbnail: fallbackThumb || null,
    };
  }
  const url = item.url || item.download_url || item.link;
  if (!url) return null;
  return {
    url: String(url),
    type: String(item.type || item.media_type || 'unknown').toLowerCase(),
    quality: item.quality || item.label || null,
    resolution: item.resolution || item.size || null,
    format: item.format || item.extension || item.ext || null,
    thumbnail: item.thumbnail || item.cover || item.poster || fallbackThumb || null,
  };
}

function extractMedias(data) {
  if (!data || typeof data !== 'object') return [];
  const fallbackThumb =
    data.thumbnail || data.cover || data.poster || (data.data && data.data.thumbnail) || null;

  const candidates =
    (Array.isArray(data.medias) && data.medias) ||
    (Array.isArray(data.media) && data.media) ||
    (Array.isArray(data.data) && data.data) ||
    (data.data && Array.isArray(data.data.medias) && data.data.medias) ||
    (data.data && Array.isArray(data.data.media) && data.data.media) ||
    null;

  if (!candidates) return [];
  return candidates.map((it) => normalizeMediaItem(it, fallbackThumb)).filter(Boolean);
}

function normalizeResult(raw) {
  const base =
    raw && raw.data && typeof raw.data === 'object' ? { ...raw.data, ...raw } : raw || {};

  const thumbnail = base.thumbnail || base.cover || base.poster || null;
  const medias = extractMedias(base);

  return {
    source: base.source || base.platform || base.provider || 'unknown',
    author: base.author || base.username || base.uploader || null,
    title: base.title || base.description || base.caption || null,
    thumbnail: thumbnail ? String(thumbnail) : null,
    duration: typeof base.duration === 'number' ? base.duration : null,
    type:
      base.type ||
      (medias.length > 1 ? 'multiple' : medias.length === 1 ? 'single' : 'unknown'),
    medias,
  };
}

// ---------- CLUTCH FETCH ----------
async function fetchFromClutch(url) {
  if (!ENV.CLUTCH_API_KEY) {
    throw AppError('SERVER_MISCONFIGURED', 'Konfigurasi server belum lengkap.', 500);
  }

  let response;
  try {
    response = await http.get(ENV.CLUTCH_API_URL, {
      params: {
        apikey: ENV.CLUTCH_API_KEY,
        url,
      },
    });
  } catch (e) {
    if (e && (e.code === 'ECONNABORTED' || e.code === 'ETIMEDOUT')) {
      throw AppError(
        'UPSTREAM_TIMEOUT',
        'Server downloader sedang membutuhkan waktu terlalu lama.',
        504
      );
    }
    logger.warn('Clutch network error', { code: e && e.code });
    throw AppError('UPSTREAM_UNREACHABLE', 'Gagal menghubungi server downloader.', 502);
  }

  if (response.status < 200 || response.status >= 300) {
    logger.warn('Clutch non-2xx', { status: response.status });
    throw AppError('UPSTREAM_ERROR', 'Server downloader mengembalikan error.', 502);
  }

  const data = response.data;

  if (data && typeof data === 'object' && data.status === false) {
    const msg =
      (data.error && (data.error.message || data.message)) ||
      data.message ||
      'Gagal memproses URL.';
    throw AppError('UPSTREAM_REJECTED', String(msg).slice(0, 300), 400);
  }

  return data;
}

// ---------- DOWNLOAD PIPELINE ----------
function keyForUrl(url) {
  return crypto.createHash('sha256').update(url).digest('hex');
}

async function processDownload(url) {
  const key = keyForUrl(url);
  return runInflight(key, async () => {
    const raw = await fetchFromClutch(url);
    return normalizeResult(raw);
  });
}

// ---------- EXPRESS APP ----------
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use(helmet());
app.use(
  cors({
    origin(origin, cb) {
      if (!origin) return cb(null, true);
      if (ENV.ALLOWED_ORIGINS.includes('*')) return cb(null, true);
      if (ENV.ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
      if (!IS_PROD && /^https?:\/\/localhost(:\d+)?$/.test(origin)) return cb(null, true);
      return cb(null, false);
    },
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'X-Request-ID'],
    exposedHeaders: ['X-Request-ID'],
    credentials: false,
    maxAge: 86400,
  })
);

// Request ID
app.use((req, res, next) => {
  const incoming = req.get('X-Request-ID');
  const id =
    incoming && typeof incoming === 'string' && incoming.length <= 128
      ? incoming
      : crypto.randomUUID();
  req.id = id;
  res.setHeader('X-Request-ID', id);
  next();
});

// Access log
app.use((req, res, next) => {
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    logger.info('HTTP', {
      requestId: req.id,
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      durationMs: Math.round(ms * 100) / 100,
    });
  });
  next();
});

app.use(express.json({ limit: ENV.JSON_BODY_LIMIT }));

// Rate limit /api/download
const downloadLimiter = rateLimit({
  windowMs: ENV.RATE_LIMIT_WINDOW_MS,
  max: ENV.RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    res.status(429).json({
      status: false,
      error: {
        code: 'RATE_LIMITED',
        message: 'Terlalu banyak request. Silakan coba lagi nanti.',
      },
    });
  },
});

// ---------- ROUTES ----------
app.get('/api/health', (req, res) => {
  res.json({
    status: true,
    service: 'downloader-api',
    timestamp: new Date().toISOString(),
  });
});

app.post('/api/download', downloadLimiter, async (req, res, next) => {
  try {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw AppError('INVALID_BODY', 'Body request tidak valid.', 400);
    }

    const { url } = body;

    if (url === undefined || url === null || url === '') {
      throw AppError('INVALID_URL', 'URL tidak valid', 400);
    }
    if (typeof url !== 'string') {
      throw AppError('INVALID_URL', 'URL tidak valid', 400);
    }
    const trimmed = url.trim();
    if (trimmed.length === 0) {
      throw AppError('INVALID_URL', 'URL tidak valid', 400);
    }
    if (trimmed.length > MAX_URL_LENGTH) {
      throw AppError('URL_TOO_LONG', 'URL terlalu panjang', 400);
    }
    if (!isValidHttpUrl(trimmed)) {
      throw AppError('INVALID_URL', 'URL tidak valid', 400);
    }

    const data = await processDownload(trimmed);

    logger.info('Download success', {
      requestId: req.id,
      source: data.source,
      medias: data.medias.length,
    });

    res.json({ status: true, data });
  } catch (err) {
    next(err);
  }
});

// 404
app.use((req, res) => {
  res.status(404).json({
    status: false,
    error: { code: 'NOT_FOUND', message: 'Endpoint tidak ditemukan.' },
  });
});

// Centralized error handler
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  let status = 500;
  let code = 'INTERNAL_ERROR';
  let message = 'Terjadi kesalahan pada server.';

  if (err && err.isApp) {
    status = err.status;
    code = err.code;
    message = err.message;
  } else if (err && err.type === 'entity.parse.failed') {
    status = 400;
    code = 'INVALID_JSON';
    message = 'Body request bukan JSON yang valid.';
  } else if (err && err.type === 'entity.too.large') {
    status = 413;
    code = 'PAYLOAD_TOO_LARGE';
    message = 'Ukuran body request terlalu besar.';
  }

  const meta = {
    requestId: req.id,
    method: req.method,
    path: req.originalUrl,
    status,
    code,
  };

  if (status >= 500) logger.error(message, meta);
  else logger.warn(message, meta);

  res.status(status).json({ status: false, error: { code, message } });
});

// ---------- LISTEN ----------
if (require.main === module) {
  const server = app.listen(ENV.PORT, () => {
    logger.info('Server listening', { port: ENV.PORT, env: ENV.NODE_ENV });
  });

  const shutdown = (sig) => {
    logger.warn(`Received ${sig}, shutting down...`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

module.exports = app;