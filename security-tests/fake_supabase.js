// Tiruan Supabase Storage API (in-memory) untuk pengujian. Meniru perilaku yang dipakai Code.gs & browser:
//   POST   /storage/v1/object/upload/sign/{bucket}/{path}   (kunci service)  -> {url}
//   PUT    /storage/v1/object/upload/sign/{bucket}/{path}?token=  (apikey)    -> unggah (multipart/raw)
//   POST   /storage/v1/object/{bucket}/{path}                (kunci service)  -> unggah langsung
//   POST   /storage/v1/object/list/{bucket}                  (kunci service)
//   POST   /storage/v1/object/sign/{bucket}/{path}           (kunci service)  -> {signedURL}
//   GET    /storage/v1/object/sign/{bucket}/{path}?token=    (publik+token)   -> berkas
//   GET    /storage/v1/object/public/...                     -> DITOLAK (bucket privat)
//   DELETE /storage/v1/object/{bucket}   {prefixes:[...]}    (kunci service)
const crypto = require('crypto');

class FakeSupabase {
  constructor(opts) {
    this.serviceKey = opts.serviceKey;
    this.anonKey = opts.anonKey;
    this.bucket = opts.bucket || 'ohsnap-photos';
    this.maxBytes = opts.maxBytes || 15 * 1024 * 1024;
    this.objects = new Map();       // path -> Buffer
    this.uploadTokens = new Map();  // token -> path
    this.viewTokens = new Map();    // token -> {path, exp}
    this.log = [];
  }

  static magicOk(buf) {
    if (!buf || buf.length < 4) return false;
    const isJpg = buf[0] === 0xff && buf[1] === 0xd8;
    const isPng = buf[0] === 0x89 && buf[1] === 0x50;
    const isWebp = buf.slice(0, 4).toString() === 'RIFF';
    return isJpg || isPng || isWebp;
  }

  _hasKey(headers) {
    const h = {}; for (const k in headers) h[k.toLowerCase()] = headers[k];
    const key = h['apikey'] || '';
    const bearer = (h['authorization'] || '').replace(/^Bearer\s+/i, '');
    return { key, bearer, ok: key === this.serviceKey || key === this.anonKey };
  }

  _isService(headers) {
    const k = this._hasKey(headers);
    return k.key === this.serviceKey && (!k.bearer || k.bearer === this.serviceKey);
  }

  static parseMultipart(body, contentType) {
    const m = /boundary=(.+)$/i.exec(contentType || '');
    if (!m) return null;
    const boundary = Buffer.from('--' + m[1]);
    const parts = [];
    let idx = body.indexOf(boundary);
    while (idx !== -1) {
      const next = body.indexOf(boundary, idx + boundary.length);
      if (next === -1) break;
      const part = body.slice(idx + boundary.length + 2, next - 2); // buang \r\n di awal & akhir
      const sep = part.indexOf('\r\n\r\n');
      if (sep !== -1) parts.push({ head: part.slice(0, sep).toString(), data: part.slice(sep + 4) });
      idx = next;
    }
    // berkas = bagian bernama "" (seperti supabase-js) atau yang punya filename
    const filePart = parts.find(p => /name=""/.test(p.head) || /filename=/.test(p.head));
    return filePart ? filePart.data : null;
  }

  // req: { method, path (mulai /storage/v1/...), query (URLSearchParams), headers, body (Buffer) }
  handle(req) {
    const method = req.method.toUpperCase();
    const full = req.path;
    this.log.push(method + ' ' + full);
    const rest = full.replace(/^\/storage\/v1/, '');
    const q = req.query || new URLSearchParams();
    const json = (code, obj) => ({ status: code, headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify(obj)) });
    const bodyText = () => (req.body ? req.body.toString('utf8') : '');
    const dec = (s) => s.split('/').map(decodeURIComponent).join('/');

