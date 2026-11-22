// ============================================================================
// GOOGLE APPS SCRIPT (Code.gs) — OH SNAP! PHOTOBOX (MULTI-CABANG & CLOUD SYNC V4)
// FITUR UTAMA:
// 1. SINKRONISASI CLOUD OTOMATIS KE SEMUA DEVICE (WEB ADMIN <-> SEMUA HP KRU):
//    - Semua perubahan di Web Admin (Tambah/Hapus Cabang, Kru & Password, Jam Kerja,
//      Edit UI Menu & Slot Foto, Katalog Stok Opname, Stok Cabang, Link Spreadsheet)
//      otomatis tersimpan di Cloud Google (Chunked Properties + File JSON Drive)
//      tanpa batas ukuran 9KB dan langsung sinkron ke seluruh HP kru & device lain!
// 2. OTOMATIS BUAT SPREADSHEET 8 SHEET & FOLDER DRIVE SAAT TAMBAH CABANG BARU:
//    - Saat Admin menambah cabang baru di Web Admin, script ini otomatis membuat
//      file Google Spreadsheet baru (OhSnap_Spreadsheet_Cabang_<NamaCabang>)
//      lengkap dengan 8 Sheet (Absen_Masuk, Absen_Keluar, Laporan_Harian,
//      Rekap_Pengeluaran, Stock_Opname, Barang_Datang, open_Store, Close_Store)
//      serta subfolder foto Cabang_<NamaCabang> di Google Drive!
// 3. PROTEKSI ANTI KLIK 2X (SERVER-SIDE DEDUPLICATION)
// ============================================================================

var SPREADSHEET_ID_PUSAT = '1YuG4fd5DzIbgye0i7DzTzugqtj_rDlap5-6a4qizLik';
var FOLDER_ABSEN_ID = '1YPsH4RmsrfPdqFZUN5A2vmszt_ZyKvUH';
var FOLDER_ABSEN_NAMA = 'Oh Snap 5 Cabang - Pusat Folder Foto Laporan & Spreadsheet';
var CLOUD_CONFIG_FILENAME = 'OhSnap_Cloud_Config_Pusat.json';

var REPORT_PHOTO_FOLDER_NAMES = {
  'ABSEN_MASUK':   'Folder_Absensi',
  'ABSEN_PULANG':  'Folder_Absensi',
  'ABSENSI':       'Folder_Absensi',
  'SERAH_TERIMA':  'Folder_Pemasukan_Laporan_Harian',
  'PEMASUKAN':     'Folder_Pemasukan_Laporan_Harian',
  'STRUK_BELANJA': 'Folder_Struk_Belanja_Pengeluaran',
  'OPEN_STORE':    'Folder_Open_Store',
  'CLOSE_STORE':   'Folder_Close_Store'
};

var DAFTAR_5_CABANG_UTAMA = ['Majenang', 'Cilacap', 'Pekalongan', 'Pemalang', 'Kediri'];

// ============================================================================
// MODUL KEAMANAN V5 — AUTENTIKASI & OTORISASI SERVER-SIDE
// ----------------------------------------------------------------------------
// SETUP WAJIB (sekali saja) — baca SECURITY_FIX_README.md:
//   1. Project Settings (ikon roda gigi) > Script Properties > Add script property
//        Nama : ADMIN_PASSWORD
//        Nilai: <password admin baru, minimal 10 karakter>
//   2. Jalankan fungsi  setupSecurity()  satu kali dari editor Apps Script.
//   3. Deploy > Manage deployments > Edit > Version: "New version" > Deploy.
// Setelah itu password admin disimpan sebagai HASH dan nilai polosnya dihapus.
//
// Fungsi berakhiran "_" bersifat PRIVAT (tidak dapat dipanggil dari luar script).
// ============================================================================
var SEC_ADMIN_TTL_MS = 4 * 60 * 60 * 1000;     // sesi admin berlaku 4 jam
var SEC_EMP_TTL_MS = 14 * 60 * 60 * 1000;      // sesi kru berlaku 14 jam (1 shift panjang)
var SEC_MAX_FAILS = 6;                          // gagal login maksimal ...
var SEC_LOCK_SECONDS = 600;                     // ... lalu dikunci 10 menit
var SEC_MIN_ADMIN_PW_LEN = 10;
var SEC_MIN_EMP_PW_LEN = 8;
var SEC_MAX_IMAGE_BYTES = 6 * 1024 * 1024;      // batas 1 foto (setelah decode)
var SEC_MAX_PHOTOS_PER_REPORT = 12;
var SEC_ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
var SEC_MAX_SHEET_ROWS = 1500;                  // batas baris yang dikirim ke dashboard
// Set true HANYA jika Anda sadar foto/spreadsheet akan bisa dibuka siapa saja yang punya link.
var SEC_ALLOW_PUBLIC_DRIVE_LINKS = false;

// ---------------------------------------------------------------- util dasar
function secFail_(code, message) {
  var e = new Error(message);
  e.secCode = code;
  throw e;
}

function secErrorJson_(err) {
  var known = !!(err && err.secCode);
  if (!known) {
    try { Logger.log('SERVER ERROR: ' + (err && err.stack ? err.stack : err)); } catch (eLog) {}
  }
  return JSON.stringify({
    status: 'error',
    code: known ? err.secCode : 'SERVER_ERROR',
    message: known ? err.message : 'Terjadi kesalahan pada server.'
  });
}

function secSecret_() {
  var props = PropertiesService.getScriptProperties();
  var s = props.getProperty('AUTH_SECRET');
  if (s) return s;
  var lock = LockService.getScriptLock();
  try { lock.waitLock(10000); } catch (eLock) {}
  try {
    s = props.getProperty('AUTH_SECRET');
    if (!s) {
      s = Utilities.getUuid() + Utilities.getUuid() + Utilities.getUuid();
      props.setProperty('AUTH_SECRET', s);
    }
  } finally {
    try { lock.releaseLock(); } catch (eRel) {}
  }
  return s;
}

function secSign_(text) {
  return Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(String(text), secSecret_()));
}

// Perbandingan waktu-konstan (mencegah timing attack)
function secEq_(a, b) {
  a = String(a); b = String(b);
  var diff = a.length ^ b.length;
  var n = Math.max(a.length, b.length);
  for (var i = 0; i < n; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

// Hash password = HMAC-SHA256(secret server, salt + password). Secret hanya ada di
// Script Properties, sehingga hash tidak bisa di-crack offline oleh pihak luar.
function secHashPw_(password, salt, foldCase) {
  var pw = String(password || '').trim();
  if (foldCase) pw = pw.toLowerCase();
  return secSign_('pw:' + salt + ':' + pw);
}

// ------------------------------------------------------------------- token
function secIssueToken_(role, branch, name, empId) {
  var now = new Date().getTime();
  var payload = {
    r: role,
    b: branch || '',
    n: name || '',
    i: empId || '',
    iat: now,
    exp: now + (role === 'ADMIN' ? SEC_ADMIN_TTL_MS : SEC_EMP_TTL_MS),
    j: Utilities.getUuid().substring(0, 8)
  };
  var p = Utilities.base64EncodeWebSafe(JSON.stringify(payload), Utilities.Charset.UTF_8);
  return { token: p + '.' + secSign_(p), payload: payload };
}

function secVerifyToken_(token) {
  if (!token || typeof token !== 'string' || token.length > 2000) return null;
  var parts = token.split('.');
  if (parts.length !== 2) return null;
  if (!secEq_(secSign_(parts[0]), parts[1])) return null;
  var payload;
  try {
    payload = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(parts[0])).getDataAsString());
  } catch (eParse) {
    return null;
  }
  if (!payload || !payload.exp || !payload.iat) return null;
  if (new Date().getTime() > payload.exp) return null;
  var props = PropertiesService.getScriptProperties();
  var revokeAll = Number(props.getProperty('AUTH_REVOKE_BEFORE') || 0);
  if (payload.iat < revokeAll) return null;
  if (payload.i) {
    var revokeEmp = Number(props.getProperty('AUTH_REVOKE_EMP_' + payload.i) || 0);
    if (payload.iat < revokeEmp) return null;
  }
  return payload;
}

function secRequire_(token, roles) {
  var s = secVerifyToken_(token);
  if (!s) secFail_('AUTH_REQUIRED', 'Sesi tidak valid atau sudah berakhir. Silakan login ulang.');
  if (roles && roles.indexOf(s.r) === -1) secFail_('FORBIDDEN', 'Akses ditolak untuk peran ini.');
  return s;
}

// ------------------------------------------------- pembatasan percobaan login
function secBucket_(role, branch) {
  return 'OHSNAP_LF_' + role + '_' + String(branch || '').toLowerCase().replace(/[^a-z0-9]/g, '_').substring(0, 40);
}
function secIsLocked_(bucket) {
  return Number(CacheService.getScriptCache().get(bucket) || 0) >= SEC_MAX_FAILS;
}
function secAddFail_(bucket) {
  var c = CacheService.getScriptCache();
  c.put(bucket, String(Number(c.get(bucket) || 0) + 1), SEC_LOCK_SECONDS);
}
function secClearFails_(bucket) {
  CacheService.getScriptCache().remove(bucket);
}

// ---------------------------------------------------------- password admin
function secEnsureAdminHash_() {
  var props = PropertiesService.getScriptProperties();
  var plain = props.getProperty('ADMIN_PASSWORD');
  if (plain) {
    if (String(plain).length < SEC_MIN_ADMIN_PW_LEN) {
      secFail_('WEAK_PASSWORD', 'ADMIN_PASSWORD di Script Properties minimal ' + SEC_MIN_ADMIN_PW_LEN + ' karakter.');
    }
    var salt = Utilities.getUuid();
    props.setProperties({
      ADMIN_PASSWORD_HASH: salt + '$' + secHashPw_(plain, 'admin:' + salt, false),
      AUTH_REVOKE_BEFORE: String(new Date().getTime())
    }, false);
    props.deleteProperty('ADMIN_PASSWORD');
  }
  return props.getProperty('ADMIN_PASSWORD_HASH') || '';
}

function secCheckAdminPassword_(password) {
  var stored = secEnsureAdminHash_();
  if (!stored) {
    secFail_('ADMIN_NOT_CONFIGURED', 'Password admin belum diatur. Isi Script Property ADMIN_PASSWORD lalu jalankan setupSecurity().');
  }
  var idx = stored.indexOf('$');
  var salt = stored.substring(0, idx);
  var hash = stored.substring(idx + 1);
  return secEq_(secHashPw_(password, 'admin:' + salt, false), hash);
}

// ------------------------------------------------------------------- login
function handleLogin_(params) {
  var role = String(params.role || '').toUpperCase();
  var password = String(params.password || '');
  if (password.length < 1 || password.length > 200) secFail_('BAD_REQUEST', 'Password tidak valid.');

  if (role === 'ADMIN') {
    var bucketA = secBucket_('ADMIN', '');
    if (secIsLocked_(bucketA)) secFail_('LOCKED', 'Terlalu banyak percobaan gagal. Coba lagi dalam 10 menit.');
    if (!secCheckAdminPassword_(password)) {
      secAddFail_(bucketA);
      Utilities.sleep(700);
      secFail_('BAD_CREDENTIALS', 'Password / PIN Admin salah.');
    }
    secClearFails_(bucketA);
    var tA = secIssueToken_('ADMIN', '', 'Admin', '');
    return { status: 'success', token: tA.token, role: 'ADMIN', name: 'Admin', branch: '', empId: '', expiresAt: tA.payload.exp };
  }

  if (role !== 'EMPLOYEE') secFail_('BAD_REQUEST', 'Peran login tidak dikenali.');
  var branch = String(params.branch || '').trim();
  var cfg = loadCloudConfigFromChunks(true) || {};
  var branches = Array.isArray(cfg.branches) && cfg.branches.length ? cfg.branches : DAFTAR_5_CABANG_UTAMA;
  if (branches.indexOf(branch) === -1) secFail_('BAD_REQUEST', 'Cabang tidak dikenali.');

  var bucketE = secBucket_('EMP', branch);
  if (secIsLocked_(bucketE)) secFail_('LOCKED', 'Terlalu banyak percobaan gagal. Coba lagi dalam 10 menit.');

  var emps = Array.isArray(cfg.employees) ? cfg.employees : [];
  var matched = null;
  for (var i = 0; i < emps.length; i++) {
    var emp = emps[i];
    if (!emp || emp.defaultBranch !== branch || !emp.passwordHash) continue;
    if (secEq_(secHashPw_(password, 'emp:' + emp.id, true), emp.passwordHash)) {
      matched = emp;
      break;
    }
  }
  if (!matched) {
    secAddFail_(bucketE);
    Utilities.sleep(700);
    secFail_('BAD_CREDENTIALS', 'Password tidak terdaftar di cabang ' + branch + '.');
  }
  secClearFails_(bucketE);
  var tE = secIssueToken_('EMPLOYEE', branch, matched.name, matched.id);
  return { status: 'success', token: tE.token, role: 'EMPLOYEE', name: matched.name, branch: branch, empId: matched.id, expiresAt: tE.payload.exp };
}

function handleChangeAdminPassword_(params, session) {
  var current = String(params.currentPassword || '');
  var next = String(params.newPassword || '');
  if (!secCheckAdminPassword_(current)) {
    Utilities.sleep(700);
    secFail_('BAD_CREDENTIALS', 'Password admin saat ini salah.');
  }
  if (next.length < SEC_MIN_ADMIN_PW_LEN || next.length > 200) {
    secFail_('WEAK_PASSWORD', 'Password admin baru minimal ' + SEC_MIN_ADMIN_PW_LEN + ' karakter.');
  }
  var salt = Utilities.getUuid();
  PropertiesService.getScriptProperties().setProperties({
    ADMIN_PASSWORD_HASH: salt + '$' + secHashPw_(next, 'admin:' + salt, false),
    AUTH_REVOKE_BEFORE: String(new Date().getTime())
  }, false);
  // Semua sesi lama (termasuk sesi ini) dicabut; admin harus login ulang.
  return { status: 'success', message: 'Password admin diperbarui. Silakan login ulang.' };
}

// ------------------------------------------- kru: simpan hash, tidak pernah polos
function secMergeEmployees_(existingList, incomingList) {
  var existing = {};
  (Array.isArray(existingList) ? existingList : []).forEach(function(e) {
    if (e && e.id) existing[String(e.id)] = e;
  });
  var props = PropertiesService.getScriptProperties();
  var nowStr = String(new Date().getTime());
  var out = [];
  var seen = {};
  var newPlain = {};
  (Array.isArray(incomingList) ? incomingList : []).forEach(function(inc) {
    if (!inc || typeof inc !== 'object') return;
    var id = String(inc.id || '').replace(/[^a-zA-Z0-9_-]/g, '').substring(0, 40);
    if (!id || seen[id]) return;
    var name = String(inc.name || '').trim().substring(0, 60);
    var branch = String(inc.defaultBranch || '').trim().substring(0, 60);
    if (!name || !branch) return;
    seen[id] = true;
    var prev = existing[id] || {};
    var rec = { id: id, name: name, defaultBranch: branch };
    if (prev.passwordHash) rec.passwordHash = prev.passwordHash;
    var newPw = String(inc.password || '').trim();
    if (newPw) {
      if (newPw.length < SEC_MIN_EMP_PW_LEN || newPw.length > 100) {
        secFail_('WEAK_PASSWORD', 'Password untuk "' + name + '" minimal ' + SEC_MIN_EMP_PW_LEN + ' karakter.');
      }
      rec.passwordHash = secHashPw_(newPw, 'emp:' + id, true);
      newPlain[id] = newPw;
      props.setProperty('AUTH_REVOKE_EMP_' + id, nowStr);
    } else if (prev.defaultBranch && prev.defaultBranch !== branch) {
      props.setProperty('AUTH_REVOKE_EMP_' + id, nowStr);
    }
    out.push(rec);
  });
  Object.keys(existing).forEach(function(id) {
    if (!seen[id]) props.setProperty('AUTH_REVOKE_EMP_' + id, nowStr);
  });
  // Login mengenali kru dari password + cabang, jadi password tidak boleh kembar dalam 1 cabang.
  // (Salt berbeda per kru, jadi bandingkan password baru dengan hash tiap kru lain di cabang yang sama.)
  for (var a = 0; a < out.length; a++) {
    if (!newPlain[out[a].id]) continue;
    for (var b = 0; b < out.length; b++) {
      if (a === b || !out[b].passwordHash || out[b].defaultBranch !== out[a].defaultBranch) continue;
      if (secEq_(secHashPw_(newPlain[out[a].id], 'emp:' + out[b].id, true), out[b].passwordHash)) {
        secFail_('DUPLICATE_PASSWORD', 'Password "' + out[a].name + '" sama dengan password "' + out[b].name + '" di cabang ' + out[a].defaultBranch + '. Gunakan password berbeda.');
      }
    }
  }
  return out;
}

// Pastikan secret tidak pernah tersimpan di Cloud Config (properti maupun backup Drive)
function secStripConfigSecrets_(rawJsonString) {
  try {
    var o = JSON.parse(rawJsonString);
    if (o && typeof o === 'object') {
      delete o.adminPin;
      if (Array.isArray(o.employees)) {
        for (var i = 0; i < o.employees.length; i++) {
          if (o.employees[i] && typeof o.employees[i] === 'object') delete o.employees[i].password;
        }
      }
      return JSON.stringify(o);
    }
  } catch (e) {}
  return rawJsonString;
}

// Data konfigurasi yang boleh dilihat peran tertentu
function secScopeConfig_(cfg, session) {
  cfg = cfg || {};
  var out = {};
  var k;
  if (!session) {
    var pub = ['branches', 'schedules', 'closeRules', 'visualTheme', 'updatedAt'];
    for (var p = 0; p < pub.length; p++) {
      if (cfg[pub[p]] !== undefined) out[pub[p]] = cfg[pub[p]];
    }
    return out;
  }
  for (k in cfg) {
    if (Object.prototype.hasOwnProperty.call(cfg, k) && k !== 'adminPin') out[k] = cfg[k];
  }
  var emps = Array.isArray(cfg.employees) ? cfg.employees : [];
  out.employees = emps.filter(function(e) {
    return e && (session.r === 'ADMIN' || e.defaultBranch === session.b);
  }).map(function(e) {
    return { id: e.id, name: e.name, defaultBranch: e.defaultBranch, hasPassword: !!e.passwordHash };
  });
  if (session.r !== 'ADMIN') {
    var b = session.b;
    out.opLogsSummary = (Array.isArray(cfg.opLogsSummary) ? cfg.opLogsSummary : []).filter(function(x) { return x && x.cabang === b; });
    var inv = {};
    if (cfg.branchStockInventory && cfg.branchStockInventory[b] !== undefined) inv[b] = cfg.branchStockInventory[b];
    out.branchStockInventory = inv;
    var ss = {};
    if (cfg.branchSpreadsheets && cfg.branchSpreadsheets[b]) ss[b] = cfg.branchSpreadsheets[b];
    out.branchSpreadsheets = ss;
  }
  return out;
}

// ------------------------------------------------ pembatasan akses Google Drive
function secAllowedBranches_() {
  var cfg = null;
  try { cfg = loadCloudConfigFromChunks(true); } catch (e) {}
  return (cfg && Array.isArray(cfg.branches) && cfg.branches.length) ? cfg.branches : DAFTAR_5_CABANG_UTAMA;
}

// File hanya boleh disentuh jika berada di dalam Folder Pusat Oh Snap (maks. 8 level)
function secFileInsideRoot_(file, requiredBranchFolderName) {
  if (!file) return false;
  var rootId = '';
  try { rootId = getFolderAbsen().getId(); } catch (e) { return false; }
  var foundRoot = false;
  var foundBranch = !requiredBranchFolderName;
  var level = [file];
  for (var depth = 0; depth < 8 && level.length; depth++) {
    var next = [];
    for (var i = 0; i < level.length; i++) {
      var parents = level[i].getParents();
      while (parents.hasNext()) {
        var par = parents.next();
        if (par.getId() === rootId) foundRoot = true;
        if (requiredBranchFolderName && par.getName() === requiredBranchFolderName) foundBranch = true;
        next.push(par);
      }
    }
    level = next;
  }
  return foundRoot && foundBranch;
}

function secTrashFileIfInsideRoot_(fileId) {
  try {
    var f = DriveApp.getFileById(fileId);
    if (secFileInsideRoot_(f)) {
      f.setTrashed(true);
      return true;
    }
  } catch (e) {}
  return false;
}

function secKnownSpreadsheetBranch_(spreadsheetId) {
  var cfg = null;
  try { cfg = loadCloudConfigFromChunks(true); } catch (e) {}
  var props = PropertiesService.getScriptProperties();
  var branches = secAllowedBranches_();
  for (var i = 0; i < branches.length; i++) {
    var id = '';
    if (cfg && cfg.branchSpreadsheets && cfg.branchSpreadsheets[branches[i]]) {
      id = cfg.branchSpreadsheets[branches[i]].spreadsheetId || '';
    }
    if (!id) id = props.getProperty(getBranchPropKey(branches[i])) || '';
    if (id && id === spreadsheetId) return branches[i];
  }
  return '';
}

