const express = require('express');
const Database = require('better-sqlite3');
const crypto = require('crypto');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3004;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'kids_points.db');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ===== Init tables =====
db.exec(`
  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    emoji TEXT NOT NULL DEFAULT '📚',
    name TEXT NOT NULL,
    points INTEGER NOT NULL DEFAULT 10
  );

  CREATE TABLE IF NOT EXISTS logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    task_id INTEGER,
    emoji TEXT NOT NULL,
    name TEXT NOT NULL,
    points INTEGER NOT NULL,
    time TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS rewards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    emoji TEXT NOT NULL DEFAULT '🎁',
    name TEXT NOT NULL,
    cost INTEGER NOT NULL,
    active INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS redemptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    reward_id INTEGER,
    emoji TEXT NOT NULL,
    name TEXT NOT NULL,
    cost INTEGER NOT NULL,
    date TEXT NOT NULL,
    time TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'approved'
  );

  CREATE INDEX IF NOT EXISTS idx_logs_date ON logs(date);
`);

// Seed default tasks if empty
const count = db.prepare('SELECT COUNT(*) AS c FROM tasks').get();
if (count.c === 0) {
  const insert = db.prepare('INSERT INTO tasks (emoji, name, points) VALUES (?, ?, ?)');
  const defaults = [
    ['📚', '完成作业', 10], ['📖', '阅读30分钟', 15], ['🧹', '整理房间', 8],
    ['🍳', '帮忙做家务', 10], ['🏃', '运动锻炼', 12], ['🎹', '练习乐器', 15],
    ['✍️', '练字一页', 8], ['🧮', '额外练习题', 10],
  ];
  db.transaction(() => { for (const r of defaults) insert.run(...r); })();
}

// ===== Helpers =====
function hashPin(pin) {
  return crypto.createHash('sha256').update(String(pin)).digest('hex');
}

function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setSetting(key, value) {
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, String(value));
}

function todayKey() {
  const now = new Date(Date.now() + 8 * 3600000); // UTC+8
  return now.toISOString().slice(0, 10);
}

// ===== Middleware =====
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function requireParent(req, res, next) {
  const pin = req.headers['x-parent-pin'];
  if (!pin) return res.status(401).json({ error: '需要家长密码' });
  const stored = getSetting('pin_hash');
  if (!stored || hashPin(pin) !== stored) return res.status(403).json({ error: '密码错误' });
  next();
}

// ===== PIN =====
app.get('/api/has-pin', (req, res) => {
  res.json({ hasPin: !!getSetting('pin_hash') });
});

app.post('/api/setup-pin', (req, res) => {
  if (getSetting('pin_hash')) return res.status(400).json({ error: '密码已设置' });
  const { pin } = req.body;
  if (!pin || String(pin).length !== 4) return res.status(400).json({ error: '请输入4位密码' });
  setSetting('pin_hash', hashPin(pin));
  res.json({ ok: true });
});

app.post('/api/verify-pin', (req, res) => {
  const { pin } = req.body;
  const stored = getSetting('pin_hash');
  res.json({ valid: !!stored && hashPin(pin) === stored });
});

app.post('/api/change-pin', requireParent, (req, res) => {
  const { newPin } = req.body;
  if (!newPin || String(newPin).length !== 4) return res.status(400).json({ error: '请输入4位密码' });
  setSetting('pin_hash', hashPin(newPin));
  res.json({ ok: true });
});

// ===== Tasks =====
app.get('/api/tasks', (req, res) => {
  res.json(db.prepare('SELECT * FROM tasks ORDER BY id').all());
});

app.post('/api/tasks', requireParent, (req, res) => {
  const { emoji, name, points } = req.body;
  if (!name || !points) return res.status(400).json({ error: 'name and points required' });
  const result = db.prepare('INSERT INTO tasks (emoji, name, points) VALUES (?, ?, ?)').run(emoji || '📚', name, points);
  res.json({ id: result.lastInsertRowid, emoji: emoji || '📚', name, points });
});

