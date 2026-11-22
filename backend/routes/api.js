/**
 * REST API Router — Oh Snap! Photobox 5 Cabang (versi aman)
 * Dipanggil hanya setelah server.js memverifikasi header X-API-Key.
 */
const db = require('../config/database');
const reportController = require('../controllers/reportController');

function handleApiRequest(req, res, parsedUrl, bodyObj) {
  const pathname = parsedUrl.pathname;
  const method = req.method.toUpperCase();

  const sendJson = (statusCode, payload) => {
    res.writeHead(statusCode, {
      'Content-Type': 'application/json; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store'
    });
    res.end(JSON.stringify(payload));
  };

  const safe = (fn) => {
    try {
      return sendJson(200, fn());
    } catch (e) {
      return sendJson(400, { status: 'error', message: 'Permintaan tidak valid.' });
    }
  };

  if (pathname === '/api/config' && method === 'GET') {
    const state = db.readDb();
    const cfg = state.cloud_config && Object.keys(state.cloud_config).length > 0
      ? state.cloud_config
      : {
          branches: state.branches,
          schedules: state.schedules,
          closeRules: state.closeRules,
          stockCatalogMeta: state.stock_catalog,
          deletedOpLogIds: state.deleted_oplog_ids,
          opLogsSummary: (state.op_logs_history || []).slice(0, 80),
          updatedAt: Date.now()
        };
    // Kru hanya diekspos tanpa password / PIN
    const employees = (cfg.employees || state.employees || []).map(e => ({ id: e.id, name: e.name, defaultBranch: e.defaultBranch }));
    const out = Object.assign({}, cfg, { employees });
    delete out.adminPin;
    return sendJson(200, { status: 'success', version: 'v4_cloud_sync', cloudConfig: out });
  }

  if (pathname === '/api/config' && method === 'POST') {
    return safe(() => {
      const body = Object.assign({}, bodyObj);
      delete body.adminPin;
      if (Array.isArray(body.employees)) {
        body.employees = body.employees.map(e => ({ id: e.id, name: e.name, defaultBranch: e.defaultBranch }));
      }
      return reportController.handleAdminConfigSync(body);
    });
  }

  if (pathname === '/api/webhook' && method === 'POST') {
    return safe(() => {
      const payload = bodyObj && bodyObj.payload
        ? (typeof bodyObj.payload === 'string' ? JSON.parse(bodyObj.payload) : bodyObj.payload)
        : bodyObj;
      return reportController.saveReportFromPayload(payload);
    });
  }

  if (pathname === '/api/logs' && method === 'GET') {
    return safe(() => {
      const period = parsedUrl.searchParams.get('period') || '1_TAHUN';
      const branch = parsedUrl.searchParams.get('branch') || 'ALL';
      const recordType = parsedUrl.searchParams.get('recordType') || 'ALL';
      return Object.assign({ status: 'success' }, reportController.queryLogsByPeriodAndBranch({ period, branch, recordType }));
    });
  }

  if (pathname === '/api/logs/delete' && method === 'POST') {
    return safe(() => {
      const ids = bodyObj && (bodyObj.ids || bodyObj.id) ? [].concat(bodyObj.ids || bodyObj.id) : [];
      return reportController.deleteOpLogRecords(ids.map(String));
    });
  }

  if (pathname.startsWith('/api/logs/') && method === 'DELETE') {
    return safe(() => {
      const logId = decodeURIComponent(pathname.slice('/api/logs/'.length));
      return reportController.deleteOpLogRecords([logId]);
    });
  }

  return sendJson(404, { status: 'error', message: 'Endpoint tidak ditemukan.' });
}

module.exports = { handleApiRequest };