// Pengganti gviz publik: dashboard membaca baris sheet lewat server (butuh token)
function handleGetSheetRows_(params, session) {
  var ssId = String(params.spreadsheetId || '').trim();
  var sheetName = String(params.sheetName || '').trim();
  var okName = false;
  for (var i = 0; i < TEMPLATE_8_SHEET_NAMES.length; i++) {
    if (TEMPLATE_8_SHEET_NAMES[i].toLowerCase() === sheetName.toLowerCase()) { okName = true; sheetName = TEMPLATE_8_SHEET_NAMES[i]; break; }
  }
  if (!okName) secFail_('BAD_REQUEST', 'Nama sheet tidak dikenali.');
  var branch = secKnownSpreadsheetBranch_(ssId);
  if (!branch) secFail_('FORBIDDEN', 'Spreadsheet tidak terdaftar.');
  if (session.r !== 'ADMIN' && session.b !== branch) secFail_('FORBIDDEN', 'Akses ditolak untuk cabang ini.');

  var ss = SpreadsheetApp.openById(ssId);
  var sh = ss.getSheetByName(sheetName);
  if (!sh || sh.getLastRow() < 2) return { status: 'success', rows: [] };
  var lastRow = sh.getLastRow();
  var lastCol = Math.max(1, sh.getLastColumn());
  var startRow = Math.max(2, lastRow - SEC_MAX_SHEET_ROWS + 1);
  var numRows = lastRow - startRow + 1;
  var rng = sh.getRange(startRow, 1, numRows, lastCol);
  var vals = rng.getValues();
  var disp = rng.getDisplayValues();
  var tz = ss.getSpreadsheetTimeZone() || 'Asia/Jakarta';
  var rows = [];
  for (var r = 0; r < vals.length; r++) {
    var line = [];
    for (var c = 0; c < vals[r].length; c++) {
      var v = vals[r][c];
      if (v instanceof Date) {
        if (v.getFullYear() <= 1900) {
          var tm = String(disp[r][c] || '').match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
          line.push(tm ? (('0' + tm[1]).slice(-2) + ':' + tm[2] + ':' + (tm[3] || '00')) : String(disp[r][c] || ''));
        } else {
          line.push(Utilities.formatDate(v, tz, 'yyyy-MM-dd HH:mm:ss'));
        }
      } else if (typeof v === 'number') {
        line.push(v);
      } else {
        line.push(String(disp[r][c] !== undefined ? disp[r][c] : v));
      }
    }
    rows.push(line);
  }
  return { status: 'success', rows: rows };
}

// ----------------------------------------------------- anti formula-injection
// Teks yang diawali = + - @ akan dieksekusi sebagai rumus oleh Google Sheets
// (mis. =IMPORTDATA/=HYPERLINK untuk mencuri data). Awali dengan apostrof agar jadi teks.
function secSafeCell_(v) {
  if (typeof v !== 'string' || v.length < 2) return v;
  if (/^[=+@\t\r]/.test(v)) return "'" + v;
  if (v.charAt(0) === '-' && !/^-?\d+([.,]\d+)?$/.test(v)) return "'" + v;
  return v;
}
function secAppendRow_(sheet, row) {
  var safe = [];
  for (var i = 0; i < row.length; i++) safe.push(secSafeCell_(row[i]));
  return sheet.appendRow(safe);
}

// -------------------------------------------------------- permintaan masuk
function secParseRequest_(e) {
  var params = {};
  var k;
  if (e && e.parameter) {
    for (k in e.parameter) {
      if (Object.prototype.hasOwnProperty.call(e.parameter, k)) params[k] = e.parameter[k];
    }
  }
  var raw = (e && e.postData && e.postData.contents) ? e.postData.contents : '';
  if (raw && raw.charAt(0) === '{' && params.payload === undefined) {
    try {
      var body = JSON.parse(raw);
      if (body && typeof body === 'object') {
        for (k in body) {
          if (Object.prototype.hasOwnProperty.call(body, k) && params[k] === undefined) params[k] = body[k];
        }
        if (params.payload === undefined) params.payload = raw;
      }
    } catch (eBody) {}
  }
  return params;
}

// ------------------------------------------------------------ setup & audit
// Jalankan SEKALI dari editor Apps Script setelah mengisi ADMIN_PASSWORD.
function setupSecurity() {
  secSecret_();
  var hash = '';
  try { hash = secEnsureAdminHash_(); } catch (e) { Logger.log('PERINGATAN: ' + e.message); }
  // Cabut semua sesi lama & buang password polos / PIN admin yang pernah tersimpan di Cloud Config
  PropertiesService.getScriptProperties().setProperty('AUTH_REVOKE_BEFORE', String(new Date().getTime()));
  var cfg = loadCloudConfigFromChunks(false);
  var removedPw = 0;
  if (cfg && typeof cfg === 'object') {
    if (cfg.adminPin !== undefined) { delete cfg.adminPin; removedPw++; }
    if (Array.isArray(cfg.employees)) {
      cfg.employees = cfg.employees.map(function(e) {
        if (e && e.password !== undefined) removedPw++;
        return { id: e.id, name: e.name, defaultBranch: e.defaultBranch, passwordHash: e.passwordHash || undefined };
      });
    }
    saveCloudConfigToChunks(JSON.stringify(cfg), true);
  }
  Logger.log('=== SETUP KEAMANAN SELESAI ===');
  Logger.log('Password admin terkonfigurasi : ' + (hash ? 'YA' : 'BELUM (isi ADMIN_PASSWORD lalu jalankan ulang)'));
  Logger.log('Secret polos dibuang dari config: ' + removedPw + ' item');
  Logger.log('Langkah berikutnya: login sebagai Admin di web, lalu isi password BARU tiap kru (min. ' + SEC_MIN_EMP_PW_LEN + ' karakter).');
  Logger.log('Opsional: jalankan lockdownExistingSharing() untuk menutup link publik foto & spreadsheet lama.');
}

// Menutup akses "siapa saja yang punya link" pada semua file di Folder Pusat.
// Aman dijalankan berulang kali; berhenti otomatis sebelum batas waktu 6 menit.
function lockdownExistingSharing() {
  var started = new Date().getTime();
  var root = getFolderAbsen();
  var stack = [root];
  var changed = 0, checked = 0, timedOut = false;
  while (stack.length && !timedOut) {
    var folder = stack.pop();
    try {
      if (folder.getSharingAccess() !== DriveApp.Access.PRIVATE) {
        folder.setSharing(DriveApp.Access.PRIVATE, DriveApp.Permission.NONE); changed++;
      }
    } catch (eFold) {}
    var subs = folder.getFolders();
    while (subs.hasNext()) stack.push(subs.next());
    var files = folder.getFiles();
    while (files.hasNext()) {
      if (new Date().getTime() - started > 5 * 60 * 1000) { timedOut = true; break; }
      var f = files.next();
      checked++;
      try {
        if (f.getSharingAccess() !== DriveApp.Access.PRIVATE) {
          f.setSharing(DriveApp.Access.PRIVATE, DriveApp.Permission.NONE); changed++;
        }
      } catch (eFile) {}
    }
  }
  Logger.log('Diperiksa: ' + checked + ' file | Diubah jadi privat: ' + changed);
  Logger.log(timedOut ? 'BELUM SELESAI — jalankan fungsi ini lagi sampai tidak ada perubahan.' : 'SELESAI.');
}


// ============================================================================
// FOTO -> SUPABASE STORAGE   (laporan TETAP masuk Google Spreadsheet; hanya FILE FOTO di Supabase)
// ----------------------------------------------------------------------------
// Alur:
//   1. Browser minta "izin unggah" ke Apps Script (action=photo_upload_urls) memakai token login.
//   2. Apps Script (memegang kunci RAHASIA Supabase) membuat URL unggah bertanda tangan per foto.
//   3. Browser mengunggah foto langsung ke Supabase (resolusi penuh, tanpa lewat Apps Script).
//   4. Browser mengirim laporan ke Apps Script dengan referensi "sb:<path>" (bukan data foto).
//   5. Apps Script menulis baris ke Spreadsheet berisi LINK penampil foto (foto.html#p=<path>).
//   6. Melihat foto: browser minta URL lihat berumur pendek (action=photo_view_url); bucket tetap PRIVAT.
//
// Script Properties (Project Settings > Script properties):
//   SUPABASE_URL          https://<project-ref>.supabase.co
//   SUPABASE_SERVICE_KEY  kunci service_role / secret  (RAHASIA — hanya di sini, tidak pernah ke browser)
//   SUPABASE_ANON_KEY     kunci anon / publishable      (publik; dipakai browser saat mengunggah)
//   PHOTO_VIEWER_URL      https://absen.ohsnap.web.id/foto.html
//   SUPABASE_BUCKET       (opsional) default: ohsnap-photos
// Jika salah satu belum diisi, laporan BERFOTO ditolak (kode SB_REQUIRED) agar tidak ada foto yang diam-diam
// masuk Google Drive. Laporan tanpa foto tetap masuk Spreadsheet. Darurat: ALLOW_DRIVE_PHOTO_FALLBACK = true.
// ============================================================================
var SB_UPLOAD_MAX_PER_CALL = 12;
var SB_VIEW_TTL_SECONDS = 900;
var SB_PATH_RE = /^[A-Za-z0-9_-]{2,40}\/\d{4}-\d{2}-\d{2}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp)$/;