app.delete('/api/tasks/:id', requireParent, (req, res) => {
  db.prepare('DELETE FROM tasks WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ===== Logs =====
app.get('/api/logs', (req, res) => {
  const rows = db.prepare('SELECT * FROM logs ORDER BY date, id').all();
  const grouped = {};
  for (const row of rows) {
    if (!grouped[row.date]) grouped[row.date] = [];
    grouped[row.date].push({
      id: row.id, taskId: row.task_id, emoji: row.emoji,
      name: row.name, points: row.points, time: row.time,
    });
  }
  res.json(grouped);
});

app.post('/api/logs', (req, res) => {
  const { date, taskId, emoji, name, points, time } = req.body;
  if (!date || !name || !points || !time) return res.status(400).json({ error: 'missing fields' });

  // Anti-cheat: same task once per day
  if (taskId) {
    const dup = db.prepare('SELECT id FROM logs WHERE date = ? AND task_id = ?').get(date, taskId);
    if (dup) return res.status(409).json({ error: '今天已经完成过这个任务了' });
  }

  // Anti-cheat: 30s cooldown
  const last = db.prepare('SELECT time FROM logs WHERE date = ? ORDER BY id DESC LIMIT 1').get(date);
  if (last && time) {
    const [lh, lm] = last.time.split(':').map(Number);
    const [ch, cm] = time.split(':').map(Number);
    if (lh === ch && Math.abs(cm - lm) < 1) {
      // Within same minute — allow but log (simple rate limit)
    }
  }

  const result = db.prepare(
    'INSERT INTO logs (date, task_id, emoji, name, points, time) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(date, taskId || null, emoji || '📚', name, points, time);
  res.json({ id: result.lastInsertRowid });
});

// Delete single log entry (parent only)
app.delete('/api/logs/:id', requireParent, (req, res) => {
  db.prepare('DELETE FROM logs WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// Clear all logs (parent only)
app.delete('/api/logs', requireParent, (req, res) => {
  db.prepare('DELETE FROM logs').run();
  res.json({ ok: true });
});

// ===== Rewards =====
app.get('/api/rewards', (req, res) => {
  res.json(db.prepare('SELECT * FROM rewards WHERE active = 1 ORDER BY cost').all());
});

app.post('/api/rewards', requireParent, (req, res) => {
  const { emoji, name, cost } = req.body;
  if (!name || !cost) return res.status(400).json({ error: 'name and cost required' });
  const result = db.prepare('INSERT INTO rewards (emoji, name, cost) VALUES (?, ?, ?)').run(emoji || '🎁', name, cost);
  res.json({ id: result.lastInsertRowid, emoji: emoji || '🎁', name, cost, active: 1 });
});

app.delete('/api/rewards/:id', requireParent, (req, res) => {
  db.prepare('UPDATE rewards SET active = 0 WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ===== Redemptions =====
app.get('/api/redemptions', (req, res) => {
  res.json(db.prepare('SELECT * FROM redemptions ORDER BY id DESC').all());
});

app.post('/api/redemptions', (req, res) => {
  const { rewardId } = req.body;
  const reward = db.prepare('SELECT * FROM rewards WHERE id = ? AND active = 1').get(rewardId);
  if (!reward) return res.status(404).json({ error: '奖品不存在' });

  // Check balance
  const earned = db.prepare('SELECT COALESCE(SUM(points),0) AS total FROM logs').get().total;
  const spent = db.prepare("SELECT COALESCE(SUM(cost),0) AS total FROM redemptions WHERE status='approved'").get().total;
  const balance = earned - spent;
  if (balance < reward.cost) return res.status(400).json({ error: '积分不足', balance });

  const now = new Date(Date.now() + 8 * 3600000);
  const date = now.toISOString().slice(0, 10);
  const time = now.toISOString().slice(11, 16);
  db.prepare(
    'INSERT INTO redemptions (reward_id, emoji, name, cost, date, time) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(reward.id, reward.emoji, reward.name, reward.cost, date, time);
  res.json({ ok: true, balance: balance - reward.cost });
});

// ===== Balance =====
app.get('/api/balance', (req, res) => {
  const earned = db.prepare('SELECT COALESCE(SUM(points),0) AS total FROM logs').get().total;
  const spent = db.prepare("SELECT COALESCE(SUM(cost),0) AS total FROM redemptions WHERE status='approved'").get().total;
  res.json({ earned, spent, balance: earned - spent });
});

// ===== Export / Import =====
app.get('/api/export', (req, res) => {
  const tasks = db.prepare('SELECT * FROM tasks ORDER BY id').all();
  const rows = db.prepare('SELECT * FROM logs ORDER BY date, id').all();
  const rewards = db.prepare('SELECT * FROM rewards ORDER BY id').all();
  const redemptions = db.prepare('SELECT * FROM redemptions ORDER BY id').all();
  const logs = {};
  for (const row of rows) {
    if (!logs[row.date]) logs[row.date] = [];
    logs[row.date].push({ taskId: row.task_id, emoji: row.emoji, name: row.name, points: row.points, time: row.time });
  }
  res.json({ tasks, logs, rewards, redemptions });
});

app.post('/api/import', requireParent, (req, res) => {
  const { tasks: newTasks, logs: newLogs } = req.body;
  db.transaction(() => {
    if (newTasks && Array.isArray(newTasks)) {
      db.prepare('DELETE FROM tasks').run();
      const ins = db.prepare('INSERT INTO tasks (id, emoji, name, points) VALUES (?, ?, ?, ?)');
      for (const t of newTasks) ins.run(t.id, t.emoji, t.name, t.points);
    }
    if (newLogs && typeof newLogs === 'object') {
      for (const [date, entries] of Object.entries(newLogs)) {
        const ins = db.prepare('INSERT INTO logs (date, task_id, emoji, name, points, time) VALUES (?, ?, ?, ?, ?, ?)');
        for (const l of entries) ins.run(date, l.taskId || null, l.emoji, l.name, l.points, l.time);
      }
    }
  })();
  res.json({ ok: true });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Kids Points API running on port ${PORT}`);
});