    // ---- unduh lewat URL bertanda tangan (publik + token)
    let m = /^\/object\/sign\/([^/]+)\/(.+)$/.exec(rest);
    if (m && method === 'GET') {
      const t = this.viewTokens.get(q.get('token') || '');
      const p = dec(m[2]);
      if (!t || t.path !== p || t.exp < Date.now()) return json(400, { error: 'invalid signature' });
      const data = this.objects.get(p);
      if (!data) return json(404, { error: 'not found' });
      return { status: 200, headers: { 'content-type': 'image/jpeg', 'access-control-allow-origin': '*' }, body: data };
    }
    if (/^\/object\/public\//.test(rest)) return json(400, { error: 'Bucket not found' });   // bucket privat

    // ---- unggah lewat URL bertanda tangan (apikey + token)
    m = /^\/object\/upload\/sign\/([^/]+)\/(.+)$/.exec(rest);
    if (m && method === 'PUT') {
      if (!this._hasKey(req.headers).ok) return json(401, { error: 'No API key found in request' });
      const p = dec(m[2]);
      const tokPath = this.uploadTokens.get(q.get('token') || '');
      if (!tokPath || tokPath !== p) return json(403, { error: 'Invalid token' });
      const ct = Object.keys(req.headers).reduce((a, k) => (k.toLowerCase() === 'content-type' ? req.headers[k] : a), '');
      const data = /multipart\/form-data/i.test(ct) ? FakeSupabase.parseMultipart(req.body, ct) : req.body;
      if (!data || !data.length) return json(400, { error: 'empty file' });
      if (data.length > this.maxBytes) return json(413, { error: 'The object exceeded the maximum allowed size' });
      if (!FakeSupabase.magicOk(data)) return json(415, { error: 'mime type not supported' });
      if (this.objects.has(p)) return json(409, { error: 'The resource already exists' });
      this.objects.set(p, Buffer.from(data));
      this.uploadTokens.delete(q.get('token'));
      return json(200, { Key: m[1] + '/' + p });
    }

    // ---- sisanya wajib kunci SERVICE
    if (!this._isService(req.headers)) return json(401, { error: 'Unauthorized' });

    m = /^\/object\/upload\/sign\/([^/]+)\/(.+)$/.exec(rest);
    if (m && method === 'POST') {
      const p = dec(m[2]);
      const token = crypto.randomBytes(12).toString('hex');
      this.uploadTokens.set(token, p);
      return json(200, { url: `/object/upload/sign/${m[1]}/${m[2]}?token=${token}` });
    }
    m = /^\/object\/sign\/([^/]+)\/(.+)$/.exec(rest);
    if (m && method === 'POST') {
      const p = dec(m[2]);
      const exp = Number(JSON.parse(bodyText() || '{}').expiresIn || 60);
      const token = crypto.randomBytes(12).toString('hex');
      this.viewTokens.set(token, { path: p, exp: Date.now() + exp * 1000 });
      return json(200, { signedURL: `/object/sign/${m[1]}/${m[2]}?token=${token}` });
    }
    m = /^\/object\/list\/([^/]+)$/.exec(rest);
    if (m && method === 'POST') {
      const b = JSON.parse(bodyText() || '{}');
      const prefix = (b.prefix || '').replace(/\/$/, '');
      const out = [];
      for (const k of this.objects.keys()) {
        if (!k.startsWith(prefix + '/')) continue;
        const name = k.slice(prefix.length + 1);
        if (name.includes('/')) continue;
        if (b.search && !name.includes(b.search)) continue;
        out.push({ name, id: crypto.randomUUID(), metadata: { size: this.objects.get(k).length } });
      }
      return json(200, out.slice(0, b.limit || 100));
    }
    m = /^\/object\/([^/]+)\/(.+)$/.exec(rest);
    if (m && method === 'POST') {            // unggah langsung (raw)
      const p = dec(m[2]);
      if (!FakeSupabase.magicOk(req.body)) return json(415, { error: 'mime type not supported' });
      this.objects.set(p, Buffer.from(req.body));
      return json(200, { Key: m[1] + '/' + p });
    }
    m = /^\/object\/([^/]+)$/.exec(rest);
    if (m && method === 'DELETE') {
      const prefixes = JSON.parse(bodyText() || '{}').prefixes || [];
      const removed = [];
      for (const p of prefixes) if (this.objects.delete(p)) removed.push({ name: p });
      return json(200, removed);
    }
    return json(404, { error: 'route not found: ' + method + ' ' + rest });
  }
}

module.exports = { FakeSupabase };