function secSbConfig_() {
  var props = PropertiesService.getScriptProperties();
  var url = String(props.getProperty('SUPABASE_URL') || '').trim().replace(/\/+$/, '');
  var key = String(props.getProperty('SUPABASE_SERVICE_KEY') || '').trim();
  var anon = String(props.getProperty('SUPABASE_ANON_KEY') || '').trim();
  var bucket = String(props.getProperty('SUPABASE_BUCKET') || 'ohsnap-photos').trim();
  var viewer = String(props.getProperty('PHOTO_VIEWER_URL') || '').trim();
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(url)) return null;
  if (!key || !anon) return null;
  if (!/^[a-z0-9][a-z0-9._-]{1,62}$/.test(bucket)) return null;
  if (!/^https:\/\/[^\s#?]+$/.test(viewer)) return null;
  return { url: url, key: key, anon: anon, bucket: bucket, viewer: viewer };
}

// Foto WAJIB ke Supabase. Jalur lama (data foto dikirim ke Apps Script lalu disimpan di Google Drive)
// hanya aktif bila Script Property ALLOW_DRIVE_PHOTO_FALLBACK = true (darurat / masa transisi).
function secDrivePhotoFallbackAllowed_() {
  return String(PropertiesService.getScriptProperties().getProperty('ALLOW_DRIVE_PHOTO_FALLBACK') || '').trim().toLowerCase() === 'true';
}

function secHasInlinePhoto_(node, depth) {
  if (typeof node === 'string') return /^data:[^,]{0,80};base64,/i.test(node);
  if (!node || typeof node !== 'object' || (depth || 0) > 8) return false;
  for (var k in node) {
    if (Object.prototype.hasOwnProperty.call(node, k) && secHasInlinePhoto_(node[k], (depth || 0) + 1)) return true;
  }
  return false;
}

function secPhotoSlug_(name) {
  return String(name || '').replace(/[^A-Za-z0-9_-]/g, '_').substring(0, 40);
}

function secSbEncodePath_(path) {
  return String(path).split('/').map(encodeURIComponent).join('/');
}

function secSbRequest_(cfg, method, apiPath, bodyObj) {
  var headers = { apikey: cfg.key };
  if (cfg.key.indexOf('sb_') !== 0) headers.Authorization = 'Bearer ' + cfg.key;   // kunci baru (sb_...) hanya via apikey
  var opt = { method: method, headers: headers, muteHttpExceptions: true };
  if (bodyObj !== undefined) {
    opt.contentType = 'application/json';
    opt.payload = JSON.stringify(bodyObj);
  }
  return { url: cfg.url + '/storage/v1' + apiPath, opt: opt };
}

function secSbParse_(res) {
  var text = '';
  var json = null;
  try { text = res.getContentText(); } catch (e) {}
  try { json = JSON.parse(text); } catch (e2) {}
  return { code: res.getResponseCode(), json: json, text: text };
}

function secSbCall_(cfg, method, apiPath, bodyObj) {
  var rq = secSbRequest_(cfg, method, apiPath, bodyObj);
  return secSbParse_(UrlFetchApp.fetch(rq.url, rq.opt));
}

// Cabang yang boleh disentuh sesi ini (dilihat dari segmen pertama path foto)
function secSbSlugAllowed_(slug, session) {
  if (session.r !== 'ADMIN') return slug === secPhotoSlug_(session.b);
  var branches = secAllowedBranches_();
  for (var i = 0; i < branches.length; i++) {
    if (secPhotoSlug_(branches[i]) === slug) return true;
  }
  return false;
}

// -------------------------------------------------- izin unggah (URL bertanda tangan)
function handlePhotoUploadUrls_(params, session) {
  var cfg = secSbConfig_();
  if (!cfg) secFail_('SB_DISABLED', 'Penyimpanan foto Supabase belum dikonfigurasi.');
  var count = Math.floor(Number(params.count || 0));
  if (!(count >= 1 && count <= SB_UPLOAD_MAX_PER_CALL)) secFail_('BAD_REQUEST', 'Jumlah foto tidak valid.');
  var cabang = String(params.cabang || '').trim();
  if (secAllowedBranches_().indexOf(cabang) === -1) secFail_('BAD_REQUEST', 'Cabang tidak dikenali.');
  if (session.r !== 'ADMIN' && session.b !== cabang) secFail_('FORBIDDEN', 'Akses ditolak untuk cabang ini.');
  var ext = String(params.ext || 'jpg');
  if (['jpg', 'png', 'webp'].indexOf(ext) === -1) ext = 'jpg';

  var day = Utilities.formatDate(new Date(), 'Asia/Jakarta', 'yyyy-MM-dd');
  var slug = secPhotoSlug_(cabang);
  var paths = [];
  var requests = [];
  for (var i = 0; i < count; i++) {
    var path = slug + '/' + day + '/' + Utilities.getUuid() + '.' + ext;
    paths.push(path);
    var rq = secSbRequest_(cfg, 'post', '/object/upload/sign/' + cfg.bucket + '/' + secSbEncodePath_(path), {});
    requests.push({ url: rq.url, method: rq.opt.method, headers: rq.opt.headers, contentType: rq.opt.contentType, payload: rq.opt.payload, muteHttpExceptions: true });
  }
  var responses = UrlFetchApp.fetchAll(requests);
  var items = [];
  for (var j = 0; j < responses.length; j++) {
    var r = secSbParse_(responses[j]);
    if (r.code < 200 || r.code >= 300 || !r.json || !r.json.url) {
      try { Logger.log('Supabase sign upload gagal: ' + r.code + ' ' + String(r.text).substring(0, 200)); } catch (e) {}
      secFail_('SB_ERROR', 'Gagal menyiapkan unggahan foto. Periksa pengaturan Supabase.');
    }
    items.push({ path: paths[j], uploadUrl: cfg.url + '/storage/v1' + r.json.url });
  }
  return { status: 'success', anonKey: cfg.anon, items: items };
}

// -------------------------------------------------- izin lihat (URL berumur pendek)
function handlePhotoViewUrl_(params, session) {
  var cfg = secSbConfig_();
  if (!cfg) secFail_('SB_DISABLED', 'Penyimpanan foto Supabase belum dikonfigurasi.');
  var path = String(params.path || '');
  if (!SB_PATH_RE.test(path)) secFail_('BAD_REQUEST', 'Path foto tidak valid.');
  if (!secSbSlugAllowed_(path.split('/')[0], session)) secFail_('FORBIDDEN', 'Akses ditolak untuk foto ini.');
  var r = secSbCall_(cfg, 'post', '/object/sign/' + cfg.bucket + '/' + secSbEncodePath_(path), { expiresIn: SB_VIEW_TTL_SECONDS });
  if (r.code === 404) return { status: 'not_found', message: 'Foto tidak ditemukan.' };
  if (r.code < 200 || r.code >= 300 || !r.json || !r.json.signedURL) {
    try { Logger.log('Supabase sign view gagal: ' + r.code + ' ' + String(r.text).substring(0, 200)); } catch (e) {}
    secFail_('SB_ERROR', 'Gagal membuka foto.');
  }
  return { status: 'success', url: cfg.url + '/storage/v1' + r.json.signedURL, expiresIn: SB_VIEW_TTL_SECONDS };
}

// -------------------------------------------------- saat laporan masuk: referensi foto -> link penampil
function secSbStoredPhoto_(path, cabang) {
  var cfg = secSbConfig_();
  if (!cfg || !SB_PATH_RE.test(path) || path.split('/')[0] !== secPhotoSlug_(cabang)) {
    return { fileUrl: '- (referensi foto tidak valid)', folderUrl: '-' };
  }
  // Pastikan berkasnya benar-benar sudah terunggah (daftar objek: aman di semua versi Supabase)
  try {
    var parts = path.split('/');
    var r = secSbCall_(cfg, 'post', '/object/list/' + cfg.bucket, {
      prefix: parts[0] + '/' + parts[1], search: parts[2], limit: 5
    });
    if (r.code === 200 && Array.isArray(r.json)) {
      var found = false;
      for (var i = 0; i < r.json.length; i++) {
        if (r.json[i] && r.json[i].name === parts[2]) { found = true; break; }
      }
      if (!found) return { fileUrl: '- (foto belum ada di penyimpanan)', folderUrl: '-' };
    }
    // kode lain (mis. gangguan sementara): tidak bisa memverifikasi -> tetap tulis link
  } catch (eList) {}
  return { fileUrl: cfg.viewer + '#p=' + encodeURIComponent(path), folderUrl: '-', sbPath: path };
}

// -------------------------------------------------- hapus foto yang tertaut di teks baris sheet
function secSbPathsFromText_(text) {
  var out = [];
  var seen = {};
  var re = /[#&?]p=([^&\s|,]+)/g;
  var m;
  var str = String(text || '');
  while ((m = re.exec(str)) !== null) {
    var p = '';
    try { p = decodeURIComponent(m[1]); } catch (e) { p = ''; }
    if (p && !seen[p] && SB_PATH_RE.test(p)) { seen[p] = true; out.push(p); }
  }
  return out;
}

function secSbRemoveFromText_(text) {
  var cfg = secSbConfig_();
  if (!cfg) return 0;
  var paths = secSbPathsFromText_(text);
  if (!paths.length) return 0;
  try {
    var r = secSbCall_(cfg, 'delete', '/object/' + cfg.bucket, { prefixes: paths });
    if (r.code >= 200 && r.code < 300) return paths.length;
  } catch (e) {}
  return 0;
}

// -------------------------------------------------- UJI KONEKSI (jalankan manual dari editor Apps Script)
// Memeriksa: kunci benar, bucket ada & privat, unggah, daftar, URL lihat, hapus.
function testSupabaseStorage() {
  var cfg = secSbConfig_();
  if (!cfg) {
    Logger.log('❌ Script Properties belum lengkap/benar: SUPABASE_URL (https://xxxx.supabase.co), SUPABASE_SERVICE_KEY, SUPABASE_ANON_KEY, PHOTO_VIEWER_URL (https://...).');
    return;
  }
  var day = Utilities.formatDate(new Date(), 'Asia/Jakarta', 'yyyy-MM-dd');
  var path = 'TES/' + day + '/' + Utilities.getUuid() + '.png';
  var png = Utilities.base64Decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==');
  var ok = true;

  var rq = secSbRequest_(cfg, 'post', '/object/' + cfg.bucket + '/' + secSbEncodePath_(path));
  rq.opt.contentType = 'image/png';
  rq.opt.payload = png;
  var up = secSbParse_(UrlFetchApp.fetch(rq.url, rq.opt));
  Logger.log((up.code >= 200 && up.code < 300 ? '✅' : '❌') + ' 1. Unggah berkas uji: HTTP ' + up.code + (up.code >= 300 ? ' ' + String(up.text).substring(0, 160) : ''));
  if (up.code < 200 || up.code >= 300) { Logger.log('   Cek: bucket "' + cfg.bucket + '" sudah dibuat (jalankan supabase/storage.sql) dan SUPABASE_SERVICE_KEY benar.'); return; }

  var parts = path.split('/');
  var ls = secSbCall_(cfg, 'post', '/object/list/' + cfg.bucket, { prefix: parts[0] + '/' + parts[1], search: parts[2], limit: 5 });
  var listed = ls.code === 200 && Array.isArray(ls.json) && ls.json.length > 0;
  ok = ok && listed;
  Logger.log((listed ? '✅' : '❌') + ' 2. Daftar objek: HTTP ' + ls.code);

  var sg = secSbCall_(cfg, 'post', '/object/sign/' + cfg.bucket + '/' + secSbEncodePath_(path), { expiresIn: 60 });
  var signedOk = sg.code === 200 && sg.json && sg.json.signedURL;
  ok = ok && !!signedOk;
  Logger.log((signedOk ? '✅' : '❌') + ' 3. URL lihat bertanda tangan: HTTP ' + sg.code);

  if (signedOk) {
    var got = UrlFetchApp.fetch(cfg.url + '/storage/v1' + sg.json.signedURL, { muteHttpExceptions: true });
    var gotOk = got.getResponseCode() === 200 && got.getContent().length === png.length;
    ok = ok && gotOk;
    Logger.log((gotOk ? '✅' : '❌') + ' 4. Mengunduh lewat URL bertanda tangan: HTTP ' + got.getResponseCode());
  }

  var pub = UrlFetchApp.fetch(cfg.url + '/storage/v1/object/public/' + cfg.bucket + '/' + secSbEncodePath_(path), { muteHttpExceptions: true });
  var privateOk = pub.getResponseCode() >= 400;
  ok = ok && privateOk;
  Logger.log((privateOk ? '✅' : '❌ BAHAYA:') + ' 5. Bucket PRIVAT (akses publik ditolak): HTTP ' + pub.getResponseCode() + (privateOk ? '' : ' -> bucket masih PUBLIK! ubah public=false'));

  var del = secSbCall_(cfg, 'delete', '/object/' + cfg.bucket, { prefixes: [path] });
  var delOk = del.code >= 200 && del.code < 300;
  ok = ok && delOk;
  Logger.log((delOk ? '✅' : '❌') + ' 6. Hapus berkas uji: HTTP ' + del.code);

  Logger.log(ok ? '=== SEMUA OK: foto siap disimpan di Supabase ===' : '=== ADA YANG GAGAL — baca baris ❌ di atas ===');
}


// ============================================================================
// DAFTAR ID SPREADSHEET BERBEDA UNTUK TIAP CABANG
// - Biarkan kosong '' -> Script otomatis membuatkan file Spreadsheet terpisah
//   di Folder Google Drive Anda untuk masing-masing cabang (termasuk cabang baru)!
// ============================================================================
var BRANCH_SPREADSHEET_IDS = {
  'Majenang': '',
  'Cilacap': '',
  'Pekalongan': '',
  'Pemalang': '',
  'Kediri': ''
};

// Urutan & Nama Persis 8 Sheet Template di Setiap Spreadsheet Cabang
var TEMPLATE_8_SHEET_NAMES = [
  'Absen_Masuk',
  'Absen_Keluar',
  'Laporan_Harian',
  'Rekap_Pengeluaran',
  'Stock_Opname',
  'Barang_Datang',
  'open_Store',
  'Close_Store'
];

// ============================================================================
// FUNGSI UTAMA #1 (OTOMATIS TERPILIH SAAT KLIK TOMBOL "▶ JALANKAN / RUN" DI APPS SCRIPT):
// Memindai Google Drive, menggabungkan data jika ada yang tercecer, dan MENGHAPUS KE SAMPAH
// semua file OhSnap_Spreadsheet_* yang duplikat/kosong sehingga hanya tersisa 1 per cabang!
// ============================================================================
function setup5SpreadsheetCabangOtomatis() {
  _MEM_DEDUPED_BRANCH_MAP = null;
  var daftarCabang = getActiveBranchNamesList('');
  var folder = getFolderAbsen();
  Logger.log('=== MEMULAI PEMBERSIHAN SPREADSHEET DUPLIKAT & SETUP CABANG ===');
  Logger.log('Folder Utama Google Drive: ' + folder.getUrl());

  // 1. Bersihkan semua Spreadsheet duplikat/kosong terlebih dahulu (hanya 1x scan cepat)
  var dedupResult = deduplicateAllBranchSpreadsheetsInDrive(true);
  Logger.log('Hasil Pembersihan Duplikat: ' + JSON.stringify(dedupResult.summaryLog || []));

  // 2. Pastikan 1 Spreadsheet utama untuk masing-masing cabang aktif terdaftar di Cloud Config
  var existingCfg = loadCloudConfigFromChunks(false) || { branches: daftarCabang, branchSpreadsheets: {} };
  existingCfg.branches = daftarCabang;
  existingCfg.branchSpreadsheets = existingCfg.branchSpreadsheets || {};

  for (var i = 0; i < daftarCabang.length; i++) {
    var cb = daftarCabang[i];
    var ss = getOrCreateBranchSpreadsheet(cb, '');
    if (ss) {
      existingCfg.branchSpreadsheets[cb] = {
        spreadsheetId: ss.getId(),
        spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/' + ss.getId() + '/edit',
        updatedAt: new Date().toISOString()
      };
      Logger.log((i + 1) + '. Spreadsheet Aktif Cabang [' + cb + '] -> ID: ' + ss.getId() + ' | ' + ss.getUrl());
    }
  }

  // 3. Sinkronkan isi laporan dari Spreadsheet yang memiliki data ke Cloud Config
  try {
    existingCfg = syncOpLogsTimeFromBranchSpreadsheets(existingCfg) || existingCfg;
  } catch (eSync) {}
  saveCloudConfigToChunks(JSON.stringify(existingCfg), true);

  // 4. Siapkan subfolder foto per cabang
  var kategoriKeys = ['ABSENSI', 'SERAH_TERIMA', 'STRUK_BELANJA', 'OPEN_STORE', 'CLOSE_STORE'];
  for (var k = 0; k < kategoriKeys.length; k++) {
    var key = kategoriKeys[k];
    getFolderFotoByKategoriLaporan(key, '');
    for (var c = 0; c < daftarCabang.length; c++) {
      getFolderFotoByKategoriLaporan(key, daftarCabang[c]);
    }
  }
  Logger.log('=== SELESAI! Semua Spreadsheet Duplikat telah dibuang ke Sampah (Trash) & Data tersinkron ===');
}

function getFolderAbsen() {
  try {
    return DriveApp.getFolderById(FOLDER_ABSEN_ID);
  } catch (e) {
    var folders = DriveApp.getFoldersByName(FOLDER_ABSEN_NAMA);
    if (folders.hasNext()) return folders.next();
    return DriveApp.createFolder(FOLDER_ABSEN_NAMA);
  }
}

function getOrCreateSubFolder(parentFolder, subFolderName) {
  var cleanName = String(subFolderName || 'Lainnya').trim();
  var iter = parentFolder.getFoldersByName(cleanName);
  if (iter.hasNext()) return iter.next();
  return parentFolder.createFolder(cleanName);
}

function getActiveBranchNamesList(extraCabangName) {
  var rawCandidates = DAFTAR_5_CABANG_UTAMA.slice();
  try {
    var cfg = loadCloudConfigFromChunks(true);
    if (cfg && cfg.branches && cfg.branches.length > 0) {
      rawCandidates = cfg.branches.slice();
      for (var d = 0; d < DAFTAR_5_CABANG_UTAMA.length; d++) {
        rawCandidates.push(DAFTAR_5_CABANG_UTAMA[d]);
      }
    }
  } catch (e) {}
  if (extraCabangName) {
    rawCandidates.push(String(extraCabangName).trim());
  }
  var listCabang = [];
  var seenLower = {};
  for (var i = 0; i < rawCandidates.length; i++) {
    var bn = String(rawCandidates[i] || '').trim();
    if (!bn) continue;
    var low = bn.toLowerCase();
    if (!seenLower[low]) {
      seenLower[low] = true;
      listCabang.push(bn);
    }
  }
  return listCabang;
}

// Pastikan di dalam Folder Kategori selalu tersedia Subfolder untuk semua Cabang aktif
function ensureAll5BranchSubFolders(kategoriFolder, extraCabangName) {
  var listCabang = getActiveBranchNamesList(extraCabangName);
  var targetBranchFolder = kategoriFolder;
  for (var i = 0; i < listCabang.length; i++) {
    var bName = listCabang[i];
    var sub = getOrCreateSubFolder(kategoriFolder, 'Cabang_' + bName);
    if (extraCabangName && String(extraCabangName).trim().toLowerCase() === bName.toLowerCase()) {
      targetBranchFolder = sub;
    }
  }
  return targetBranchFolder;
}

// Ambil / Buat Folder Kategori Laporan + Otomatis Subfolder Cabang di dalamnya
function getFolderFotoByKategoriLaporan(kategoriKey, cabangName) {
  var rootFolder = getFolderAbsen();
  var folderTitle = REPORT_PHOTO_FOLDER_NAMES[kategoriKey] || ('Folder_' + String(kategoriKey || 'Laporan'));
  var kategoriFolder = getOrCreateSubFolder(rootFolder, folderTitle);
  if (cabangName) {
    return ensureAll5BranchSubFolders(kategoriFolder, cabangName);
  }
  ensureAll5BranchSubFolders(kategoriFolder, '');
  return kategoriFolder;
}

// Pastikan kelima folder kategori memiliki subfolder Cabang_<cabangName> saat cabang baru ditambahkan
function ensureBranchPhotoFoldersForSingleBranch(cabangName) {
  var cleanCabang = String(cabangName || '').trim();
  if (!cleanCabang) return;
  var rootFolder = getFolderAbsen();
  var kategoriKeys = ['ABSENSI', 'SERAH_TERIMA', 'STRUK_BELANJA', 'OPEN_STORE', 'CLOSE_STORE'];
  for (var k = 0; k < kategoriKeys.length; k++) {
    var folderTitle = REPORT_PHOTO_FOLDER_NAMES[kategoriKeys[k]];
    var katFolder = getOrCreateSubFolder(rootFolder, folderTitle);
    getOrCreateSubFolder(katFolder, 'Cabang_' + cleanCabang);
  }
}

function extractSpreadsheetIdFromInput(rawVal) {
  if (!rawVal) return '';
  var str = String(rawVal).trim();
  if (!str || str === 'AUTO') return '';
  var match = str.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (match && match[1]) return match[1];
  return str;
}

function extractGsDriveFileId(rawUrlText) {
  if (!rawUrlText) return '';
  var s = String(rawUrlText).trim();
  if (!s || s === '-') return '';
  var m1 = s.match(/\/file\/d\/([a-zA-Z0-9_-]{15,})/);
  if (m1 && m1[1]) return m1[1];
  var m2 = s.match(/[?&]id=([a-zA-Z0-9_-]{15,})/);
  if (m2 && m2[1]) return m2[1];
  var m3 = s.match(/googleusercontent\.com\/d\/([a-zA-Z0-9_-]{15,})/);
  if (m3 && m3[1]) return m3[1];
  if (/^[a-zA-Z0-9_-]{25,100}$/.test(s)) return s;
  return '';
}

function toGsDriveThumbnailUrl(rawUrlText) {
  if (!rawUrlText) return '';
  var s = String(rawUrlText).trim();
  if (s.indexOf('data:image/') === 0) return s;
  var fId = extractGsDriveFileId(s);
  if (fId) return 'https://drive.google.com/thumbnail?id=' + fId + '&sz=w800';
  return '';
}

function getBranchPropKey(cabangName) {
  return 'OHSNAP_BRANCH_SS_' + String(cabangName || 'CILACAP').trim().toUpperCase().replace(/[^A-Z0-9]/g, '_');
}

function getTemplateHeadersBySheetName(sheetName) {
  if (sheetName === 'Absen_Masuk') {
    return [
      'Timestamp', 'Tanggal', 'Jam Absen Masuk', 'Cabang', 'Nama Karyawan',
      'Shift', 'Jadwal Jam Kerja', 'Status Ketepatan (Tepat Waktu / Telat)',
      'Detail Keterlambatan', 'Koordinat GPS & Waktu',
      'Link Foto Kamera Absen Masuk', 'Folder Absensi Cabang (Google Drive)', 'Catatan'
    ];
  }
  if (sheetName === 'Absen_Keluar') {
    return [
      'Timestamp', 'Tanggal', 'Jam Absen Keluar', 'Cabang', 'Nama Karyawan',
      'Shift', 'Jadwal Jam Kerja', 'Status Jam Kerja (Tepat Waktu / Belum Memenuhi Jam Kerja)',
      'Detail Kekurangan Jam Kerja', 'Koordinat GPS & Waktu',
      'Link Foto Kamera Absen Keluar', 'Folder Absensi Cabang (Google Drive)', 'Catatan'
    ];
  }
  if (sheetName === 'Laporan_Harian') {
    return [
      'Timestamp', 'Tanggal', 'Jam Input', 'Cabang', 'Shift', 'Nama Kasir / Staf',
      'Pemasukan Cash (Rp)', 'Pemasukan QRIS (Rp)', 'Pemasukan Total Harian Kotor (Rp)',
      'Total Pengeluaran Kas (Rp)', 'Rincian Pengeluaran (Lihat Rekap_Pengeluaran)',
      'Total Pemasukan Harian Bersih (Rp)',
      'Link Foto Pemasukan / Serah Terima (Wajib)', 'Folder Foto Pemasukan Cabang',
      'Link Foto Struk Belanja (Opsional)', 'Folder Foto Struk Belanja Cabang', 'Catatan',
      'Status Revisi'
    ];
  }
  if (sheetName === 'Rekap_Pengeluaran') {
    return [
      'Timestamp', 'Tanggal', 'Jam Input', 'Cabang', 'Shift', 'Nama Kasir / Staf',
      'Nama Item Pengeluaran (Beli Tisu, Air, dll.)', 'Nominal Item Pengeluaran (Rp)',
      'Total Pengeluaran Shift (Rp)', 'Link Foto Struk Belanja',
      'Folder Foto Struk Belanja Cabang', 'Catatan Shift'
    ];
  }
  if (sheetName === 'Stock_Opname') {
    return [
      'Timestamp', 'Cabang', 'Peran Pengirim', 'Tanggal Input', 'Tanggal Cutoff', 'Jam Input',
      'Shift', 'Nama Petugas', 'Petugas Membantu (Opsional)',
      '[BRG-001] Kertas (Pax)', '[BRG-002] Hangtag Kecil (Pcs)', '[BRG-003] Hangtag Besar (Pcs)',
      '[BRG-004] Keychain Panjang (Pcs)', '[BRG-005] Keychain Bulat (Pcs)',
      '[BRG-006] Plastik Kecil (Ikat)', '[BRG-007] Plastik Besar (Ikat)',
      '[BRG-008] Tinta LM (%)', '[BRG-009] Tinta LC (%)', '[BRG-010] Tinta Y (%)',
      '[BRG-011] Tinta M (%)', '[BRG-012] Tinta C (%)', '[BRG-013] Tinta K (%)',
      '[BRG-014] Lem Ganci (Pcs)', 'Barang Tambahan (Jika Ada)', 'Catatan'
    ];
  }
  if (sheetName === 'Barang_Datang') {
    return [
      'Timestamp', 'Cabang', 'Peran Pengirim', 'Tanggal Input', 'Tanggal Barang Datang', 'Jam Input',
      'Shift', 'Nama Petugas', 'Petugas Membantu',
      'Kode Barang', 'Nama Barang', 'Jenis Barang', 'Satuan (Botol/Pax/Pcs/Ikat)',
      'Stok Awal', 'Jumlah Masuk (+)', 'Stok Akhir', 'Ringkasan Laporan', 'Catatan / Pengirim'
    ];
  }
  if (sheetName === 'open_Store') {
    return [
      'Timestamp', 'Tanggal', 'Jam Open Store', 'Cabang', 'Shift', 'Jadwal Jam Kerja',
      'Nama Karyawan', 'Daftar Ceklis Alat Open Store', 'Koordinat GPS & Waktu',
      'Link Foto Open Store', 'Folder Foto Open Store Cabang', 'Catatan'
    ];
  }
  if (sheetName === 'Close_Store') {
    return [
      'Timestamp', 'Tanggal', 'Jam Close Store', 'Cabang', 'Shift', 'Jadwal Jam Kerja',
      'Nama Karyawan', 'Jumlah Foto Close Store', 'Daftar Ceklis Alat Close Store',
      'Koordinat GPS & Waktu', 'Link Foto Close Store (2 Foto / 7 Foto Kediri)',
      'Folder Foto Close Store Cabang', 'Catatan'
    ];
  }
  return ['Timestamp', 'Cabang', 'Data'];
}

// Pastikan Spreadsheet Cabang memiliki 8 Sheet sesuai foto & hapus Sheet1 kosong bawaan
function ensureBranch8SheetsTemplate(ss) {
  if (!ss) return;
  for (var i = 0; i < TEMPLATE_8_SHEET_NAMES.length; i++) {
    var sName = TEMPLATE_8_SHEET_NAMES[i];
    var sh = ss.getSheetByName(sName);
    if (!sh) {
      sh = ss.insertSheet(sName);
    }
    if (sh.getLastRow() === 0) {
      var headers = getTemplateHeadersBySheetName(sName);
      sh.appendRow(headers);
      sh.setFrozenRows(1);
      try {
        var headerRange = sh.getRange(1, 1, 1, headers.length);
        headerRange.setFontWeight('bold');
        headerRange.setBackground('#fce7f3');
        headerRange.setFontColor('#19449a');
      } catch (styleErr) {}
    }
  }
  var defaultSheets = ['Sheet1', 'Lembar1', 'Sheet 1', 'Lembar 1'];
  for (var d = 0; d < defaultSheets.length; d++) {
    var defSh = ss.getSheetByName(defaultSheets[d]);
    if (defSh && ss.getSheets().length > TEMPLATE_8_SHEET_NAMES.length && defSh.getLastRow() === 0) {
      try {
        ss.deleteSheet(defSh);
      } catch (delErr) {}
    }
  }
}

// Hitung total baris data (di luar baris header 1) pada seluruh 8 sheet di sebuah Spreadsheet
function countTotalDataRowsInSpreadsheet(ss) {
  if (!ss) return 0;
  var total = 0;
  for (var i = 0; i < TEMPLATE_8_SHEET_NAMES.length; i++) {
    try {
      var sh = ss.getSheetByName(TEMPLATE_8_SHEET_NAMES[i]);
      if (sh) {
        var lr = sh.getLastRow();
        if (lr > 1) total += (lr - 1);
      }
    } catch (e) {}
  }
  return total;
}

// Salin baris data dari Spreadsheet duplikat ke Spreadsheet utama agar tidak ada data yang hilang sebelum duplikat dihapus
function mergeDataRowsFromDuplicateSpreadsheet(sourceSs, targetSs) {
  if (!sourceSs || !targetSs || sourceSs.getId() === targetSs.getId()) return;
  for (var i = 0; i < TEMPLATE_8_SHEET_NAMES.length; i++) {
    var sName = TEMPLATE_8_SHEET_NAMES[i];
    try {
      var srcSh = sourceSs.getSheetByName(sName);
      if (!srcSh || srcSh.getLastRow() <= 1) continue;
      var tgtSh = targetSs.getSheetByName(sName);
      if (!tgtSh) {
        tgtSh = targetSs.insertSheet(sName);
        var hdrs = getTemplateHeadersBySheetName(sName);
        tgtSh.appendRow(hdrs);
      }
      var srcLastR = srcSh.getLastRow();
      var srcLastC = srcSh.getLastColumn();
      var srcVals = srcSh.getRange(2, 1, srcLastR - 1, srcLastC).getValues();
      var srcDisp = srcSh.getRange(2, 1, srcLastR - 1, srcLastC).getDisplayValues();

      var existingSigs = {};
      var tgtLastR = tgtSh.getLastRow();
      if (tgtLastR > 1) {
        var tgtDisp = tgtSh.getRange(2, 1, tgtLastR - 1, Math.min(srcLastC, tgtSh.getLastColumn())).getDisplayValues();
        for (var tr = 0; tr < tgtDisp.length; tr++) {
          var sigT = tgtDisp[tr].slice(1, 8).join('|').trim().toLowerCase();
          if (sigT) existingSigs[sigT] = true;
        }
      }

      for (var sr = 0; sr < srcVals.length; sr++) {
        var sigS = srcDisp[sr].slice(1, 8).join('|').trim().toLowerCase();
        if (!sigS || existingSigs[sigS]) continue;
        tgtSh.appendRow(srcVals[sr]);
        existingSigs[sigS] = true;
      }
    } catch (eMerge) {}
  }
}

var _MEM_DEDUPED_BRANCH_MAP = null;

function extractBranchKeyFromSpreadsheetFileName(rawTitle) {
  var s = String(rawTitle || '').trim();
  if (!s) return null;
  // Bersihkan awalan "Copy of " / "Salinan dari " dan akhiran " (1)", " - Copy", dll.
  s = s.replace(/^(?:copy of|salinan dari)\s+/i, '').trim();
  s = s.replace(/\s*\(\d+\)$/, '').replace(/\s*-\s*copy$/i, '').trim();
  var lower = s.toLowerCase();
  var prefixCabang = 'ohsnap_spreadsheet_cabang_';
  if (lower.indexOf(prefixCabang) === 0) {
    var bName = s.substring(prefixCabang.length).trim();
    if (bName) return { type: 'BRANCH', branchRaw: bName, branchLow: bName.toLowerCase() };
  }
  if (lower.indexOf('ohsnap_spreadsheet_') === 0) {
    return { type: 'OBSOLETE_REPORT_SHEET', branchRaw: '', branchLow: '' };
  }
  return null;
}

// Otomatis cari semua file OhSnap_Spreadsheet_*, pilih 1 file yang berisi data paling banyak per cabang,
// gabungkan jika ada data tercecer, dan buang ke Sampah (Trash) semua file Spreadsheet duplikat/kosong!
function deduplicateAllBranchSpreadsheetsInDrive(forceRescan) {
  if (!forceRescan && _MEM_DEDUPED_BRANCH_MAP) {
    return _MEM_DEDUPED_BRANCH_MAP;
  }
  var folder = getFolderAbsen();
  var props = PropertiesService.getScriptProperties();
  var filesByBranchLower = {};
  var obsoleteFiles = [];
  var configJsonFiles = [];
  var seenFileIds = {};
  var summaryLog = [];

  function collectFromIterator(fileIter) {
    if (!fileIter) return;
    while (fileIter.hasNext()) {
      try {
        var f = fileIter.next();
        if (!f || f.isTrashed()) continue;
        var fId = f.getId();
        if (seenFileIds[fId]) continue;
        var fName = String(f.getName() || '').trim();
        if (fName === CLOUD_CONFIG_FILENAME) {
          seenFileIds[fId] = true;
          configJsonFiles.push(f);
          continue;
        }
        var parsedName = extractBranchKeyFromSpreadsheetFileName(fName);
        if (!parsedName) continue;
        seenFileIds[fId] = true;
        if (parsedName.type === 'OBSOLETE_REPORT_SHEET') {
          obsoleteFiles.push(f);
          continue;
        }
        var bLow = parsedName.branchLow;
        if (!filesByBranchLower[bLow]) {
          filesByBranchLower[bLow] = { displayBranch: parsedName.branchRaw, files: [] };
        }
        filesByBranchLower[bLow].files.push(f);
      } catch (eItem) {}
    }
  }

  try { collectFromIterator(folder.getFiles()); } catch (eF1) {}
  try { collectFromIterator(DriveApp.searchFiles("title contains 'OhSnap_Spreadsheet_' and trashed = false")); } catch (eF2) {}

  // Hapus file OhSnap_Spreadsheet_<NamaLaporan> lama yang bukan per-cabang jika ada
  for (var ob = 0; ob < obsoleteFiles.length; ob++) {
    try {
      obsoleteFiles[ob].setTrashed(true);
      summaryLog.push('Trashed obsolete sheet: ' + obsoleteFiles[ob].getName());
    } catch (eOb) {}
  }

  // Jika ada duplikat file OhSnap_Cloud_Config_Pusat.json, simpan yang paling baru saja
  if (configJsonFiles.length > 1) {
    configJsonFiles.sort(function(a, b) {
      var tA = a.getLastUpdated() ? a.getLastUpdated().getTime() : 0;
      var tB = b.getLastUpdated() ? b.getLastUpdated().getTime() : 0;
      return tB - tA;
    });
    for (var cj = 1; cj < configJsonFiles.length; cj++) {
      try { configJsonFiles[cj].setTrashed(true); } catch (eCj) {}
    }
  }

  var winnersByBranchLower = {};
  for (var bLow in filesByBranchLower) {
    if (!Object.prototype.hasOwnProperty.call(filesByBranchLower, bLow)) continue;
    var group = filesByBranchLower[bLow];
    var list = group.files;
    if (!list || list.length === 0) continue;

    if (list.length === 1) {
      var singleFile = list[0];
      var singleId = singleFile.getId();
      var canonicalName = 'OhSnap_Spreadsheet_Cabang_' + group.displayBranch;
      try {
        if (singleFile.getName() !== canonicalName) singleFile.setName(canonicalName);
      } catch (eRen1) {}
      try {
        if (SEC_ALLOW_PUBLIC_DRIVE_LINKS) { singleFile.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); }
      } catch (eSh1) {}
      props.setProperty(getBranchPropKey(group.displayBranch), singleId);
      winnersByBranchLower[bLow] = {
        branch: group.displayBranch,
        spreadsheetId: singleId,
        spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/' + singleId + '/edit'
      };
      continue;
    }

    // Jika ada > 1 Spreadsheet untuk cabang yang sama, periksa jumlah baris datanya!
    var evaluated = [];
    for (var i = 0; i < list.length; i++) {
      var fObj = list[i];
      var ssObj = null;
      var rowCnt = 0;
      var createdMs = 0;
      try { createdMs = fObj.getDateCreated() ? fObj.getDateCreated().getTime() : 0; } catch (eDt) {}
      try {
        ssObj = SpreadsheetApp.openById(fObj.getId());
        rowCnt = countTotalDataRowsInSpreadsheet(ssObj);
      } catch (eOpen) {
        ssObj = null;
      }
      if (ssObj) {
        evaluated.push({ file: fObj, ss: ssObj, rows: rowCnt, createdMs: createdMs });
      }
    }

    if (evaluated.length === 0) continue;

    // Urutkan: jumlah baris data TERBANYAK menang; jika sama-sama punya data (atau sama-sama 0), pilih yang paling awal dibuat (original)
    evaluated.sort(function(a, b) {
      if (b.rows !== a.rows) return b.rows - a.rows;
      return a.createdMs - b.createdMs;
    });

    var winner = evaluated[0];
    var canonicalWinName = 'OhSnap_Spreadsheet_Cabang_' + group.displayBranch;
    try {
      if (winner.file.getName() !== canonicalWinName) {
        winner.file.setName(canonicalWinName);
      }
    } catch (eRenWin) {}

    for (var j = 1; j < evaluated.length; j++) {
      var dup = evaluated[j];
      try {
        if (dup.rows > 0) {
          mergeDataRowsFromDuplicateSpreadsheet(dup.ss, winner.ss);
        }
        dup.file.setTrashed(true);
        summaryLog.push('Trashed duplicate [' + group.displayBranch + '] ID=' + dup.file.getId() + ' (rows=' + dup.rows + ')');
      } catch (eTrash) {}
    }

    try {
      if (typeof winner.file.moveTo === 'function') {
        winner.file.moveTo(folder);
      }
    } catch (eMove) {}
    try {
      if (SEC_ALLOW_PUBLIC_DRIVE_LINKS) { winner.file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); }
    } catch (eShWin) {}

    var winId = winner.file.getId();
    props.setProperty(getBranchPropKey(group.displayBranch), winId);
    summaryLog.push('Kept winner [' + group.displayBranch + '] ID=' + winId + ' (rows=' + winner.rows + ')');
    winnersByBranchLower[bLow] = {
      branch: group.displayBranch,
      spreadsheetId: winId,
      spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/' + winId + '/edit',
      ss: winner.ss
    };
  }

  winnersByBranchLower.summaryLog = summaryLog;
  _MEM_DEDUPED_BRANCH_MAP = winnersByBranchLower;
  return winnersByBranchLower;
}

