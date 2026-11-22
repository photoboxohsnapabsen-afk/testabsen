#!/usr/bin/env node
/**
 * Server pengembangan LOKAL — Oh Snap! Photobox 5 Cabang  (versi aman)
 *
 * PENTING: produksi memakai GitHub Pages + Google Apps Script (Code.gs V5).
 * Server ini hanya untuk uji lokal. Perbaikan keamanan dibanding versi lama:
 *  - hanya melayani isi folder /frontend (sebelumnya SELURUH repo, termasuk database & kode backend)
 *  - mendengarkan 127.0.0.1 saja (ubah lewat HOST=... hanya bila Anda paham risikonya)
 *  - endpoint /api/* (selain /api/health) WAJIB header X-API-Key = env OHSNAP_API_KEY (>= 24 karakter)
 *  - tidak ada CORS "*", batas ukuran body 1 MB, header keamanan, tidak membocorkan error internal
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');
const { handleApiRequest } = require('./routes/api');
const db = require('./config/database');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const STATIC_DIR = path.resolve(__dirname, '..', 'frontend');
const MAX_BODY_BYTES = 1024 * 1024;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin'
};

function apiKeyConfigured() {
  return typeof process.env.OHSNAP_API_KEY === 'string' && process.env.OHSNAP_API_KEY.length >= 24;
}

function apiKeyValid(req) {
  if (!apiKeyConfigured()) return false;
  const given = Buffer.from(String(req.headers['x-api-key'] || ''));
  const want = Buffer.from(process.env.OHSNAP_API_KEY);
  return given.length === want.length && crypto.timingSafeEqual(given, want);
}

function sendJsonRaw(res, status, payload) {
  res.writeHead(status, Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, SECURITY_HEADERS));
  res.end(JSON.stringify(payload));
}

function parseRequestBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Body terlalu besar'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        const parsed = JSON.parse(raw);
        return resolve(parsed && typeof parsed === 'object' ? parsed : {});
      } catch (e) {
        const obj = Object.create(null);
        for (const [k, v] of new URLSearchParams(raw).entries()) obj[k] = v;
        return resolve(obj);
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendJsonRaw(res, 405, { status: 'error', message: 'Method not allowed' });
  let rel;
  try { rel = decodeURIComponent(pathname === '/' ? '/index.html' : pathname); } catch (e) { rel = null; }
  if (!rel || rel.includes('\0')) return sendJsonRaw(res, 400, { status: 'error', message: 'Bad request' });
  const filePath = path.resolve(STATIC_DIR, '.' + rel);
  const insideStatic = filePath === STATIC_DIR || filePath.startsWith(STATIC_DIR + path.sep);
  const hasDotSegment = rel.split('/').some(seg => seg.startsWith('.'));
  const ext = path.extname(filePath).toLowerCase();
  if (!insideStatic || hasDotSegment || !MIME_TYPES[ext] || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    res.writeHead(404, Object.assign({ 'Content-Type': 'text/plain; charset=utf-8' }, SECURITY_HEADERS));
    return res.end('404 Not Found');
  }
  res.writeHead(200, Object.assign({ 'Content-Type': MIME_TYPES[ext], 'Cache-Control': 'no-store' }, SECURITY_HEADERS));
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(filePath).pipe(res);
}

function createAppServer() {
  db.ensureDatabaseInitialized();
  return http.createServer(async (req, res) => {
    try {
      const parsedUrl = new URL(req.url, 'http://localhost');
      if (parsedUrl.pathname.startsWith('/api/')) {
        if (parsedUrl.pathname === '/api/health' && req.method === 'GET') {
          return sendJsonRaw(res, 200, { status: 'ok' });
        }
        if (req.method === 'OPTIONS') {           // tanpa CORS lintas-origin
          res.writeHead(204, SECURITY_HEADERS);
          return res.end();
        }
        if (!apiKeyConfigured()) {
          return sendJsonRaw(res, 503, { status: 'error', message: 'API dinonaktifkan. Set env OHSNAP_API_KEY (min. 24 karakter).' });
        }
        if (!apiKeyValid(req)) {
          return sendJsonRaw(res, 401, { status: 'error', message: 'API key tidak valid.' });
        }
        const bodyObj = await parseRequestBody(req);
        return handleApiRequest(req, res, parsedUrl, bodyObj);
      }
      return serveStatic(req, res, parsedUrl.pathname);
    } catch (err) {
      const status = err && err.statusCode ? err.statusCode : 500;
      if (!res.headersSent) sendJsonRaw(res, status, { status: 'error', message: status === 413 ? 'Body terlalu besar' : 'Terjadi kesalahan pada server.' });
      else res.end();
    }
  });
}

if (require.main === module) {
  const server = createAppServer();
  server.listen(PORT, HOST, () => {
    console.log(`Server pengembangan Oh Snap aktif di http://${HOST}:${PORT}  (API ${apiKeyConfigured() ? 'AKTIF' : 'nonaktif: set OHSNAP_API_KEY'})`);
  });
}

module.exports = { createAppServer };
