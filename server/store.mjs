import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

export const digest = (value) => createHash('sha256').update(value).digest('hex');

export class Store {
  constructor(directory) {
    if (directory !== ':memory:') mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(directory === ':memory:' ? directory : join(directory, 'revery.sqlite'));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, csrf TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS issued (namespace TEXT, asset_id TEXT, PRIMARY KEY(namespace, asset_id));
      CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, namespace TEXT NOT NULL, asset_id TEXT NOT NULL,
        action TEXT NOT NULL, status TEXT NOT NULL, snapshot TEXT NOT NULL, created INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS events_by_asset ON events(namespace, asset_id);
      CREATE TABLE IF NOT EXISTS reviewed (namespace TEXT, asset_id TEXT, event_id TEXT NOT NULL, action TEXT NOT NULL,
        PRIMARY KEY(namespace, asset_id));
      CREATE TABLE IF NOT EXISTS scan (namespace TEXT PRIMARY KEY, page INTEGER NOT NULL DEFAULT 1, cursor TEXT);
    `);
    if (!this.db.prepare('PRAGMA table_info(scan)').all().some((column) => column.name === 'cursor')) this.db.exec('ALTER TABLE scan ADD COLUMN cursor TEXT');
    this.db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now());
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  createSession() {
    const token = randomBytes(32).toString('hex');
    const csrf = randomBytes(32).toString('hex');
    const expires = Date.now() + 7 * 86400000;
    this.db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run(digest(token), csrf, expires);
    return { token, csrf, expires };
  }
  session(token) {
    if (!token) return null;
    return this.db.prepare('SELECT csrf, expires FROM sessions WHERE token = ? AND expires > ?').get(digest(token), Date.now()) ?? null;
  }
  revoke(token) { if (token) this.db.prepare('DELETE FROM sessions WHERE token = ?').run(digest(token)); }
  setting(key) { return this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value; }
  setSetting(key, value) { this.db.prepare('INSERT OR REPLACE INTO settings VALUES (?, ?)').run(key, value); }
  revokeAll() { this.db.exec('DELETE FROM sessions'); }
  issue(namespace, assets) {
    this.transaction(() => {
      const statement = this.db.prepare('INSERT OR IGNORE INTO issued VALUES (?, ?)');
      for (const asset of assets) statement.run(namespace, asset.id);
    });
  }
  wasIssued(namespace, id) { return !!this.db.prepare('SELECT 1 FROM issued WHERE namespace = ? AND asset_id = ?').get(namespace, id); }
  reviewed(namespace, id) { return this.db.prepare('SELECT * FROM reviewed WHERE namespace = ? AND asset_id = ?').get(namespace, id); }
  event(namespace, id) { return this.db.prepare('SELECT * FROM events WHERE namespace = ? AND id = ?').get(namespace, id); }
  pending(namespace, assetId) {
    return this.db.prepare("SELECT * FROM events WHERE namespace = ? AND asset_id = ? AND status = 'pending'").get(namespace, assetId);
  }
  begin(namespace, id, asset, action) {
    this.db.prepare('INSERT INTO events VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, namespace, asset.id, action, 'pending', JSON.stringify(asset), Date.now());
  }
  complete(namespace, id) {
    this.transaction(() => {
      const event = this.event(namespace, id);
      this.db.prepare("UPDATE events SET status = 'complete' WHERE id = ?").run(id);
      this.db.prepare('INSERT OR REPLACE INTO reviewed VALUES (?, ?, ?, ?)').run(namespace, event.asset_id, id, event.action);
    });
  }
  discard(namespace, id) { this.db.prepare("UPDATE events SET status = 'failed' WHERE namespace = ? AND id = ?").run(namespace, id); }
  undo(namespace, id) {
    this.transaction(() => {
      this.db.prepare("UPDATE events SET status = 'undone' WHERE namespace = ? AND id = ?").run(namespace, id);
      this.db.prepare('DELETE FROM reviewed WHERE namespace = ? AND event_id = ?').run(namespace, id);
      this.db.prepare('DELETE FROM scan WHERE namespace = ?').run(namespace);
    });
  }
  stats(namespace) {
    const row = this.db.prepare("SELECT count(*) AS reviewed, coalesce(sum(action = 'trash'), 0) AS trashed FROM reviewed WHERE namespace = ?").get(namespace);
    return { reviewed: Number(row.reviewed), trashed: Number(row.trashed) };
  }
  recent(namespace) {
    return this.db.prepare("SELECT id, action, snapshot FROM events WHERE namespace = ? AND status = 'complete' ORDER BY created DESC LIMIT 30").all(namespace)
      .map((event) => ({ id: event.id, action: event.action, asset: JSON.parse(event.snapshot) }));
  }
  pendingEvents(namespace) {
    return this.db.prepare("SELECT id, action, snapshot FROM events WHERE namespace = ? AND status = 'pending' ORDER BY created").all(namespace)
      .map((event) => ({ id: event.id, action: event.action, asset: JSON.parse(event.snapshot) }));
  }
  scanCursor(namespace) { return this.db.prepare('SELECT cursor FROM scan WHERE namespace = ?').get(namespace)?.cursor ?? null; }
  setScanCursor(namespace, cursor) { this.db.prepare('INSERT OR REPLACE INTO scan (namespace, cursor) VALUES (?, ?)').run(namespace, cursor); }
  reset(namespace) {
    this.transaction(() => {
      this.db.prepare("UPDATE events SET status = 'undone' WHERE namespace = ? AND action = 'keep' AND status = 'complete'").run(namespace);
      this.db.prepare("DELETE FROM reviewed WHERE namespace = ? AND action = 'keep'").run(namespace);
      this.db.prepare('DELETE FROM scan WHERE namespace = ?').run(namespace);
    });
  }
  close() { this.db.close(); }
}