// Buka atau buat Spreadsheet khusus untuk Cabang tertentu (Anti-Duplikat & Otomatis Bersihkan Duplikat!)
function getOrCreateBranchSpreadsheet(cabangName, customSpreadsheetIdFromWeb, allowCreateIfMissing) {
  if (allowCreateIfMissing === undefined) allowCreateIfMissing = true;
  var cleanCabang = String(cabangName || 'Cilacap').trim();
  var cleanLow = cleanCabang.toLowerCase();
  var props = PropertiesService.getScriptProperties();
  var propKey = getBranchPropKey(cleanCabang);

  // 1. Bersihkan duplikat terlebih dahulu & cek apakah file Spreadsheet cabang ini sudah ada di Google Drive
  var dedupMap = deduplicateAllBranchSpreadsheetsInDrive();
  if (dedupMap[cleanLow]) {
    try {
      var ssExisting = dedupMap[cleanLow].ss || SpreadsheetApp.openById(dedupMap[cleanLow].spreadsheetId);
      if (ssExisting) {
        props.setProperty(propKey, ssExisting.getId());
        ensureBranch8SheetsTemplate(ssExisting);
        return ssExisting;
      }
    } catch (eDedupOpen) {}
  }

  // 2. Cek configuredId atau savedId jika belum ditemukan dari nama file
  var configuredId = extractSpreadsheetIdFromInput(customSpreadsheetIdFromWeb) ||
                     extractSpreadsheetIdFromInput(BRANCH_SPREADSHEET_IDS[cleanCabang]) ||
                     props.getProperty(propKey);
  if (configuredId) {
    try {
      var fCheck = DriveApp.getFileById(configuredId);
      if (fCheck && !fCheck.isTrashed()) {
        var ssSaved = SpreadsheetApp.openById(configuredId);
        if (ssSaved) {
          props.setProperty(propKey, ssSaved.getId());
          ensureBranch8SheetsTemplate(ssSaved);
          return ssSaved;
        }
      }
    } catch (eSaved) {}
  }

  if (!allowCreateIfMissing) {
    return null;
  }

  // 3. Hanya buat Spreadsheet baru jika benar-benar belum ada 1 pun untuk cabang ini di Drive
  var folder = getFolderAbsen();
  var fileName = 'OhSnap_Spreadsheet_Cabang_' + cleanCabang;
  var ssBranch = SpreadsheetApp.create(fileName);
  try {
    var fileObj = DriveApp.getFileById(ssBranch.getId());
    if (typeof fileObj.moveTo === 'function') {
      fileObj.moveTo(folder);
    } else if (typeof folder.addFile === 'function') {
      folder.addFile(fileObj);
    }
  } catch (moveErr) {}

  props.setProperty(propKey, ssBranch.getId());
  ensureBranch8SheetsTemplate(ssBranch);
  return ssBranch;
}

// ============================================================================
// SISTEM PENYIMPANAN CLOUD CONFIG TANPA BATAS 9KB (CHUNKED PROPERTIES + DRIVE)
// ============================================================================
function saveCloudConfigToChunks(rawJsonString, writeDriveBackup) {
  if (!rawJsonString) return;
  rawJsonString = secStripConfigSecrets_(rawJsonString);
  var props = PropertiesService.getScriptProperties();
  var chunkSize = 3800; // Aman di bawah batas 9KB per property Google Apps Script
  var totalChunks = Math.ceil(rawJsonString.length / chunkSize);
  var batch = {};
  for (var i = 0; i < totalChunks; i++) {
    batch['OHSNAP_CFG_CHUNK_' + i] = rawJsonString.substring(i * chunkSize, (i + 1) * chunkSize);
  }
  batch['OHSNAP_CFG_CHUNK_COUNT'] = String(totalChunks);
  batch['OHSNAP_CFG_UPDATED_AT'] = String(new Date().getTime());
  if (rawJsonString.length < 8500) {
    batch['OHSNAP_CLOUD_CONFIG_JSON'] = rawJsonString;
  }
  props.setProperties(batch, false);

  if (writeDriveBackup) {
    try {
      var folder = getFolderAbsen();
      var files = folder.getFilesByName(CLOUD_CONFIG_FILENAME);
      if (files.hasNext()) {
        var existingFile = files.next();
        existingFile.setContent(rawJsonString);
      } else {
        folder.createFile(CLOUD_CONFIG_FILENAME, rawJsonString, MimeType.PLAIN_TEXT);
      }
    } catch (driveErr) {}
  }
}

function loadCloudConfigFromChunks(skipDriveFallback) {
  var props = PropertiesService.getScriptProperties();
  var countStr = props.getProperty('OHSNAP_CFG_CHUNK_COUNT');
  var raw = '';
  if (countStr && Number(countStr) > 0) {
    var count = Number(countStr);
    var parts = [];
    for (var i = 0; i < count; i++) {
      parts.push(props.getProperty('OHSNAP_CFG_CHUNK_' + i) || '');
    }
    raw = parts.join('');
  }
  if (!raw) {
    raw = props.getProperty('OHSNAP_CLOUD_CONFIG_JSON') || '';
  }
  if (!raw && !skipDriveFallback) {
    try {
      var folder = getFolderAbsen();
      var files = folder.getFilesByName(CLOUD_CONFIG_FILENAME);
      if (files.hasNext()) {
        raw = files.next().getBlob().getDataAsString();
      }
    } catch (e) {}
  }
  if (!raw) return null;
  try {
    var parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      parsed.branchSpreadsheets = parsed.branchSpreadsheets || {};
      var bList = Array.isArray(parsed.branches) ? parsed.branches : DAFTAR_5_CABANG_UTAMA;
      for (var j = 0; j < bList.length; j++) {
        var bName = bList[j];
        var pKey = getBranchPropKey(bName);
        var savedSsId = props.getProperty(pKey) || '';
        if (savedSsId && (!parsed.branchSpreadsheets[bName] || !parsed.branchSpreadsheets[bName].spreadsheetId)) {
          parsed.branchSpreadsheets[bName] = {
            spreadsheetId: savedSsId,
            spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/' + savedSsId + '/edit',
            updatedAt: new Date().toISOString()
          };
        }
      }
    }
    return parsed;
  } catch (err) {
    return null;
  }
}


