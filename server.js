const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const PORT = process.env.PORT || 3002;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'growth.db'));

db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS entries (
    id      INTEGER PRIMARY KEY,
    kind    TEXT NOT NULL CHECK (kind IN ('income', 'expense')),
    label   TEXT NOT NULL,
    amount  INTEGER NOT NULL CHECK (amount > 0),
    day     TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );
  CREATE INDEX IF NOT EXISTS idx_entries_day ON entries(day);
`);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function send(res, status, data) {
  const body = typeof data === 'string' ? data : JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': typeof data === 'string' ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 1e5) { reject(new Error('Body too large')); req.destroy(); }
    });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(new Error('Invalid JSON')); } });
    req.on('error', reject);
  });
}

function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) return send(res, 403, { error: 'Forbidden' });
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, '<h1>404</h1>');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

// ---------------------------------------------------------------------------
const routes = [
  {
    method: 'GET', pattern: /^\/api\/entries$/,
    handler: (req, res) => {
      const rows = db.prepare('SELECT * FROM entries ORDER BY day DESC, id DESC LIMIT 200').all();
      return send(res, 200, rows.map((r) => ({ id: r.id, kind: r.kind, label: r.label, amount: r.amount, day: r.day })));
    },
  },
  {
    method: 'POST', pattern: /^\/api\/entries$/,
    handler: async (req, res) => {
      try {
        const b = await readBody(req);
        const kind = b.kind === 'income' || b.kind === 'expense' ? b.kind : null;
        const amount = Math.round(Number(b.amount) * 100); // dollars -> cents
        const label = String(b.label || '').trim();
        const day = /^\d{4}-\d{2}-\d{2}$/.test(String(b.day || '')) ? b.day : new Date().toISOString().slice(0, 10);
        if (!kind) return send(res, 400, { error: "kind must be 'income' or 'expense'" });
        if (!Number.isFinite(amount) || amount <= 0) return send(res, 400, { error: 'amount must be > 0' });
        if (label.length < 2) return send(res, 400, { error: 'label required' });
        const info = db.prepare('INSERT INTO entries (kind, label, amount, day) VALUES (?, ?, ?, ?)').run(kind, label, amount, day);
        return send(res, 201, { id: info.lastInsertRowid, kind, label, amount, day });
      } catch (e) { return send(res, 400, { error: e.message }); }
    },
  },
  {
    method: 'DELETE', pattern: /^\/api\/entries\/(\d+)$/,
    handler: (req, res, m) => {
      const info = db.prepare('DELETE FROM entries WHERE id = ?').run(Number(m[1]));
      if (info.changes === 0) return send(res, 404, { error: 'Entry not found' });
      return send(res, 200, { deleted: Number(m[1]) });
    },
  },
  {
    method: 'GET', pattern: /^\/api\/summary$/,
    handler: (req, res) => {
      const totals = db.prepare(
        "SELECT SUM(CASE WHEN kind='income' THEN amount ELSE 0 END) AS income, SUM(CASE WHEN kind='expense' THEN amount ELSE 0 END) AS expense, COUNT(*) AS n FROM entries"
      ).get();
      const net = (totals.income || 0) - (totals.expense || 0);
      const byDay = db.prepare(
        "SELECT day, SUM(CASE WHEN kind='income' THEN amount ELSE 0 END) - SUM(CASE WHEN kind='expense' THEN amount ELSE 0 END) AS net FROM entries GROUP BY day ORDER BY day"
      ).all();
      let running = 0;
      const curve = byDay.map((d) => { running += d.net; return { day: d.day, net: running }; });
      return send(res, 200, {
        income: (totals.income || 0) / 100,
        expense: (totals.expense || 0) / 100,
        net: net / 100,
        entries: totals.n,
        curve, // cumulative net growth by day, from zero
      });
    },
  },
];

const server = http.createServer(async (req, res) => {
  const urlPath = new URL(req.url, 'http://x').pathname;
  for (const r of routes) {
    const m = urlPath.match(r.pattern);
    if (m && req.method === r.method) {
      try { return await r.handler(req, res, m); } catch { return send(res, 500, { error: 'Server error' }); }
    }
  }
  if (urlPath.startsWith('/api/')) return send(res, 404, { error: 'Unknown endpoint' });
  return serveStatic(res, urlPath);
});

server.listen(PORT, () => {
  console.log(`zero-growth-app tracking growth on http://localhost:${PORT}`);
});