// ============================================================================
// FITUR OTOMATIS HAPUS BARIS SPREADSHEET & FILE FOTO GOOGLE DRIVE SAAT DIHAPUS DI WEB ADMIN
// ============================================================================
function normalizeGsDateCell(rawVal, displayVal) {
  var s = String(displayVal || '').trim();
  if (s) {
    var mIso = s.match(/(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
    if (mIso) {
      return mIso[1] + '-' + ('0' + mIso[2]).slice(-2) + '-' + ('0' + mIso[3]).slice(-2);
    }
    var mDmy = s.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
    if (mDmy) {
      return mDmy[3] + '-' + ('0' + mDmy[2]).slice(-2) + '-' + ('0' + mDmy[1]).slice(-2);
    }
  }
  if (rawVal && Object.prototype.toString.call(rawVal) === '[object Date]' && !isNaN(rawVal.getTime())) {
    try {
      return Utilities.formatDate(rawVal, 'Asia/Jakarta', 'yyyy-MM-dd');
    } catch (e) {}
  }
  var sRaw = String(rawVal || '').trim();
  var mIso2 = sRaw.match(/(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
  if (mIso2) {
    return mIso2[1] + '-' + ('0' + mIso2[2]).slice(-2) + '-' + ('0' + mIso2[3]).slice(-2);
  }
  return s ? s.slice(0, 10) : '';
}

function normalizeGsTimeFull(rawVal, displayVal) {
  var s = String(displayVal || '').replace(/WIB/i, '').trim().replace(/\./g, ':');
  var m = s.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (m) {
    return ('0' + m[1]).slice(-2) + ':' + m[2] + ':' + (m[3] ? ('0' + m[3]).slice(-2) : '00');
  }
  if (rawVal && Object.prototype.toString.call(rawVal) === '[object Date]' && !isNaN(rawVal.getTime())) {
    try {
      return Utilities.formatDate(rawVal, 'Asia/Jakarta', 'HH:mm:ss');
    } catch (e) {}
  }
  var sRaw = String(rawVal || '').replace(/WIB/i, '').trim().replace(/\./g, ':');
  var m2 = sRaw.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (m2) {
    return ('0' + m2[1]).slice(-2) + ':' + m2[2] + ':' + (m2[3] ? ('0' + m2[3]).slice(-2) : '00');
  }
  return '';
}

function normalizeGsTimePrefix(rawVal, displayVal) {
  var full = normalizeGsTimeFull(rawVal, displayVal);
  return full ? full.slice(0, 5) : '';
}

function resolveSynchronizedWibDateTime(rawTanggal, rawWaktu) {
  var nowServer = new Date();
  var serverTanggal = Utilities.formatDate(nowServer, 'Asia/Jakarta', 'yyyy-MM-dd');
  var serverWaktu = Utilities.formatDate(nowServer, 'Asia/Jakarta', 'HH:mm:ss');
  var tgl = normalizeGsDateCell(null, rawTanggal) || serverTanggal;
  var wkt = normalizeGsTimeFull(null, rawWaktu) || serverWaktu;
  var sParts = serverWaktu.split(':');
  var cParts = wkt.split(':');
  if (sParts.length >= 2 && cParts.length >= 2) {
    var sMins = parseInt(sParts[0], 10) * 60 + parseInt(sParts[1], 10);
    var cMins = parseInt(cParts[0], 10) * 60 + parseInt(cParts[1], 10);
    // Jika jam dari perangkat melenceng > 5 menit dari waktu server WIB (atau jam di masa depan pada hari ini),
    // paksa gunakan serverWaktu WIB asli agar tidak pernah ada jam masa depan (seperti jam 14/15 saat masih jam 9 pagi)
    if (Math.abs(cMins - sMins) > 5 || (tgl === serverTanggal && cMins > sMins + 2)) {
      wkt = serverWaktu;
    }
  }
  return { tanggal: tgl, waktu: wkt, timestampDate: nowServer };
}

function normalizeGsShiftName(rawShift) {
  var s = String(rawShift || '').trim();
  if (!s || s === '-') return 'Shift Pagi';
  if (/sore|siang/i.test(s)) return 'Shift Sore';
  if (/middle|mid/i.test(s)) return 'Shift Middle';
  if (/long/i.test(s)) return 'Shift Longshift';
  if (/pagi/i.test(s)) return 'Shift Pagi';
  return s;
}

function parseGsNominalRibuan(rawVal) {
  if (rawVal === null || rawVal === undefined || rawVal === '') return 0;
  if (typeof rawVal === 'number') {
    if (rawVal > 0 && rawVal < 1000) return Math.round(rawVal * 1000);
    return Math.max(0, Math.round(rawVal));
  }
  var cleanStr = String(rawVal).trim().replace(/[,.]00$/, '');
  var s = cleanStr.replace(/[^0-9]/g, '');
  if (!s) return 0;
  var n = parseInt(s, 10) || 0;
  if (n > 0 && n < 1000) n = n * 1000;
  return n;
}

function getGsRevisionSlotKey(item) {
  if (!item || typeof item !== 'object') return '';
  var rt = String(item.recordType || 'DAILY_REPORT').trim().toUpperCase();
  var st = String(item.subType || '').trim().toUpperCase();
  var cb = String(item.cabang || 'Cilacap').trim().toLowerCase();
  var dt = normalizeGsDateCell(null, item.tanggal || item.cutoffDate || item.incomingDate || '');
  var sh = normalizeGsShiftName(item.shift).toLowerCase();
  if (rt === 'ABSEN_MUKA') {
    var nm = String(item.nama || '').trim().toLowerCase();
    return rt + '|' + st + '|' + cb + '|' + dt + '|' + sh + '|' + nm;
  }
  return rt + '|' + st + '|' + cb + '|' + dt + '|' + sh;
}

function syncOpLogsTimeFromBranchSpreadsheets(cfg) {
  if (!cfg || typeof cfg !== 'object') return cfg;
  try {
    cfg.opLogsSummary = Array.isArray(cfg.opLogsSummary) ? cfg.opLogsSummary : [];
    var nowServer = new Date();
    var todayWib = Utilities.formatDate(nowServer, 'Asia/Jakarta', 'yyyy-MM-dd');
    var nowHm = Utilities.formatDate(nowServer, 'Asia/Jakarta', 'HH:mm').split(':');
    var nowMins = parseInt(nowHm[0], 10) * 60 + parseInt(nowHm[1], 10);
    var changed = false;

    for (var i = 0; i < cfg.opLogsSummary.length; i++) {
      var item = cfg.opLogsSummary[i];
      if (!item) continue;
      var normTgl = normalizeGsDateCell(null, item.tanggal) || todayWib;
      var normWkt = normalizeGsTimeFull(null, item.waktu);
      var normSh = normalizeGsShiftName(item.shift);
      if (item.shift !== normSh) { item.shift = normSh; changed = true; }
      if (item.recordType === 'DAILY_REPORT') {
        var cVal = parseGsNominalRibuan(item.cash);
        var qVal = parseGsNominalRibuan(item.qris);
        var eVal = parseGsNominalRibuan(item.totalExpense);
        var rawG = parseGsNominalRibuan(item.totalGross);
        var rawN = parseGsNominalRibuan(item.netOmzet);
        if (cVal === 0 && qVal === 0) {
          if (rawG > 0) cVal = rawG;
          else if (rawN > 0) cVal = rawN + eVal;
        }
        var gVal = (cVal + qVal) > 0 ? (cVal + qVal) : rawG;
        var nVal = gVal - eVal;
        if (item.cash !== cVal || item.qris !== qVal || item.totalGross !== gVal) {
          item.cash = cVal; item.qris = qVal; item.totalGross = gVal; item.totalExpense = eVal; item.netOmzet = nVal;
          changed = true;
        }
      }
      if (normWkt) {
        var wp = normWkt.split(':');
        var hh = parseInt(wp[0], 10);
        var mm = parseInt(wp[1], 10);
        var itemMins = hh * 60 + mm;
        if (normTgl === todayWib && itemMins > nowMins + 15 && hh >= 7) {
          normWkt = ('0' + (hh - 7)).slice(-2) + ':' + wp[1] + ':' + (wp[2] || '00');
          changed = true;
        }
        if (item.waktu !== normWkt) {
          item.waktu = normWkt;
          changed = true;
        }
      }
      if (item.tanggal !== normTgl) {
        item.tanggal = normTgl;
        changed = true;
      }
    }

    var dedupedDriveMap = deduplicateAllBranchSpreadsheetsInDrive(false);
    var cache = CacheService.getScriptCache();
    if (cache && cache.get('OHSNAP_SHEET_TIME_SYNC_LOCK')) {
      if (changed) saveCloudConfigToChunks(JSON.stringify(cfg), true);
      return cfg;
    }
    if (cache) cache.put('OHSNAP_SHEET_TIME_SYNC_LOCK', '1', 12);
    var props = PropertiesService.getScriptProperties();
    cfg.branchSpreadsheets = cfg.branchSpreadsheets || {};
    for (var dKey in dedupedDriveMap) {
      if (Object.prototype.hasOwnProperty.call(dedupedDriveMap, dKey)) {
        var dInfo = dedupedDriveMap[dKey];
        cfg.branchSpreadsheets[dInfo.branch] = {
          spreadsheetId: dInfo.spreadsheetId,
          spreadsheetUrl: dInfo.spreadsheetUrl,
          updatedAt: new Date().toISOString()
        };
      }
    }
    var bMap = cfg.branchSpreadsheets || {};
    var branches = Array.isArray(cfg.branches) ? cfg.branches : DAFTAR_5_CABANG_UTAMA;
    var importedFromSheets = [];
    var openedBranchesMap = {};
    var validSheetSlotKeysMap = {};

    var rootDriveFolder = null;
    var scannedSpreadsheetIds = {};
    var scanTargets = branches.slice();
    for (var opIdx = 0; opIdx < cfg.opLogsSummary.length; opIdx++) {
      var opCb = String((cfg.opLogsSummary[opIdx] && cfg.opLogsSummary[opIdx].cabang) || '').trim();
      if (opCb && scanTargets.indexOf(opCb) === -1) {
        scanTargets.push(opCb);
      }
    }
    if (SPREADSHEET_ID_PUSAT) {
      scanTargets.push('__PUSAT__');
    }
    for (var bIdx = 0; bIdx < scanTargets.length; bIdx++) {
      var rawTarget = String(scanTargets[bIdx] || '').trim();
      if (!rawTarget) continue;
      var isPusatFallback = (rawTarget === '__PUSAT__');
      var bName = isPusatFallback ? 'Cilacap' : rawTarget;
      if (!isPusatFallback) {
        openedBranchesMap[bName.toLowerCase()] = true;
      }
      var ssId = isPusatFallback
        ? SPREADSHEET_ID_PUSAT
        : ((bMap[bName] && bMap[bName].spreadsheetId) || props.getProperty(getBranchPropKey(bName)) || (BRANCH_SPREADSHEET_IDS && BRANCH_SPREADSHEET_IDS[bName]) || '');
      var ss = null;
      if (ssId) {
        try { ss = SpreadsheetApp.openById(extractSpreadsheetIdFromInput(ssId)); } catch (eOpen) { ss = null; }
      }
      if (!ss && !isPusatFallback) {
        try {
          if (!rootDriveFolder) rootDriveFolder = getFolderAbsen();
          var fIter = rootDriveFolder.getFilesByName('OhSnap_Spreadsheet_Cabang_' + bName);
          if (fIter.hasNext()) {
            ss = SpreadsheetApp.open(fIter.next());
          }
        } catch (eFindDrive) { ss = null; }
      }
      if (!ss) continue;
      var foundId = ss.getId();
      if (scannedSpreadsheetIds[foundId]) continue;
      scannedSpreadsheetIds[foundId] = true;
      if (!isPusatFallback) {
        props.setProperty(getBranchPropKey(bName), foundId);
        cfg.branchSpreadsheets = cfg.branchSpreadsheets || {};
        if (!cfg.branchSpreadsheets[bName] || cfg.branchSpreadsheets[bName].spreadsheetId !== foundId) {
          cfg.branchSpreadsheets[bName] = {
            spreadsheetId: foundId,
            spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/' + foundId + '/edit',
            updatedAt: new Date().toISOString()
          };
          changed = true;
        }
      }

      // 1. Baca Laporan_Harian (Termasuk Shift Sore & Status Revisi)
      var shLap = ss.getSheetByName('Laporan_Harian');
      if (shLap && shLap.getLastRow() >= 2) {
        try {
          var hdr18 = String(shLap.getRange(1, 18).getDisplayValue() || '').trim();
          if (hdr18 !== 'Status Revisi') {
            shLap.getRange(1, 18).setValue('Status Revisi').setFontWeight('bold').setBackground('#19449a').setFontColor('#ffffff');
          }
        } catch (eHdr) {}
        var lastR = shLap.getLastRow();
        var startR = Math.max(2, lastR - 45);
        var numR = lastR - startR + 1;
        var maxCols = Math.max(18, shLap.getLastColumn());
        var rawVals = shLap.getRange(startR, 1, numR, maxCols).getValues();
        var dispVals = shLap.getRange(startR, 1, numR, maxCols).getDisplayValues();
        var slotCounter = {};
        for (var r = 0; r < numR; r++) {
          var rDate = normalizeGsDateCell(rawVals[r][1], dispVals[r][1]);
          if (!rDate) continue;
          var rTime = normalizeGsTimeFull(rawVals[r][2], dispVals[r][2]);
          var tsTime = (rawVals[r][0] && Object.prototype.toString.call(rawVals[r][0]) === '[object Date]')
            ? Utilities.formatDate(rawVals[r][0], 'Asia/Jakarta', 'HH:mm:ss')
            : '';
          if (rTime && tsTime) {
            var rH = parseInt(rTime.split(':')[0], 10);
            var tsH = parseInt(tsTime.split(':')[0], 10);
            if (Math.abs(rH - tsH) >= 5) {
              rTime = tsTime;
              try { shLap.getRange(startR + r, 3).setValue(tsTime); } catch (eSet) {}
            }
          }
          if (rTime && rDate === todayWib) {
            var rp = rTime.split(':');
            var rHh = parseInt(rp[0], 10);
            var rMm = parseInt(rp[1] || '0', 10);
            if ((rHh * 60 + rMm) > nowMins + 3 && rHh >= 7) {
              rTime = ('0' + (rHh - 7)).slice(-2) + ':' + ('0' + rMm).slice(-2) + ':' + (rp[2] || '00');
              try { shLap.getRange(startR + r, 3).setValue(rTime); } catch (eSet2) {}
            }
          }
          var rCabang = String(dispVals[r][3] || bName).trim() || bName;
          var rShift = normalizeGsShiftName(dispVals[r][4]);
          var rNama = String(dispVals[r][5] || 'Kru').trim();
          var rCash = parseGsNominalRibuan(rawVals[r][6] !== undefined && rawVals[r][6] !== '' ? rawVals[r][6] : dispVals[r][6]);
          var rQris = parseGsNominalRibuan(rawVals[r][7] !== undefined && rawVals[r][7] !== '' ? rawVals[r][7] : dispVals[r][7]);
          var rGrossCol = parseGsNominalRibuan(rawVals[r][8] !== undefined && rawVals[r][8] !== '' ? rawVals[r][8] : dispVals[r][8]);
          var rExp = parseGsNominalRibuan(rawVals[r][9] !== undefined && rawVals[r][9] !== '' ? rawVals[r][9] : dispVals[r][9]);
          var rNetCol = parseGsNominalRibuan(rawVals[r][11] !== undefined && rawVals[r][11] !== '' ? rawVals[r][11] : dispVals[r][11]);
          if (rCash === 0 && rQris === 0) {
            if (rGrossCol > 0) {
              rCash = rGrossCol;
            } else if (rNetCol > 0) {
              rCash = rNetCol + rExp;
            }
          }
          var rGross = (rCash + rQris) > 0 ? (rCash + rQris) : (rGrossCol > 0 ? rGrossCol : (rNetCol > 0 ? rNetCol + rExp : 0));
          var rNet = (rGross - rExp) > 0 ? (rGross - rExp) : rNetCol;
          var rRincian = String(dispVals[r][10] || '-').trim();
          var rLinkSerah = String(dispVals[r][12] || '').trim();
          var rFolderSerah = String(dispVals[r][13] || '').trim();
          var rLinkStruk = String(dispVals[r][14] || '').trim();
          var rFolderStruk = String(dispVals[r][15] || '').trim();
          var rCatatan = String(dispVals[r][16] || '').trim();
          var slotK = 'DAILY_REPORT||' + rCabang.toLowerCase() + '|' + rDate + '|' + rShift.toLowerCase();
          var countSoFar = slotCounter[slotK] || 0;
          slotCounter[slotK] = countSoFar + 1;
          var computedRevStatus = countSoFar === 0 ? 'Laporan Awal' : ('Revisi Ke-' + countSoFar);
          var cellRevStatus = String(dispVals[r][17] || '').trim();
          if (!cellRevStatus) {
            cellRevStatus = computedRevStatus;
            try { shLap.getRange(startR + r, 18).setValue(cellRevStatus); } catch (eRevSet) {}
          }
          importedFromSheets.push({
            id: 'SHT-RPT-' + rCabang.replace(/[^a-zA-Z0-9]/g, '') + '-' + rDate + '-' + rShift.replace(/\s+/g, '') + '-' + (startR + r),
            recordType: 'DAILY_REPORT',
            label: '📝 Laporan Keuangan Harian',
            cabang: rCabang,
            tanggal: rDate,
            waktu: rTime || tsTime || '12:00:00',
            shift: rShift,
            nama: rNama,
            cash: rCash,
            qris: rQris,
            totalGross: rGross,
            totalExpense: rExp,
            netOmzet: rNet,
            rincianPengeluaran: rRincian,
            fotoSerahTerima: toGsDriveThumbnailUrl(rLinkSerah),
            fotoSerahDriveUrl: rLinkSerah,
            folderSerahDriveUrl: rFolderSerah,
            fotoStruk: toGsDriveThumbnailUrl(rLinkStruk),
            fotoStrukDriveUrl: rLinkStruk,
            folderStrukDriveUrl: rFolderStruk,
            statusRevisi: cellRevStatus,
            revisionCount: countSoFar,
            summary: 'Cash: Rp ' + rCash.toLocaleString('id-ID') + ' | QRIS: Rp ' + rQris.toLocaleString('id-ID') + ' | Keluar: Rp ' + rExp.toLocaleString('id-ID') + ' | Bersih: Rp ' + rNet.toLocaleString('id-ID'),
            catatan: rCatatan
          });
        }
      }

      // 2. Baca Absen_Masuk & Absen_Keluar
      var absSheets = [
        { name: 'Absen_Masuk', subType: 'MUKA_DATANG', label: '🤳 Absen Karyawan (Datang)' },
        { name: 'Absen_Keluar', subType: 'MUKA_PULANG', label: '🏡 Absen Karyawan (Pulang)' }
      ];
      for (var aIdx = 0; aIdx < absSheets.length; aIdx++) {
        var asCfg = absSheets[aIdx];
        var shAbs = ss.getSheetByName(asCfg.name);
        if (!shAbs || shAbs.getLastRow() < 2) continue;
        var lastRA = shAbs.getLastRow();
        var startRA = Math.max(2, lastRA - 30);
        var numRA = lastRA - startRA + 1;
        var rawA = shAbs.getRange(startRA, 1, numRA, 13).getValues();
        var dispA = shAbs.getRange(startRA, 1, numRA, 13).getDisplayValues();
        for (var ra = 0; ra < numRA; ra++) {
          var aDate = normalizeGsDateCell(rawA[ra][1], dispA[ra][1]);
          if (!aDate) continue;
          var aTime = normalizeGsTimeFull(rawA[ra][2], dispA[ra][2]);
          var aCabang = String(dispA[ra][3] || bName).trim() || bName;
          var aNama = String(dispA[ra][4] || 'Kru').trim();
          var aShift = normalizeGsShiftName(dispA[ra][5]);
          var aJadwal = String(dispA[ra][6] || '').trim();
          var aStat = String(dispA[ra][7] || 'TEPAT WAKTU').trim();
          var aDet = String(dispA[ra][8] || aStat).trim();
          var aGps = String(dispA[ra][9] || '').trim();
          var aFotoUrl = String(dispA[ra][10] || '').trim();
          var aFolderUrl = String(dispA[ra][11] || '').trim();
          var aCat = String(dispA[ra][12] || '').trim();
          var aThumb = toGsDriveThumbnailUrl(aFotoUrl);
          importedFromSheets.push({
            id: 'SHT-ABS-' + asCfg.subType + '-' + aCabang.replace(/[^a-zA-Z0-9]/g, '') + '-' + aDate + '-' + (startRA + ra),
            recordType: 'ABSEN_MUKA',
            subType: asCfg.subType,
            label: asCfg.label,
            cabang: aCabang,
            tanggal: aDate,
            waktu: aTime || '09:00:00',
            shift: aShift,
            shiftScheduleLabel: aJadwal,
            punctualityStatus: aStat,
            punctualityDetail: aDet,
            nama: aNama,
            lokasiWatermark: aGps,
            fotoBukti: aThumb,
            fotoDriveUrl: aFotoUrl,
            folderDriveUrl: aFolderUrl,
            summary: asCfg.label + ' • ' + aDet,
            catatan: aCat
          });
        }
      }

      // 3. Baca open_Store & Close_Store
      var stSheets = [
        { name: 'open_Store', recType: 'OPEN_STORE', subType: 'OPEN_BOOTH', label: '☀️ Open Store', chkCol: 7, gpsCol: 8, fotoCol: 9, folderCol: 10, catCol: 11 },
        { name: 'Close_Store', recType: 'CLOSE_STORE', subType: 'CLOSE_BOOTH', label: '🌙 Close Store', chkCol: 8, gpsCol: 9, fotoCol: 10, folderCol: 11, catCol: 12 }
      ];
      for (var stIdx = 0; stIdx < stSheets.length; stIdx++) {
        var stCfg = stSheets[stIdx];
        var shSt = ss.getSheetByName(stCfg.name);
        if (!shSt || shSt.getLastRow() < 2) continue;
        var lastRS = shSt.getLastRow();
        var startRS = Math.max(2, lastRS - 25);
        var numRS = lastRS - startRS + 1;
        var rawS = shSt.getRange(startRS, 1, numRS, 13).getValues();
        var dispS = shSt.getRange(startRS, 1, numRS, 13).getDisplayValues();
        for (var rs = 0; rs < numRS; rs++) {
          var sDate = normalizeGsDateCell(rawS[rs][1], dispS[rs][1]);
          if (!sDate) continue;
          var sTime = normalizeGsTimeFull(rawS[rs][2], dispS[rs][2]);
          var sCabang = String(dispS[rs][3] || bName).trim() || bName;
          var sShift = normalizeGsShiftName(dispS[rs][4]);
          var sJadwal = String(dispS[rs][5] || '').trim();
          var sNama = String(dispS[rs][6] || 'Kru').trim();
          var sChk = String(dispS[rs][stCfg.chkCol] || stCfg.label).trim();
          var sGps = String(dispS[rs][stCfg.gpsCol] || '').trim();
          var sFotoUrl = String(dispS[rs][stCfg.fotoCol] || '').trim();
          var sFolderUrl = String(dispS[rs][stCfg.folderCol] || '').trim();
          var sCat = String(dispS[rs][stCfg.catCol] || '').trim();
          importedFromSheets.push({
            id: 'SHT-STR-' + stCfg.recType + '-' + sCabang.replace(/[^a-zA-Z0-9]/g, '') + '-' + sDate + '-' + (startRS + rs),
            recordType: stCfg.recType,
            subType: stCfg.subType,
            label: stCfg.label,
            cabang: sCabang,
            tanggal: sDate,
            waktu: sTime || '10:00:00',
            shift: sShift,
            shiftScheduleLabel: sJadwal,
            nama: sNama,
            lokasiWatermark: sGps,
            fotoBukti: toGsDriveThumbnailUrl(sFotoUrl),
            fotoDriveUrl: sFotoUrl,
            folderDriveUrl: sFolderUrl,
            summary: sChk,
            catatan: sCat
          });
        }
      }

      // 4. Baca Stock_Opname
      var shStok = ss.getSheetByName('Stock_Opname');
      if (shStok && shStok.getLastRow() >= 2) {
        var lastRStok = shStok.getLastRow();
        var startRStok = Math.max(2, lastRStok - 25);
        var numRStok = lastRStok - startRStok + 1;
        var maxColStok = Math.max(25, shStok.getLastColumn());
        var rawStok = shStok.getRange(startRStok, 1, numRStok, maxColStok).getValues();
        var dispStok = shStok.getRange(startRStok, 1, numRStok, maxColStok).getDisplayValues();
        for (var rk = 0; rk < numRStok; rk++) {
          var kCabang = String(dispStok[rk][1] || bName).trim() || bName;
          var kRole = String(dispStok[rk][2] || 'USER').trim();
          var kDate = normalizeGsDateCell(rawStok[rk][3], dispStok[rk][3]) || normalizeGsDateCell(rawStok[rk][4], dispStok[rk][4]);
          var kCutoff = normalizeGsDateCell(rawStok[rk][4], dispStok[rk][4]) || kDate;
          if (!kDate) continue;
          var kTime = normalizeGsTimeFull(rawStok[rk][5], dispStok[rk][5]) || '14:00:00';
          var kShift = normalizeGsShiftName(dispStok[rk][6]);
          var kNama = String(dispStok[rk][7] || 'Kru').trim();
          var kBantu = String(dispStok[rk][8] || '').trim();
          if (kBantu === '-') kBantu = '';
          var kCat = String(dispStok[rk][24] || '').trim();
          importedFromSheets.push({
            id: 'SHT-STK-' + kCabang.replace(/[^a-zA-Z0-9]/g, '') + '-' + kCutoff + '-' + kShift.replace(/\s+/g, '') + '-' + (startRStok + rk),
            recordType: 'STOCK_OPNAME',
            senderRole: kRole,
            label: '🛍️ Stock Opname (Cutoff: ' + kCutoff + ')',
            cabang: kCabang,
            tanggal: kDate,
            cutoffDate: kCutoff,
            waktu: kTime,
            shift: kShift,
            nama: kNama,
            petugasBantu: kBantu,
            kertasPax: dispStok[rk][9],
            hangtagKecilPcs: dispStok[rk][10],
            hangtagBesarPcs: dispStok[rk][11],
            keychainPanjangPcs: dispStok[rk][12],
            keychainBulatPcs: dispStok[rk][13],
            plastikKecilIkat: dispStok[rk][14],
            plastikBesarIkat: dispStok[rk][15],
            tintaLmPct: dispStok[rk][16],
            tintaLcPct: dispStok[rk][17],
            tintaYPct: dispStok[rk][18],
            tintaMPct: dispStok[rk][19],
            tintaCPct: dispStok[rk][20],
            tintaKPct: dispStok[rk][21],
            lemGanciPcs: dispStok[rk][22],
            summary: '[BRG-001] Kertas: ' + dispStok[rk][9] + ' | [BRG-002] Hangtag Kecil: ' + dispStok[rk][10] + ' | [BRG-003] Hangtag Besar: ' + dispStok[rk][11] + ' | [BRG-004] Keychain Panjang: ' + dispStok[rk][12] + ' | [BRG-005] Keychain Bulat: ' + dispStok[rk][13],
            catatan: kCat
          });
        }
      }

      // 5. Baca Barang_Datang (Gabungkan baris item pada slot Tanggal+Cabang+Shift yang sama)
      var shInc = ss.getSheetByName('Barang_Datang');
      if (shInc && shInc.getLastRow() >= 2) {
        var lastRInc = shInc.getLastRow();
        var startRInc = Math.max(2, lastRInc - 40);
        var numRInc = lastRInc - startRInc + 1;
        var maxColInc = Math.max(18, shInc.getLastColumn());
        var rawInc = shInc.getRange(startRInc, 1, numRInc, maxColInc).getValues();
        var dispInc = shInc.getRange(startRInc, 1, numRInc, maxColInc).getDisplayValues();
        var groupedIncBySlot = {};
        for (var ri = 0; ri < numRInc; ri++) {
          var iCabang = String(dispInc[ri][1] || bName).trim() || bName;
          var iRole = String(dispInc[ri][2] || 'USER').trim();
          var iDate = normalizeGsDateCell(rawInc[ri][3], dispInc[ri][3]) || normalizeGsDateCell(rawInc[ri][4], dispInc[ri][4]);
          var iIncDate = normalizeGsDateCell(rawInc[ri][4], dispInc[ri][4]) || iDate;
          if (!iDate) continue;
          var iNama = String(dispInc[ri][7] || 'Kru').trim();
          if (iNama.indexOf('Inisialisasi Spreadsheet Cabang') !== -1) continue;
          var iTime = normalizeGsTimeFull(rawInc[ri][5], dispInc[ri][5]) || '11:00:00';
          var iShift = normalizeGsShiftName(dispInc[ri][6]);
          var iBantu = String(dispInc[ri][8] || '').trim();
          if (iBantu === '-') iBantu = '';
          var iCode = String(dispInc[ri][9] || 'BRG-001').trim();
          var iItemName = String(dispInc[ri][10] || '').trim();
          var iCat = String(dispInc[ri][11] || 'Aksesoris').trim();
          var iUnit = String(dispInc[ri][12] || 'Pcs').trim();
          var iBefore = Number(dispInc[ri][13]) || 0;
          var iAdded = Number(dispInc[ri][14]) || 0;
          var iAfter = Number(dispInc[ri][15]) || (iBefore + iAdded);
          var iPosSum = String(dispInc[ri][16] || '').trim();
          var iNotes = String(dispInc[ri][17] || '').trim();
          var incKey = iCabang.toLowerCase() + '|' + iIncDate + '|' + iShift.toLowerCase() + '|' + iTime.slice(0, 5);
          if (!groupedIncBySlot[incKey]) {
            groupedIncBySlot[incKey] = {
              id: 'SHT-INC-' + iCabang.replace(/[^a-zA-Z0-9]/g, '') + '-' + iIncDate + '-' + (startRInc + ri),
              recordType: 'BARANG_DATANG',
              senderRole: iRole,
              label: '🚚 Barang Datang (' + iIncDate + ')',
              cabang: iCabang,
              tanggal: iDate,
              incomingDate: iIncDate,
              waktu: iTime,
              shift: iShift,
              nama: iNama,
              petugasBantu: iBantu,
              incomingItemsDetail: [],
              summary: iPosSum || '',
              catatan: iNotes
            };
          }
          if (iItemName && iItemName !== '-') {
            groupedIncBySlot[incKey].incomingItemsDetail.push({
              code: iCode,
              name: iItemName,
              category: iCat,
              unit: iUnit,
              stockBefore: iBefore,
              addedQty: iAdded,
              stockAfter: iAfter,
              hasAddition: iAdded > 0,
              detail: '+' + iAdded + ' ' + iUnit + ' (' + iBefore + ' ➔ ' + iAfter + ')'
            });
          }
        }
        for (var gKey in groupedIncBySlot) {
          if (Object.prototype.hasOwnProperty.call(groupedIncBySlot, gKey)) {
            var grp = groupedIncBySlot[gKey];
            if (!grp.summary && grp.incomingItemsDetail.length > 0) {
              grp.summary = grp.incomingItemsDetail.map(function(d) {
                return '[' + d.code + '] ' + d.name + ': ' + d.detail;
              }).join(' | ');
            }
            importedFromSheets.push(grp);
          }
        }
      }
    }

    // Tandai seluruh slot key yang benar-benar ada di Spreadsheet
    for (var sIdx = 0; sIdx < importedFromSheets.length; sIdx++) {
      var sk = getGsRevisionSlotKey(importedFromSheets[sIdx]);
      if (sk) validSheetSlotKeysMap[sk] = true;
    }

    var openedBranchNames = Object.keys(openedBranchesMap);
    var legacySeedIds = {
      'OP-101': 1, 'OP-102': 1, 'OP-103': 1, 'OP-104': 1, 'OP-105': 1,
      'OP-106': 1, 'OP-107': 1, 'OP-108': 1, 'OP-109': 1,
      'OP-201': 1, 'OP-202': 1, 'OP-203': 1, 'OP-204': 1, 'OP-205': 1, 'OP-206': 1
    };

    // HAPUS OTOMATIS RIWAYAT YANG TIDAK ADA DI SPREADSHEET:
    // Jika Spreadsheet cabang berhasil dibuka, semua riwayat pada cabang tersebut yang TIDAK ADA di Spreadsheet
    // (serta seluruh data dummy/seed OP-101 s/d OP-206) langsung dihapus otomatis dari opLogsSummary!
    var nowMs = nowServer.getTime();
    var filteredExistingSummary = cfg.opLogsSummary.filter(function(itm) {
      if (!itm) return false;
      var idStr = String(itm.id || '').trim();
      if (legacySeedIds[idStr]) return false;
      if (String(itm.catatan || '').indexOf('Tes Koneksi Aplikasi Oh Snap') !== -1) return false;
      if (String(itm.nama || '').indexOf('Inisialisasi Spreadsheet Cabang') !== -1) return false;
      var cbLower = String(itm.cabang || 'Cilacap').trim().toLowerCase();
      if (openedBranchesMap[cbLower]) {
        var slKey = getGsRevisionSlotKey(itm);
        var isRecentlySubmitted = (nowMs - Number(itm.localSubmittedAt || 0)) < 90000;
        if (!validSheetSlotKeysMap[slKey] && !isRecentlySubmitted) {
          return false; // Otomatis hapus karena tidak ada di Spreadsheet!
        }
      }
      return true;
    });

    if (filteredExistingSummary.length !== cfg.opLogsSummary.length) {
      cfg.opLogsSummary = filteredExistingSummary;
      changed = true;
    }

    if (openedBranchNames.length > 0 || importedFromSheets.length > 0) {
      var latestBySlot = {};
      var combined = cfg.opLogsSummary.slice().reverse().concat(importedFromSheets);
      for (var cIdx = 0; cIdx < combined.length; cIdx++) {
        var itm = combined[cIdx];
        if (!itm) continue;
        var slKey = getGsRevisionSlotKey(itm);
        if (!slKey) continue;
        var prevItm = latestBySlot[slKey];
        if (prevItm) {
          if (String(prevItm.fotoBukti || '').indexOf('data:image/svg+xml') === 0) prevItm.fotoBukti = '';
          if (!itm.fotoSerahTerima && prevItm.fotoSerahTerima) itm.fotoSerahTerima = prevItm.fotoSerahTerima;
          if (!itm.fotoSerahDriveUrl && prevItm.fotoSerahDriveUrl) itm.fotoSerahDriveUrl = prevItm.fotoSerahDriveUrl;
          if (!itm.fotoStruk && prevItm.fotoStruk) itm.fotoStruk = prevItm.fotoStruk;
          if (!itm.fotoStrukDriveUrl && prevItm.fotoStrukDriveUrl) itm.fotoStrukDriveUrl = prevItm.fotoStrukDriveUrl;
          if (!itm.fotoBukti && prevItm.fotoBukti) itm.fotoBukti = prevItm.fotoBukti;
          if (!itm.fotoDriveUrl && prevItm.fotoDriveUrl) itm.fotoDriveUrl = prevItm.fotoDriveUrl;
          if (!itm.folderDriveUrl && prevItm.folderDriveUrl) itm.folderDriveUrl = prevItm.folderDriveUrl;
          if (prevItm.id && String(itm.id || '').indexOf('SHT-') === 0 && String(prevItm.id || '').indexOf('SHT-') !== 0) {
            itm.id = prevItm.id;
          }
        }
        latestBySlot[slKey] = itm;
      }
      var dedupedList = [];
      for (var kSlot in latestBySlot) {
        if (Object.prototype.hasOwnProperty.call(latestBySlot, kSlot)) {
          dedupedList.push(latestBySlot[kSlot]);
        }
      }
      dedupedList.sort(function(a, b) {
        var dtA = (a.tanggal || '') + ' ' + (a.waktu || '');
        var dtB = (b.tanggal || '') + ' ' + (b.waktu || '');
        return dtB.localeCompare(dtA);
      });
      cfg.opLogsSummary = dedupedList.slice(0, 120);
      cfg.spreadsheetAuthoritativeSync = true;
      cfg.syncedBranchesFromSheets = openedBranchNames;
      changed = true;
    }

    if (changed) {
      saveCloudConfigToChunks(JSON.stringify(cfg), true);
    }
  } catch (errSync) {}
  return cfg;
}

function trashDriveFilesFromUrlText(urlText) {
  var trashedCount = 0;
  if (!urlText) return 0;
  var str = String(urlText);
  var regexFileD = /\/file\/d\/([a-zA-Z0-9_-]{15,})/g;
  var match;
  var seenIds = {};
  while ((match = regexFileD.exec(str)) !== null) {
    var fId = match[1];
    if (fId && !seenIds[fId]) {
      seenIds[fId] = true;
      if (secTrashFileIfInsideRoot_(fId)) trashedCount++;
    }
  }
  var regexParamId = /[?&]id=([a-zA-Z0-9_-]{15,})/g;
  while ((match = regexParamId.exec(str)) !== null) {
    var fId2 = match[1];
    if (fId2 && !seenIds[fId2]) {
      seenIds[fId2] = true;
      if (secTrashFileIfInsideRoot_(fId2)) trashedCount++;
    }
  }
  trashedCount += secSbRemoveFromText_(str);   // foto di Supabase Storage
  return trashedCount;
}

function trashMatchingPhotoFilesInBranchDriveFolders(itemMeta) {
  var trashed = 0;
  if (!itemMeta) return 0;
  var cabang = String(itemMeta.cabang || 'Cilacap').trim();
  var tanggal = String(itemMeta.tanggal || itemMeta.cutoffDate || itemMeta.incomingDate || '').trim();
  var nama = String(itemMeta.nama || '').trim();
  var recType = String(itemMeta.recordType || '').trim();
  if (!tanggal) return 0;

  var targetFolderKeys = [];
  if (recType === 'DAILY_REPORT') {
    if (itemMeta.photoField === 'fotoSerahTerima') {
      targetFolderKeys = ['SERAH_TERIMA'];
    } else if (itemMeta.photoField === 'fotoStruk') {
      targetFolderKeys = ['STRUK_BELANJA'];
    } else {
      targetFolderKeys = ['SERAH_TERIMA', 'STRUK_BELANJA'];
    }
  } else if (recType === 'OPEN_STORE') {
    targetFolderKeys = ['OPEN_STORE'];
  } else if (recType === 'CLOSE_STORE') {
    targetFolderKeys = ['CLOSE_STORE'];
  } else if (recType === 'ABSEN_MUKA') {
    targetFolderKeys = ['ABSENSI'];
  } else {
    targetFolderKeys = ['ABSENSI', 'OPEN_STORE', 'CLOSE_STORE', 'SERAH_TERIMA', 'STRUK_BELANJA'];
  }

  for (var k = 0; k < targetFolderKeys.length; k++) {
    try {
      var branchFolder = getFolderFotoByKategoriLaporan(targetFolderKeys[k], cabang);
      if (!branchFolder) continue;
      var filesIter = branchFolder.getFiles();
      while (filesIter.hasNext()) {
        var f = filesIter.next();
        var fName = String(f.getName() || '');
        var hasDateAndBranch = fName.indexOf(tanggal) !== -1 && fName.toLowerCase().indexOf(cabang.toLowerCase()) !== -1;
        var hasNama = !nama || fName.toLowerCase().indexOf(nama.toLowerCase()) !== -1 || fName.indexOf('OPEN_') === 0 || fName.indexOf('CLOSE_') === 0;
        if (hasDateAndBranch && hasNama) {
          try {
            f.setTrashed(true);
            trashed++;
          } catch (errF) {}
        }
      }
    } catch (errKat) {}
  }
  return trashed;
}

function deleteSingleRecordFromBranchSpreadsheetAndDrive(itemMeta) {
  if (!itemMeta || typeof itemMeta !== 'object') return { deletedRows: 0, trashedFiles: 0 };
  var cabang = String(itemMeta.cabang || 'Cilacap').trim();
  var targetDate = normalizeGsDateCell(null, itemMeta.tanggal || itemMeta.cutoffDate || itemMeta.incomingDate || '');
  var targetCutoff = normalizeGsDateCell(null, itemMeta.cutoffDate || itemMeta.tanggal || '');
  var targetIncoming = normalizeGsDateCell(null, itemMeta.incomingDate || itemMeta.tanggal || '');
  var targetTimePrefix = normalizeGsTimePrefix(null, itemMeta.waktu || '');
  var targetNama = String(itemMeta.nama || '').trim().toLowerCase();
  var recType = String(itemMeta.recordType || '').trim();
  var subType = String(itemMeta.subType || '').trim();
  var onlyPhoto = Boolean(itemMeta.onlyDeletePhoto);

  var deletedRowsCount = 0;
  var trashedFilesCount = 0;

  // 1. Hapus file foto yang cocok di Google Drive Subfolder Cabang
  trashedFilesCount += trashMatchingPhotoFilesInBranchDriveFolders(itemMeta);

  // 2. Cari dan hapus baris (atau kosongkan link foto) di Google Spreadsheet Cabang
  var ss = null;
  try {
    ss = getOrCreateBranchSpreadsheet(cabang, itemMeta.branchSpreadsheetId || '');
  } catch (eSs) {
    ss = null;
  }
  if (!ss) return { deletedRows: deletedRowsCount, trashedFiles: trashedFilesCount };

  var sheetsToScan = [];
  if (recType === 'DAILY_REPORT') {
    sheetsToScan = ['Laporan_Harian', 'Rekap_Pengeluaran'];
  } else if (recType === 'STOCK_OPNAME') {
    sheetsToScan = ['Stock_Opname'];
  } else if (recType === 'BARANG_DATANG') {
    sheetsToScan = ['Barang_Datang'];
  } else if (recType === 'OPEN_STORE') {
    sheetsToScan = ['open_Store', 'Absen_Masuk'];
  } else if (recType === 'CLOSE_STORE') {
    sheetsToScan = ['Close_Store', 'Absen_Keluar'];
  } else if (recType === 'ABSEN_MUKA') {
    sheetsToScan = (subType === 'MUKA_PULANG' || subType === 'CLOSE_MUKA')
      ? ['Absen_Keluar', 'Absen_Masuk']
      : ['Absen_Masuk', 'Absen_Keluar'];
  } else {
    sheetsToScan = TEMPLATE_8_SHEET_NAMES.slice();
  }

  for (var sIdx = 0; sIdx < sheetsToScan.length; sIdx++) {
    var shName = sheetsToScan[sIdx];
    var sh = ss.getSheetByName(shName);
    if (!sh) continue;
    var lastRow = sh.getLastRow();
    if (lastRow <= 1) continue;

    var range = sh.getDataRange();
    var rawValues = range.getValues();
    var dispValues = range.getDisplayValues();

    // Iterasi dari baris paling bawah ke atas (baris 2) agar penghapusan baris tidak menggeser indeks di atasnya
    for (var r = lastRow - 1; r >= 1; r--) {
      var rawRow = rawValues[r];
      var dispRow = dispValues[r];
      var rowJoined = dispRow.join(' | ');

      var rowDate1 = '';
      var rowDate2 = '';
      var rowTimePref = '';
      var rowNama = '';
      var rowCabang = '';

      if (shName === 'Stock_Opname' || shName === 'Barang_Datang') {
        // Kolom: [0]Timestamp, [1]Cabang, [2]Peran, [3]Tanggal Input, [4]Tanggal Cutoff/Datang, [5]Jam Input, [6]Shift, [7]Nama Petugas
        rowCabang = String(dispRow[1] || '').trim().toLowerCase();
        rowDate1 = normalizeGsDateCell(rawRow[3], dispRow[3]);
        rowDate2 = normalizeGsDateCell(rawRow[4], dispRow[4]);
        rowTimePref = normalizeGsTimePrefix(rawRow[5], dispRow[5]);
        rowNama = String(dispRow[7] || '').trim().toLowerCase();
      } else if (shName === 'open_Store' || shName === 'Close_Store') {
        // Kolom: [0]Timestamp, [1]Tanggal, [2]Jam, [3]Cabang, [4]Shift, [5]Jadwal, [6]Nama Karyawan
        rowDate1 = normalizeGsDateCell(rawRow[1], dispRow[1]);
        rowDate2 = rowDate1;
        rowTimePref = normalizeGsTimePrefix(rawRow[2], dispRow[2]);
        rowCabang = String(dispRow[3] || '').trim().toLowerCase();
        rowNama = String(dispRow[6] || '').trim().toLowerCase();
      } else if (shName === 'Laporan_Harian' || shName === 'Rekap_Pengeluaran') {
        // Kolom: [0]Timestamp, [1]Tanggal, [2]Jam Input, [3]Cabang, [4]Shift, [5]Nama Kasir
        rowDate1 = normalizeGsDateCell(rawRow[1], dispRow[1]);
        rowDate2 = rowDate1;
        rowTimePref = normalizeGsTimePrefix(rawRow[2], dispRow[2]);
        rowCabang = String(dispRow[3] || '').trim().toLowerCase();
        rowNama = String(dispRow[5] || '').trim().toLowerCase();
      } else {
        // Absen_Masuk & Absen_Keluar: [0]Timestamp, [1]Tanggal, [2]Jam Absen, [3]Cabang, [4]Nama Karyawan
        rowDate1 = normalizeGsDateCell(rawRow[1], dispRow[1]);
        rowDate2 = rowDate1;
        rowTimePref = normalizeGsTimePrefix(rawRow[2], dispRow[2]);
        rowCabang = String(dispRow[3] || '').trim().toLowerCase();
        rowNama = String(dispRow[4] || '').trim().toLowerCase();
      }

      var dateMatched = !targetDate ||
                        rowDate1 === targetDate || rowDate2 === targetDate ||
                        (targetCutoff && (rowDate1 === targetCutoff || rowDate2 === targetCutoff)) ||
                        (targetIncoming && (rowDate1 === targetIncoming || rowDate2 === targetIncoming));
      var cabangMatched = !cabang || !rowCabang || rowCabang === cabang.toLowerCase();
      var namaMatched = !targetNama || !rowNama || rowNama === targetNama;
      var timeMatched = !targetTimePrefix || !rowTimePref || rowTimePref === targetTimePrefix;

      if (dateMatched && cabangMatched && namaMatched && timeMatched) {
        // Hapus juga file foto di Google Drive berdasarkan link yang tertulis di baris Spreadsheet ini
        trashedFilesCount += trashDriveFilesFromUrlText(rowJoined);

        if (onlyPhoto) {
          // Jika hanya menghapus foto, kosongkan sel link foto di baris Spreadsheet
          if (shName === 'Laporan_Harian') {
            if (!itemMeta.photoField || itemMeta.photoField === 'fotoSerahTerima') sh.getRange(r + 1, 13).setValue('- (Foto Dihapus)');
            if (!itemMeta.photoField || itemMeta.photoField === 'fotoStruk') sh.getRange(r + 1, 15).setValue('- (Foto Dihapus)');
          } else if (shName === 'Rekap_Pengeluaran') {
            sh.getRange(r + 1, 10).setValue('- (Foto Dihapus)');
          } else if (shName === 'open_Store') {
            sh.getRange(r + 1, 10).setValue('- (Foto Dihapus)');
          } else if (shName === 'Close_Store' || shName === 'Absen_Masuk' || shName === 'Absen_Keluar') {
            sh.getRange(r + 1, 11).setValue('- (Foto Dihapus)');
          }
        } else {
          sh.deleteRow(r + 1);
          deletedRowsCount++;
        }
      }
    }
  }

  return { deletedRows: deletedRowsCount, trashedFiles: trashedFilesCount };
}

function handleAdminDeleteRecordsFromWeb(payloadObj) {
  var lock = LockService.getScriptLock();
  try { lock.waitLock(15000); } catch (e) {}
  try {
    var items = (payloadObj && Array.isArray(payloadObj.deletedItems)) ? payloadObj.deletedItems : [];
    var delIds = (payloadObj && Array.isArray(payloadObj.deletedOpLogIds)) ? payloadObj.deletedOpLogIds : [];
    var totalDeletedRows = 0;
    var totalTrashedFiles = 0;

    for (var i = 0; i < items.length; i++) {
      var res = deleteSingleRecordFromBranchSpreadsheetAndDrive(items[i]);
      totalDeletedRows += (res.deletedRows || 0);
      totalTrashedFiles += (res.trashedFiles || 0);
      if (items[i] && items[i].id && !items[i].onlyDeletePhoto) {
        var sId = String(items[i].id).trim();
        if (sId && delIds.indexOf(sId) === -1) delIds.push(sId);
      }
    }

    // Update Cloud Config agar ID yang dihapus tidak pernah muncul lagi di device mana pun
    if (delIds.length > 0) {
      var existingCfg = loadCloudConfigFromChunks(false) || {};
      var unionDel = Array.isArray(existingCfg.deletedOpLogIds) ? existingCfg.deletedOpLogIds.slice() : [];
      for (var d = 0; d < delIds.length; d++) {
        var idStr = String(delIds[d] || '').trim();
        if (idStr && unionDel.indexOf(idStr) === -1) unionDel.push(idStr);
      }
      existingCfg.deletedOpLogIds = unionDel.slice(-300);
      if (Array.isArray(existingCfg.opLogsSummary)) {
        existingCfg.opLogsSummary = existingCfg.opLogsSummary.filter(function(x) {
          return x && existingCfg.deletedOpLogIds.indexOf(String(x.id)) === -1;
        });
      }
      existingCfg.updatedAt = new Date().getTime();
      saveCloudConfigToChunks(JSON.stringify(existingCfg), false);
    }

    return JSON.stringify({
      status: 'success',
      action: 'delete_records',
      deletedSpreadsheetRows: totalDeletedRows,
      trashedDrivePhotos: totalTrashedFiles
    });
  } catch (err) {
    return secErrorJson_(err);
  } finally {
    try { lock.releaseLock(); } catch (eLock) {}
  }
}

function handleAdminConfigSync(payloadObj) {
  var lock = LockService.getScriptLock();
  try { lock.waitLock(15000); } catch (e) {}
  try {
    var incomingCfg = (payloadObj && payloadObj.cloudConfig) ? payloadObj.cloudConfig : payloadObj;
    if (!incomingCfg || typeof incomingCfg !== 'object') {
      incomingCfg = {};
    }
    var existingCfg = loadCloudConfigFromChunks(false) || {};
    delete incomingCfg.adminPin;
    delete existingCfg.adminPin;
    if (incomingCfg.employees !== undefined) {
      incomingCfg.employees = secMergeEmployees_(existingCfg.employees, incomingCfg.employees);
    }
    var mergedCfg = {};
    var k;
    for (k in existingCfg) { mergedCfg[k] = existingCfg[k]; }
    for (k in incomingCfg) {
      if (incomingCfg[k] !== undefined) {
        mergedCfg[k] = incomingCfg[k];
      }
    }
    // Jika Admin menekan Undo Hapus (overrideDeletedIds = true), gunakan daftar deletedOpLogIds terbaru dari Admin
    var unionDelIds = [];
    var existingDel = (incomingCfg.overrideDeletedIds) ? [] : (Array.isArray(existingCfg.deletedOpLogIds) ? existingCfg.deletedOpLogIds : []);
    var incomingDel = Array.isArray(incomingCfg.deletedOpLogIds) ? incomingCfg.deletedOpLogIds : [];
    for (var d1 = 0; d1 < existingDel.length; d1++) {
      var id1 = String(existingDel[d1] || '').trim();
      if (id1 && unionDelIds.indexOf(id1) === -1) unionDelIds.push(id1);
    }
    for (var d2 = 0; d2 < incomingDel.length; d2++) {
      var id2 = String(incomingDel[d2] || '').trim();
      if (id2 && unionDelIds.indexOf(id2) === -1) unionDelIds.push(id2);
    }
    if (unionDelIds.length > 300) {
      unionDelIds = unionDelIds.slice(unionDelIds.length - 300);
    }
    mergedCfg.deletedOpLogIds = unionDelIds;

    // Gabungkan opLogsSummary lintas device dan simpan hanya data terakhir (revisi terbaru) untuk setiap slot (Cabang + Tanggal + Shift + Jenis)
    var combinedLogs = [];
    var seenLogIds = {};
    var seenSlotKeys = {};
    var incLogs = Array.isArray(incomingCfg.opLogsSummary) ? incomingCfg.opLogsSummary : [];
    var extLogs = Array.isArray(existingCfg.opLogsSummary) ? existingCfg.opLogsSummary : [];
    var allSourceLogs = incLogs.concat(extLogs);
    for (var lIdx = 0; lIdx < allSourceLogs.length; lIdx++) {
      var itemLog = allSourceLogs[lIdx];
      if (!itemLog || !itemLog.id) continue;
      var sLogId = String(itemLog.id).trim();
      if (!sLogId || unionDelIds.indexOf(sLogId) !== -1 || seenLogIds[sLogId]) continue;
      var slotK = getGsRevisionSlotKey(itemLog);
      if (slotK && seenSlotKeys[slotK]) continue;
      seenLogIds[sLogId] = true;
      if (slotK) seenSlotKeys[slotK] = true;
      combinedLogs.push(itemLog);
    }
    mergedCfg.opLogsSummary = combinedLogs.slice(0, 120);
    mergedCfg.updatedAt = incomingCfg.updatedAt || new Date().getTime();
    var mergedBranchSs = {};
    if (existingCfg.branchSpreadsheets && typeof existingCfg.branchSpreadsheets === 'object') {
      for (var bk1 in existingCfg.branchSpreadsheets) {
        if (existingCfg.branchSpreadsheets[bk1] && existingCfg.branchSpreadsheets[bk1].spreadsheetId) {
          mergedBranchSs[bk1] = existingCfg.branchSpreadsheets[bk1];
        }
      }
    }
    if (incomingCfg.branchSpreadsheets && typeof incomingCfg.branchSpreadsheets === 'object') {
      for (var bk2 in incomingCfg.branchSpreadsheets) {
        if (incomingCfg.branchSpreadsheets[bk2] && incomingCfg.branchSpreadsheets[bk2].spreadsheetId) {
          mergedBranchSs[bk2] = incomingCfg.branchSpreadsheets[bk2];
        }
      }
    }
    mergedCfg.branchSpreadsheets = mergedBranchSs;

    var createBranchName = String((payloadObj && payloadObj.createBranchName) || '').trim();
    var ensureAll = Boolean(payloadObj && payloadObj.ensureAllBranchSpreadsheets);
    var createdSsId = '';
    var createdSsUrl = '';

    var activeBranches = Array.isArray(mergedCfg.branches) && mergedCfg.branches.length > 0
      ? mergedCfg.branches.slice()
      : DAFTAR_5_CABANG_UTAMA.slice();

    if (createBranchName && activeBranches.indexOf(createBranchName) === -1) {
      activeBranches.push(createBranchName);
      mergedCfg.branches = activeBranches;
    }

    var props = PropertiesService.getScriptProperties();

    // 1. Jika ada cabang baru yang ditambahkan dari Web Admin -> langsung buatkan Spreadsheet 8 Sheet & Folder Foto di Drive!
    if (createBranchName) {
      var customIdNew = (mergedCfg.branchSpreadsheets[createBranchName] && mergedCfg.branchSpreadsheets[createBranchName].spreadsheetId) || '';
      var ssCreated = getOrCreateBranchSpreadsheet(createBranchName, customIdNew);
      ensureBranchPhotoFoldersForSingleBranch(createBranchName);
      if (ssCreated) {
        createdSsId = ssCreated.getId();
        createdSsUrl = ssCreated.getUrl();
        mergedCfg.branchSpreadsheets[createBranchName] = {
          spreadsheetId: createdSsId,
          spreadsheetUrl: createdSsUrl,
          updatedAt: new Date().toISOString()
        };
      }
    }

    // 2. Pastikan seluruh cabang di daftar cabang memiliki link Spreadsheet (otomatis buat jika belum ada atau jika diminta)
    for (var i = 0; i < activeBranches.length; i++) {
      var bName = String(activeBranches[i] || '').trim();
      if (!bName) continue;
      var propKey = getBranchPropKey(bName);
      var existingEntry = mergedCfg.branchSpreadsheets[bName] || {};
      var knownId = extractSpreadsheetIdFromInput(existingEntry.spreadsheetId || existingEntry.spreadsheetUrl || '') || props.getProperty(propKey) || '';

      if (ensureAll || !knownId) {
        var ssB = getOrCreateBranchSpreadsheet(bName, knownId);
        if (ensureAll) {
          ensureBranchPhotoFoldersForSingleBranch(bName);
        }
        if (ssB) {
          knownId = ssB.getId();
          mergedCfg.branchSpreadsheets[bName] = {
            spreadsheetId: knownId,
            spreadsheetUrl: ssB.getUrl(),
            updatedAt: existingEntry.updatedAt || new Date().toISOString()
          };
        }
      } else if (knownId) {
        props.setProperty(propKey, knownId);
        mergedCfg.branchSpreadsheets[bName] = {
          spreadsheetId: knownId,
          spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/' + knownId + '/edit',
          updatedAt: existingEntry.updatedAt || new Date().toISOString()
        };
      }
    }

    // Jika sinkronisasi Admin menyertakan item laporan/foto yang baru dihapus, hapus juga di Spreadsheet & Google Drive!
    var pendingDeletedItems = (payloadObj && Array.isArray(payloadObj.deletedItems))
      ? payloadObj.deletedItems
      : (Array.isArray(incomingCfg.recentDeletedItems) ? incomingCfg.recentDeletedItems : []);
    if (pendingDeletedItems.length > 0) {
      for (var delIdx = 0; delIdx < pendingDeletedItems.length; delIdx++) {
        try {
          deleteSingleRecordFromBranchSpreadsheetAndDrive(pendingDeletedItems[delIdx]);
        } catch (delSheetErr) {}
      }
    }

    if (ensureAll) {
      try { mergedCfg = syncOpLogsTimeFromBranchSpreadsheets(mergedCfg) || mergedCfg; } catch (eSyncAll) {}
    }
    saveCloudConfigToChunks(JSON.stringify(mergedCfg), Boolean(createBranchName || ensureAll));

    return JSON.stringify({
      status: 'success',
      synced: true,
      version: 'v4_cloud_sync',
      createdBranch: createBranchName,
      createdSpreadsheetId: createdSsId,
      createdSpreadsheetUrl: createdSsUrl,
      branchSpreadsheets: mergedCfg.branchSpreadsheets,
      cloudConfig: secScopeConfig_(mergedCfg, { r: 'ADMIN', b: '', n: 'Admin' })
    });
  } catch (err) {
    return secErrorJson_(err);
  } finally {
    try { lock.releaseLock(); } catch (eLock) {}
  }
}

// Alias pembersihan duplikat & setup 5 cabang (fungsi utama sudah berada di urutan #1 paling atas file ini)
function bersihkanSpreadsheetDuplikatDrive() {
  setup5SpreadsheetCabangOtomatis();
}

function tesTulisKeSpreadsheet() {
  setup5SpreadsheetCabangOtomatis();
}

// Ambil file foto asli dari Google Drive (berdasarkan fileId, link Spreadsheet, atau nama file di Folder Cabang)
// dan kembalikan sebagai data:image/jpeg;base64,... agar tampil 100% sesuai foto laporan yang dikirim!
function handleGetPhotoFromDrive(params, session) {
  try {
    params = params || {};
    if (!session) secFail_('AUTH_REQUIRED', 'Login diperlukan.');
    var reqCabang = String(params.cabang || 'Cilacap').trim();
    if (secAllowedBranches_().indexOf(reqCabang) === -1) secFail_('BAD_REQUEST', 'Cabang tidak dikenali.');
    if (session.r !== 'ADMIN' && session.b !== reqCabang) secFail_('FORBIDDEN', 'Akses ditolak untuk cabang ini.');
    var fileId = extractGsDriveFileId(params.fileId || params.fileUrl || '');
    var cabang = String(params.cabang || 'Cilacap').trim();
    var tanggal = normalizeGsDateCell(null, params.tanggal || '');
    var nama = String(params.nama || '').trim();
    var recType = String(params.recordType || 'ABSEN_MUKA').trim().toUpperCase();
    var subType = String(params.subType || '').trim().toUpperCase();
    var photoField = String(params.photoField || '').trim();

    // 1. Jika belum ada fileId, cari dulu di baris Google Spreadsheet Cabang yang sesuai
    if (!fileId && cabang) {
      try {
        var ss = getOrCreateBranchSpreadsheet(cabang, '', false);
        if (ss) {
          var targetShName = 'Absen_Masuk';
          var linkColIdx = 10;
          var folderColIdx = 11;
          var namaColIdx = 4;
          if (recType === 'DAILY_REPORT') {
            targetShName = 'Laporan_Harian';
            linkColIdx = (photoField === 'fotoStruk') ? 14 : 12;
            folderColIdx = (photoField === 'fotoStruk') ? 15 : 13;
            namaColIdx = 5;
          } else if (recType === 'OPEN_STORE') {
            targetShName = 'open_Store';
            linkColIdx = 9;
            folderColIdx = 10;
            namaColIdx = 6;
          } else if (recType === 'CLOSE_STORE') {
            targetShName = 'Close_Store';
            linkColIdx = 10;
            folderColIdx = 11;
            namaColIdx = 6;
          } else if (subType === 'MUKA_PULANG' || subType === 'CLOSE_MUKA') {
            targetShName = 'Absen_Keluar';
            linkColIdx = 10;
            folderColIdx = 11;
            namaColIdx = 4;
          }
          var sh = ss.getSheetByName(targetShName);
          if (sh && sh.getLastRow() >= 2) {
            var lastR = sh.getLastRow();
            var startR = Math.max(2, lastR - 50);
            var numR = lastR - startR + 1;
            var rawRows = sh.getRange(startR, 1, numR, Math.max(16, sh.getLastColumn())).getValues();
            var dispRows = sh.getRange(startR, 1, numR, Math.max(16, sh.getLastColumn())).getDisplayValues();
            for (var r = numR - 1; r >= 0; r--) {
              var rDate = normalizeGsDateCell(rawRows[r][1], dispRows[r][1]);
              var rNama = String(dispRows[r][namaColIdx] || '').trim().toLowerCase();
              if ((!tanggal || rDate === tanggal) && (!nama || rNama === nama.toLowerCase())) {
                var cellLink = String(dispRows[r][linkColIdx] || '').trim();
                var foundId = extractGsDriveFileId(cellLink);
                if (foundId) {
                  fileId = foundId;
                  break;
                }
              }
            }
          }
        }
      } catch (eSheetLookup) {}
    }

    // 2. Jika masih belum ada fileId, cari langsung file fotonya di dalam Folder Foto Cabang di Google Drive
    var targetFile = null;
    if (fileId) {
      try {
        targetFile = DriveApp.getFileById(fileId);
        if (targetFile && targetFile.isTrashed()) targetFile = null;
        if (targetFile && !secFileInsideRoot_(targetFile, session.r === 'ADMIN' ? '' : 'Cabang_' + reqCabang)) targetFile = null;
      } catch (eById) {
        targetFile = null;
      }
    }

    if (!targetFile && cabang) {
      try {
        var katKey = 'ABSENSI';
        if (recType === 'DAILY_REPORT') {
          katKey = (photoField === 'fotoStruk') ? 'STRUK_BELANJA' : 'SERAH_TERIMA';
        } else if (recType === 'OPEN_STORE') {
          katKey = 'OPEN_STORE';
        } else if (recType === 'CLOSE_STORE') {
          katKey = 'CLOSE_STORE';
        }
        var branchPhotoFolder = getFolderFotoByKategoriLaporan(katKey, cabang);
        if (branchPhotoFolder) {
          var fIter = branchPhotoFolder.getFiles();
          var bestMatch = null;
          var bestTime = 0;
          var wantPulang = (subType === 'MUKA_PULANG' || subType === 'CLOSE_MUKA');
          while (fIter.hasNext()) {
            var cand = fIter.next();
            if (!cand || cand.isTrashed()) continue;
            var cName = String(cand.getName() || '');
            var cLow = cName.toLowerCase();
            if (tanggal && cName.indexOf(tanggal) === -1) continue;
            if (nama && cLow.indexOf(nama.toLowerCase()) === -1) continue;
            if (recType === 'ABSEN_MUKA') {
              if (wantPulang && cLow.indexOf('pulang') === -1 && cLow.indexOf('keluar') === -1) continue;
              if (!wantPulang && cLow.indexOf('pulang') !== -1) continue;
            }
            var cTime = cand.getDateCreated() ? cand.getDateCreated().getTime() : 0;
            if (!bestMatch || cTime >= bestTime) {
              bestMatch = cand;
              bestTime = cTime;
            }
          }
          if (bestMatch) {
            targetFile = bestMatch;
            fileId = bestMatch.getId();
          }
        }
      } catch (eFolderSearch) {}
    }

    if (!targetFile) {
      return JSON.stringify({ status: 'not_found', message: 'File foto tidak ditemukan di Drive' });
    }

    try {
      if (SEC_ALLOW_PUBLIC_DRIVE_LINKS) { targetFile.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); }
    } catch (eShPhoto) {}

    var blob = targetFile.getBlob();
    var cType = blob.getContentType() || 'image/jpeg';
    var b64Data = 'data:' + cType + ';base64,' + Utilities.base64Encode(blob.getBytes());
    var finalId = targetFile.getId();
    return JSON.stringify({
      status: 'success',
      fileId: finalId,
      fileUrl: targetFile.getUrl(),
      thumbUrl: 'https://drive.google.com/thumbnail?id=' + finalId + '&sz=w800',
      base64: b64Data
    });
  } catch (err) {
    return secErrorJson_(err);
  }
}

function doGet(e) {
  // GET tidak lagi melayani data apa pun. Semua aksi memakai POST + token sesi.
  return ContentService.createTextOutput(JSON.stringify({
    status: 'ok',
    service: 'Oh Snap Photobox API',
    version: 'v5_secure'
  })).setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  var out = function(text) {
    return ContentService.createTextOutput(text).setMimeType(ContentService.MimeType.JSON);
  };
  var parseJsonOrEmpty = function(text) {
    if (!text) return {};
    try { return JSON.parse(text); } catch (eJ) { return {}; }
  };
  try {
    var params = secParseRequest_(e);
    var action = String(params.action || '').trim();
    var token = params.token || '';

    if (action === 'login') {
      return out(JSON.stringify(handleLogin_(params)));
    }

    if (action === 'get_config') {
      // Tanpa token: hanya konfigurasi publik minimal (daftar cabang & jadwal).
      var sessCfg = secVerifyToken_(token);
      var cfgFull = sessCfg
        ? syncOpLogsTimeFromBranchSpreadsheets(loadCloudConfigFromChunks(false))
        : loadCloudConfigFromChunks(true);
      return out(JSON.stringify({
        status: 'success',
        version: 'v5_secure',
        authenticated: !!sessCfg,
        cloudConfig: secScopeConfig_(cfgFull, sessCfg)
      }));
    }

    if (action === 'get_photo') {
      var sPhoto = secRequire_(token, ['ADMIN', 'EMPLOYEE']);
      return out(handleGetPhotoFromDrive(params, sPhoto));
    }

    if (action === 'get_sheet_rows') {
      var sRows = secRequire_(token, ['ADMIN', 'EMPLOYEE']);
      return out(JSON.stringify(handleGetSheetRows_(params, sRows)));
    }

    if (action === 'photo_upload_urls') {
      var sUp = secRequire_(token, ['ADMIN', 'EMPLOYEE']);
      return out(JSON.stringify(handlePhotoUploadUrls_(params, sUp)));
    }

    if (action === 'photo_view_url') {
      var sVw = secRequire_(token, ['ADMIN', 'EMPLOYEE']);
      return out(JSON.stringify(handlePhotoViewUrl_(params, sVw)));
    }

    if (action === 'delete_records') {
      secRequire_(token, ['ADMIN']);
      return out(handleAdminDeleteRecordsFromWeb(parseJsonOrEmpty(params.payload)));
    }

    if (action === 'save_config' || action === 'create_branch') {
      secRequire_(token, ['ADMIN']);
      var parsedPayload = {};
      if (params.cloud_config) {
        var cfgObj = parseJsonOrEmpty(params.cloud_config);
        parsedPayload = { cloudConfig: cfgObj };
      } else if (params.payload) {
        parsedPayload = parseJsonOrEmpty(params.payload);
      }
      if (params.branch && !parsedPayload.createBranchName) {
        parsedPayload.createBranchName = String(params.branch).trim();
      }
      return out(handleAdminConfigSync(parsedPayload));
    }

    if (action === 'change_admin_password') {
      var sAdm = secRequire_(token, ['ADMIN']);
      return out(JSON.stringify(handleChangeAdminPassword_(params, sAdm)));
    }

    if (action === 'submit_report' || (!action && params.payload)) {
      var sRep = secRequire_(token, ['ADMIN', 'EMPLOYEE']);
      return out(simpanDariWebAppInternal_(String(params.payload || ''), sRep));
    }

    secFail_('BAD_REQUEST', 'Aksi tidak dikenali.');
  } catch (err) {
    return out(secErrorJson_(err));
  }
}

// Jalur google.script.run (jika halaman dihosting di HtmlService): wajib menyertakan authToken di JSON.
function simpanDariWebApp(jsonString) {
  try {
    var d0 = JSON.parse(jsonString);
    var s0 = secRequire_(d0 && d0.authToken, ['ADMIN', 'EMPLOYEE']);
    return simpanDariWebAppInternal_(jsonString, s0);
  } catch (err0) {
    return secErrorJson_(err0);
  }
}

function simpanDariWebAppInternal_(jsonString, session) {
  if (!session) return secErrorJson_({ secCode: 'AUTH_REQUIRED', message: 'Login diperlukan.' });
  var dPre = null;
  try { dPre = JSON.parse(jsonString); } catch (preErr) {}
  if (dPre && (dPre.recordType === 'ADMIN_DELETE_RECORDS' || dPre.action === 'delete_records' ||
      dPre.recordType === 'ADMIN_SYNC_CONFIG' || dPre.action === 'save_config' || dPre.recordType === 'CREATE_BRANCH_SPREADSHEET')) {
    if (session.r !== 'ADMIN') return secErrorJson_({ secCode: 'FORBIDDEN', message: 'Hanya Admin yang boleh melakukan aksi ini.' });
    if (dPre.recordType === 'ADMIN_DELETE_RECORDS' || dPre.action === 'delete_records') {
      return handleAdminDeleteRecordsFromWeb(dPre);
    }
    return handleAdminConfigSync(dPre);
  }

  var lock = LockService.getScriptLock();
  var dedupCacheKey = '';
  try {
    lock.waitLock(15000);
  } catch (lockErr) {}
  try {
    var d = JSON.parse(jsonString);
    var cabang = String(d.cabang || 'Cilacap').trim();
    if (secAllowedBranches_().indexOf(cabang) === -1) secFail_('BAD_REQUEST', 'Cabang tidak dikenali.');
    if (session.r !== 'ADMIN') {
      if (session.b !== cabang) secFail_('FORBIDDEN', 'Anda tidak boleh mengirim laporan untuk cabang lain.');
      d.nama = session.n;      // kru tidak bisa memalsukan nama
      d.senderRole = 'USER';
    }
    d.cabang = cabang;
    if (secHasInlinePhoto_(d, 0) && !secDrivePhotoFallbackAllowed_()) {
      secFail_('SB_REQUIRED', secSbConfig_()
        ? 'Foto harus diunggah ke Supabase terlebih dahulu. Muat ulang halaman (refresh) lalu kirim ulang laporan.'
        : 'Penyimpanan foto Supabase belum dikonfigurasi di server. Laporan berfoto belum bisa dikirim — hubungi Admin.');
    }
    if (d.latestOpLogSummary && typeof d.latestOpLogSummary === 'object') {
      d.latestOpLogSummary.cabang = cabang;
      if (session.r !== 'ADMIN') d.latestOpLogSummary.nama = d.nama;
    }
    if ((Array.isArray(d.closePhotosList) && d.closePhotosList.length > SEC_MAX_PHOTOS_PER_REPORT) ||
        (Array.isArray(d.openPhotosList) && d.openPhotosList.length > SEC_MAX_PHOTOS_PER_REPORT)) {
      secFail_('BAD_REQUEST', 'Jumlah foto melebihi batas.');
    }
    var syncedDt = resolveSynchronizedWibDateTime(d.tanggal, d.waktu);
    d.tanggal = syncedDt.tanggal;
    d.waktu = syncedDt.waktu;
    d.shift = normalizeGsShiftName(d.shift);
    if (d.recordType === 'DAILY_REPORT') {
      d.cash = parseGsNominalRibuan(d.cash);
      d.qris = parseGsNominalRibuan(d.qris);
      d.totalExpense = parseGsNominalRibuan(d.totalExpense);
      d.totalGross = d.cash + d.qris;
      d.netOmzet = d.totalGross - d.totalExpense;
    }
    if (d.latestOpLogSummary && typeof d.latestOpLogSummary === 'object') {
      d.latestOpLogSummary.tanggal = syncedDt.tanggal;
      d.latestOpLogSummary.waktu = syncedDt.waktu;
      d.latestOpLogSummary.shift = d.shift;
      if (d.recordType === 'DAILY_REPORT') {
        d.latestOpLogSummary.cash = d.cash;
        d.latestOpLogSummary.qris = d.qris;
        d.latestOpLogSummary.totalGross = d.totalGross;
        d.latestOpLogSummary.totalExpense = d.totalExpense;
        d.latestOpLogSummary.netOmzet = d.netOmzet;
      }
    }

    // Jika bukan revisi yang dikonfirmasi, tahan klik 2x tidak sengaja dalam 8 detik;
    // Jika revisi sengaja (isConfirmedRevision = true), Spreadsheet WAJIB terus merecord berapapun revisi!
    if (!d.isConfirmedRevision) {
      var rawDedup = d.dedupKey || [
        d.recordType || '',
        d.subType || '',
        cabang,
        d.tanggal || '',
        d.shift || '',
        d.nama || '',
        d.totalGross !== undefined ? d.totalGross : '',
        d.totalExpense !== undefined ? d.totalExpense : '',
        d.kertasPax !== undefined ? d.kertasPax : '',
        d.positiveSummary || '',
        d.checklistSummary || '',
        d.catatan || ''
      ].join('|');
      // Kunci dibatasi per cabang + pengirim agar kru cabang lain tidak bisa "menahan" laporan orang lain
      var digestBytes = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, cabang + '|' + (session.i || session.r) + '|' + rawDedup, Utilities.Charset.UTF_8);
      var hashHex = digestBytes.map(function(b) {
        var v = (b < 0 ? b + 256 : b).toString(16);
        return v.length === 1 ? '0' + v : v;
      }).join('');
      dedupCacheKey = 'OHSNAP_DEDUP_' + hashHex;
      var cacheKey = dedupCacheKey;
      var cache = CacheService.getScriptCache();
      if (cache && cache.get(cacheKey)) {
        return JSON.stringify({
          status: 'success',
          duplicateIgnored: true,
          message: 'Laporan duplikat (klik 2x) otomatis diabaikan.'
        });
      }
      if (cache) {
        cache.put(cacheKey, '1', 8);
      }
    }
    var customBranchSsId = (session.r === 'ADMIN') ? (d.branchSpreadsheetId || '') : '';

    // Buka / Buat Spreadsheet khusus milik cabang yang bersangkutan (Otomatis 8 Sheet)
    var ss = getOrCreateBranchSpreadsheet(cabang, customBranchSsId);

    // Jika laporan kru menyertakan update stok cabang atau log terbaru, sinkronkan ke Cloud Config
    if (d.updatedBranchStockForCabang || d.latestOpLogSummary) {
      try {
        var currentCfg = loadCloudConfigFromChunks(true);
        if (currentCfg && typeof currentCfg === 'object') {
          if (d.updatedBranchStockForCabang && typeof d.updatedBranchStockForCabang === 'object') {
            currentCfg.branchStockInventory = currentCfg.branchStockInventory || {};
            currentCfg.branchStockInventory[cabang] = d.updatedBranchStockForCabang;
          }
          if (d.latestOpLogSummary && typeof d.latestOpLogSummary === 'object') {
            currentCfg.opLogsSummary = Array.isArray(currentCfg.opLogsSummary) ? currentCfg.opLogsSummary : [];
            var delIds = Array.isArray(currentCfg.deletedOpLogIds) ? currentCfg.deletedOpLogIds : [];
            var incomingSlotKey = getGsRevisionSlotKey(d.latestOpLogSummary);
            currentCfg.opLogsSummary = currentCfg.opLogsSummary.filter(function(x) {
              if (!x || x.id === d.latestOpLogSummary.id || delIds.indexOf(String(x.id)) !== -1) return false;
              if (incomingSlotKey && getGsRevisionSlotKey(x) === incomingSlotKey) return false;
              return true;
            });
            currentCfg.opLogsSummary.unshift(d.latestOpLogSummary);
            if (currentCfg.opLogsSummary.length > 120) {
              currentCfg.opLogsSummary = currentCfg.opLogsSummary.slice(0, 120);
            }
          }
          currentCfg.updatedAt = new Date().getTime();
          saveCloudConfigToChunks(JSON.stringify(currentCfg));
        }
      } catch (syncStockErr) {}
    }

    // Simpan foto ke dalam Folder Kategori -> Subfolder Cabang_<Cabang>
    function saveImgToReportFolder(base64, name, kategoriLaporanKey) {
      if (typeof base64 === 'string' && base64.indexOf('sb:') === 0) {
        return secSbStoredPhoto_(base64.substring(3), cabang);
      }
      var targetFolder = getFolderFotoByKategoriLaporan(kategoriLaporanKey, cabang);
      var folderBranchUrl = targetFolder ? targetFolder.getUrl() : ('https://drive.google.com/drive/folders/' + FOLDER_ABSEN_ID);
      try {
        if (!base64 || base64.indexOf('base64,') === -1) {
          return { fileUrl: '-', folderUrl: folderBranchUrl };
        }
        var parts = base64.split('base64,');
        var contentType = parts[0].replace('data:', '').replace(';', '').toLowerCase();
        if (SEC_ALLOWED_IMAGE_TYPES.indexOf(contentType) === -1) {
          return { fileUrl: '- (format foto tidak diizinkan)', folderUrl: folderBranchUrl };
        }
        if (parts[1].length > SEC_MAX_IMAGE_BYTES * 1.4) {
          return { fileUrl: '- (ukuran foto terlalu besar)', folderUrl: folderBranchUrl };
        }
        var safeName = String(name).replace(/[\\\/:*?"<>|\r\n]/g, '_').substring(0, 150);
        var blob = Utilities.newBlob(Utilities.base64Decode(parts[1]), contentType, safeName);
        var createdFile = targetFolder.createFile(blob);
        try {
          if (SEC_ALLOW_PUBLIC_DRIVE_LINKS) { createdFile.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); }
        } catch (eShare) {}
        var fId = createdFile.getId();
        return {
          fileId: fId,
          fileUrl: createdFile.getUrl(),
          thumbUrl: 'https://drive.google.com/thumbnail?id=' + fId + '&sz=w800',
          folderUrl: folderBranchUrl
        };
      } catch (imgErr) {
        return { fileUrl: 'Foto tersimpan di aplikasi (' + imgErr.message + ')', folderUrl: folderBranchUrl };
      }
    }

    // 1, 2, 7, 8: ABSEN_MASUK, ABSEN_KELUAR, open_Store, Close_Store
    if (d.recordType === 'ABSEN_MUKA' || d.recordType === 'OPEN_STORE' || d.recordType === 'CLOSE_STORE') {
      var isPulang = (d.subType === 'MUKA_PULANG' || d.subType === 'CLOSE_MUKA');
      var isMasuk = (d.subType === 'MUKA_DATANG' || d.subType === 'OPEN_MUKA' || d.subType === 'MASUK');
      var tipeDetail = d.tipeAbsenDetail || (d.recordType + '_' + (d.subType || ''));
      var kategoriFolder = 'ABSENSI';
      if (d.recordType === 'OPEN_STORE' && !isMasuk) {
        kategoriFolder = 'OPEN_STORE';
      } else if (d.recordType === 'CLOSE_STORE' && !isPulang) {
        kategoriFolder = 'CLOSE_STORE';
      } else {
        kategoriFolder = 'ABSENSI';
      }

      var fotoLinks = [];
      var sbModeOn = !!secSbConfig_();
      var activeBranchFolderObj = sbModeOn ? null : getFolderFotoByKategoriLaporan(kategoriFolder, cabang);
      var activeBranchFolderUrl = activeBranchFolderObj ? activeBranchFolderObj.getUrl() : (sbModeOn ? '-' : ('https://drive.google.com/drive/folders/' + FOLDER_ABSEN_ID));

      if (d.closePhotosList && d.closePhotosList.length > 0) {
        var folderKeyMulti = (d.recordType === 'OPEN_STORE') ? 'OPEN_STORE' : 'CLOSE_STORE';
        for (var i = 0; i < d.closePhotosList.length; i++) {
          var cp = d.closePhotosList[i];
          var savedMulti = saveImgToReportFolder(cp.base64, folderKeyMulti + '_' + cabang + '_' + (i + 1) + '_' + cp.label.replace(/[^a-zA-Z0-9]/g, '_') + '_' + d.tanggal + '.jpg', folderKeyMulti);
          fotoLinks.push(cp.label + ': ' + savedMulti.fileUrl);
          activeBranchFolderUrl = savedMulti.folderUrl;
        }
      } else if (d.openPhotosList && d.openPhotosList.length > 0) {
        for (var opIdx = 0; opIdx < d.openPhotosList.length; opIdx++) {
          var op = d.openPhotosList[opIdx];
          var savedOp = saveImgToReportFolder(op.base64, 'OPEN_' + cabang + '_' + (opIdx + 1) + '_' + op.label.replace(/[^a-zA-Z0-9]/g, '_') + '_' + d.tanggal + '.jpg', 'OPEN_STORE');
          fotoLinks.push(op.label + ': ' + savedOp.fileUrl);
          activeBranchFolderUrl = savedOp.folderUrl;
        }
      } else {
        var fotoUtamaBase64 = d.fotoBukti || d.fotoBoothBuka || d.fotoLampuMati || d.fotoDepanStore || '';
        var prefixNamaFile = isPulang ? 'ABSEN_PULANG' : (isMasuk ? 'ABSEN_DATANG' : tipeDetail);
        var savedSingle = saveImgToReportFolder(fotoUtamaBase64, prefixNamaFile + '_' + cabang + '_' + d.tanggal + '_' + d.nama + '_' + d.shift + '.jpg', kategoriFolder);
        fotoLinks.push(savedSingle.fileUrl);
        activeBranchFolderUrl = savedSingle.folderUrl;
      }

      var statusSingkat = d.punctualityStatus || (d.recordType === 'ABSEN_MUKA' ? 'TEPAT WAKTU' : '-');
      var detailLengkap = d.punctualityDetail || d.punctualityStatus || '-';

      if (d.recordType === 'OPEN_STORE' && !isMasuk) {
        var shOpen = ss.getSheetByName('open_Store') || ss.insertSheet('open_Store');
        secAppendRow_(shOpen, [
          new Date(), d.tanggal || '-', d.waktu || '-', cabang, d.shift || '-', d.shiftScheduleLabel || '-',
          d.nama || '-', d.checklistSummary || '-', d.lokasiWatermark || '-',
          fotoLinks.join(' | '), activeBranchFolderUrl, d.catatan || '-'
        ]);
      } else if (d.recordType === 'CLOSE_STORE' && !isPulang) {
        var shClose = ss.getSheetByName('Close_Store') || ss.insertSheet('Close_Store');
        var jmlFotoClose = (d.closePhotosList && d.closePhotosList.length > 0) ? (d.closePhotosList.length + ' Foto') : '2 Foto';
        secAppendRow_(shClose, [
          new Date(), d.tanggal || '-', d.waktu || '-', cabang, d.shift || '-', d.shiftScheduleLabel || '-',
          d.nama || '-', jmlFotoClose, d.checklistSummary || '-', d.lokasiWatermark || '-',
          fotoLinks.join(' | '), activeBranchFolderUrl, d.catatan || '-'
        ]);
      } else if (isPulang) {
        var shKeluarAbsen = ss.getSheetByName('Absen_Keluar') || ss.insertSheet('Absen_Keluar');
        secAppendRow_(shKeluarAbsen, [
          new Date(), d.tanggal || '-', d.waktu || '-', cabang, d.nama || '-',
          d.shift || '-', d.shiftScheduleLabel || '-', statusSingkat,
          detailLengkap, d.lokasiWatermark || '-',
          fotoLinks.join(' | '), activeBranchFolderUrl, d.catatan || '-'
        ]);
      } else {
        var shMasukAbsen = ss.getSheetByName('Absen_Masuk') || ss.insertSheet('Absen_Masuk');
        secAppendRow_(shMasukAbsen, [
          new Date(), d.tanggal || '-', d.waktu || '-', cabang, d.nama || '-',
          d.shift || '-', d.shiftScheduleLabel || '-', statusSingkat,
          detailLengkap, d.lokasiWatermark || '-',
          fotoLinks.join(' | '), activeBranchFolderUrl, d.catatan || '-'
        ]);
      }

      if (d.latestOpLogSummary && fotoLinks.length > 0 && fotoLinks[0] && fotoLinks[0] !== '-') {
        try {
          var firstUrl = fotoLinks[0];
          var firstThumb = toGsDriveThumbnailUrl(firstUrl);
          var cfgAfterImg = loadCloudConfigFromChunks(true);
          if (cfgAfterImg && Array.isArray(cfgAfterImg.opLogsSummary)) {
            for (var uIdx = 0; uIdx < cfgAfterImg.opLogsSummary.length; uIdx++) {
              var sItm = cfgAfterImg.opLogsSummary[uIdx];
              if (sItm && sItm.id === d.latestOpLogSummary.id) {
                sItm.fotoDriveUrl = firstUrl;
                sItm.folderDriveUrl = activeBranchFolderUrl;
                if (firstThumb) sItm.fotoBukti = firstThumb;
                break;
              }
            }
            saveCloudConfigToChunks(JSON.stringify(cfgAfterImg), false);
          }
        } catch (eUpdImg) {}
      }

      return JSON.stringify({
        status: 'success',
        branchSpreadsheetId: ss.getId(),
        branchSpreadsheetUrl: ss.getUrl(),
        fileUrl: fotoLinks[0] || '',
        folderUrl: activeBranchFolderUrl
      });
    }

    // 6: Barang_Datang
    if (d.recordType === 'BARANG_DATANG') {
      var shMasuk = ss.getSheetByName('Barang_Datang') || ss.insertSheet('Barang_Datang');
      if (d.incomingItemsDetail && d.incomingItemsDetail.length > 0) {
        for (var k = 0; k < d.incomingItemsDetail.length; k++) {
          var itm = d.incomingItemsDetail[k];
          var satuanBrg = (String(itm.name || '').toLowerCase().indexOf('tinta') !== -1) ? 'Botol' : (itm.unit || 'Pcs');
          secAppendRow_(shMasuk, [
            new Date(), cabang, d.senderRole || 'USER', d.tanggal || '-', d.incomingDate || d.tanggal || '-', d.waktu || '-', d.shift || '-',
            d.nama || '-', d.petugasBantu || '-', itm.code || '-', itm.name || '-', itm.category || '-', satuanBrg,
            itm.stockBefore !== undefined ? itm.stockBefore : '-',
            itm.addedQty !== undefined ? itm.addedQty : '-',
            itm.stockAfter !== undefined ? itm.stockAfter : '-',
            d.positiveSummary || '-', d.catatan || '-'
          ]);
        }
      } else {
        secAppendRow_(shMasuk, [
          new Date(), cabang, d.senderRole || 'USER', d.tanggal || '-', d.incomingDate || d.tanggal || '-', d.waktu || '-', d.shift || '-',
          d.nama || '-', d.petugasBantu || '-', '-', '-', '-', '-', '-', '-', '-',
          d.positiveSummary || d.itemsSummary || '-', d.catatan || '-'
        ]);
      }
      return JSON.stringify({ status: 'success', branchSpreadsheetId: ss.getId(), branchSpreadsheetUrl: ss.getUrl() });
    }

    // 5: Stock_Opname
    if (d.recordType === 'STOCK_OPNAME') {
      var shStok = ss.getSheetByName('Stock_Opname') || ss.insertSheet('Stock_Opname');
      secAppendRow_(shStok, [
        new Date(), cabang, d.senderRole || 'USER', d.tanggal || '-', d.cutoffDate || d.tanggal || '-', d.waktu || '-',
        d.shift || '-', d.nama || '-', d.petugasBantu || '-',
        d.kertasPax !== undefined ? d.kertasPax : '-',
        d.hangtagKecilPcs !== undefined ? d.hangtagKecilPcs : '-',
        d.hangtagBesarPcs !== undefined ? d.hangtagBesarPcs : '-',
        d.keychainPanjangPcs !== undefined ? d.keychainPanjangPcs : '-',
        d.keychainBulatPcs !== undefined ? d.keychainBulatPcs : '-',
        d.plastikKecilIkat !== undefined ? d.plastikKecilIkat : '-',
        d.plastikBesarIkat !== undefined ? d.plastikBesarIkat : '-',
        d.tintaLmPct !== undefined ? d.tintaLmPct : '-',
        d.tintaLcPct !== undefined ? d.tintaLcPct : '-',
        d.tintaYPct !== undefined ? d.tintaYPct : '-',
        d.tintaMPct !== undefined ? d.tintaMPct : '-',
        d.tintaCPct !== undefined ? d.tintaCPct : '-',
        d.tintaKPct !== undefined ? d.tintaKPct : '-',
        d.lemGanciPcs !== undefined ? d.lemGanciPcs : '-',
        d.extraItemsSummary || '-',
        d.catatan || '-'
      ]);
      return JSON.stringify({ status: 'success', branchSpreadsheetId: ss.getId(), branchSpreadsheetUrl: ss.getUrl() });
    }

    // 3 & 4: Laporan_Harian & Rekap_Pengeluaran (Dilengkapi Kolom 18: Status Revisi)
    var shLapHarian = ss.getSheetByName('Laporan_Harian') || ss.insertSheet('Laporan_Harian');
    try {
      var hdrRev = String(shLapHarian.getRange(1, 18).getDisplayValue() || '').trim();
      if (hdrRev !== 'Status Revisi') {
        shLapHarian.getRange(1, 18).setValue('Status Revisi').setFontWeight('bold').setBackground('#19449a').setFontColor('#ffffff');
      }
    } catch (eHdrLap) {}

    // Hitung sudah berapa kali (Tanggal + Cabang + Shift) ini pernah masuk di Spreadsheet Laporan_Harian
    var existingSameShiftCount = 0;
    try {
      var lastRowLap = shLapHarian.getLastRow();
      if (lastRowLap >= 2) {
        var numRowsCheck = lastRowLap - 1;
        var rawCheck = shLapHarian.getRange(2, 1, numRowsCheck, 6).getValues();
        var dispCheck = shLapHarian.getRange(2, 1, numRowsCheck, 6).getDisplayValues();
        var targetDateNorm = normalizeGsDateCell(null, d.tanggal);
        var targetShiftNorm = normalizeGsShiftName(d.shift).toLowerCase();
        var targetCabangNorm = String(cabang || '').trim().toLowerCase();
        for (var rc = 0; rc < numRowsCheck; rc++) {
          var rowD = normalizeGsDateCell(rawCheck[rc][1], dispCheck[rc][1]);
          var rowC = String(dispCheck[rc][3] || cabang).trim().toLowerCase();
          var rowS = normalizeGsShiftName(dispCheck[rc][4]).toLowerCase();
          if (rowD === targetDateNorm && rowC === targetCabangNorm && rowS === targetShiftNorm) {
            existingSameShiftCount++;
          }
        }
      }
    } catch (eCnt) {}

    var statusRevisiFinal = 'Laporan Awal';
    if (existingSameShiftCount >= 1 || d.isConfirmedRevision || (Number(d.revisionCount) || 0) >= 1) {
      var revNumber = Math.max(existingSameShiftCount, Number(d.revisionCount) || 1);
      statusRevisiFinal = 'Revisi Ke-' + revNumber;
    } else if (d.statusRevisi) {
      statusRevisiFinal = String(d.statusRevisi);
    }

    if (d.latestOpLogSummary && typeof d.latestOpLogSummary === 'object') {
      d.latestOpLogSummary.statusRevisi = statusRevisiFinal;
      d.latestOpLogSummary.revisionCount = existingSameShiftCount;
    }

    var savedSerah = saveImgToReportFolder(d.fotoSerahTerima, 'PEMASUKAN_SERAH_TERIMA_' + cabang + '_' + d.tanggal + '_' + d.nama + '_' + (d.shift || '') + '.jpg', 'SERAH_TERIMA');
    var savedStruk = saveImgToReportFolder(d.fotoStruk, 'STRUK_BELANJA_' + cabang + '_' + d.tanggal + '_' + d.nama + '_' + (d.shift || '') + '.jpg', 'STRUK_BELANJA');

    secAppendRow_(shLapHarian, [
      new Date(), d.tanggal || '-', d.waktu || '-', cabang, d.shift || '-', d.nama || '-',
      d.cash || 0, d.qris || 0, d.totalGross || 0,
      d.totalExpense || 0, d.rincianPengeluaran || '-',
      d.netOmzet || 0,
      savedSerah.fileUrl, savedSerah.folderUrl,
      savedStruk.fileUrl, savedStruk.folderUrl,
      d.catatan || '-',
      statusRevisiFinal
    ]);

    var totalExp = Number(d.totalExpense) || 0;
    var hasExpList = d.expensesList && d.expensesList.length > 0;
    var hasExpText = d.rincianPengeluaran && d.rincianPengeluaran !== '-' && d.rincianPengeluaran !== '';
    if (totalExp > 0 || hasExpList || hasExpText) {
      var shRekapKeluar = ss.getSheetByName('Rekap_Pengeluaran') || ss.insertSheet('Rekap_Pengeluaran');
      if (hasExpList) {
        for (var j = 0; j < d.expensesList.length; j++) {
          var exItem = d.expensesList[j];
          secAppendRow_(shRekapKeluar, [
            new Date(), d.tanggal || '-', d.waktu || '-', cabang, d.shift || '-', d.nama || '-',
            exItem.desc || 'Pengeluaran Operasional', Number(exItem.amount) || 0,
            totalExp, savedStruk.fileUrl, savedStruk.folderUrl, d.catatan || '-'
          ]);
        }
      } else {
        secAppendRow_(shRekapKeluar, [
          new Date(), d.tanggal || '-', d.waktu || '-', cabang, d.shift || '-', d.nama || '-',
          d.rincianPengeluaran || 'Pengeluaran Kas', totalExp,
          totalExp, savedStruk.fileUrl, savedStruk.folderUrl, d.catatan || '-'
        ]);
      }
    }

    if (d.latestOpLogSummary) {
      try {
        var cfgAfterLapImg = loadCloudConfigFromChunks(true);
        if (cfgAfterLapImg && Array.isArray(cfgAfterLapImg.opLogsSummary)) {
          for (var lIdx2 = 0; lIdx2 < cfgAfterLapImg.opLogsSummary.length; lIdx2++) {
            var lItm = cfgAfterLapImg.opLogsSummary[lIdx2];
            if (lItm && lItm.id === d.latestOpLogSummary.id) {
              if (savedSerah && savedSerah.fileUrl && savedSerah.fileUrl !== '-') {
                lItm.fotoSerahDriveUrl = savedSerah.fileUrl;
                lItm.folderSerahDriveUrl = savedSerah.folderUrl;
                if (savedSerah.thumbUrl) lItm.fotoSerahTerima = savedSerah.thumbUrl;
              }
              if (savedStruk && savedStruk.fileUrl && savedStruk.fileUrl !== '-') {
                lItm.fotoStrukDriveUrl = savedStruk.fileUrl;
                lItm.folderStrukDriveUrl = savedStruk.folderUrl;
                if (savedStruk.thumbUrl) lItm.fotoStruk = savedStruk.thumbUrl;
              }
              break;
            }
          }
          saveCloudConfigToChunks(JSON.stringify(cfgAfterLapImg), false);
        }
      } catch (eUpdLapImg) {}
    }

    return JSON.stringify({
      status: 'success',
      branchSpreadsheetId: ss.getId(),
      branchSpreadsheetUrl: ss.getUrl(),
      folderPemasukanUrl: savedSerah.folderUrl,
      folderStrukUrl: savedStruk.folderUrl
    });
  } catch (err) {
    // Laporan gagal ditulis: lepas penanda anti-duplikat agar kirim ulang TIDAK dianggap klik 2x
    if (dedupCacheKey) { try { CacheService.getScriptCache().remove(dedupCacheKey); } catch (eDedup) {} }
    return secErrorJson_(err);
  } finally {
    try { lock.releaseLock(); } catch (eLock) {}
  }
}