import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export class Store {
  constructor(directory) {
    mkdirSync(directory, { recursive: true });
    this.db = new DatabaseSync(join(directory, 'applications.sqlite'));
    this.db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS runs (
        id INTEGER PRIMARY KEY,
        portal TEXT NOT NULL,
        checked_at TEXT NOT NULL,
        outcome TEXT NOT NULL,
        error TEXT
      );
      CREATE TABLE IF NOT EXISTS observations (
        id INTEGER PRIMARY KEY,
        run_id INTEGER NOT NULL REFERENCES runs(id),
        application_key TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        url TEXT,
        requisition_id TEXT,
        UNIQUE(run_id, application_key)
      );
    `);
  }

  save(portal, applications, checkedAt = new Date().toISOString()) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const previous = this.latest(portal);
      const run = this.db.prepare('INSERT INTO runs (portal, checked_at, outcome) VALUES (?, ?, ?)')
        .run(portal, checkedAt, 'success');
      const insert = this.db.prepare(`
        INSERT INTO observations (run_id, application_key, title, status, url, requisition_id)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      const changes = [];
      const savedApplications = [];
      for (const observed of applications) {
        let application = observed;
        if (observed.key.startsWith('req:') && observed.url &&
            applications.filter(item => item.url === observed.url).length === 1) {
          const existing = previous?.applications.find(item =>
            item.key === `url:${observed.url}` &&
            (!item.requisitionId || item.requisitionId === observed.requisitionId));
          if (existing) application = { ...observed, key: existing.key };
        }
        insert.run(run.lastInsertRowid, application.key, application.title, application.status,
          application.url, application.requisitionId);
        savedApplications.push(application);
        const old = previous?.applications.find(item => item.key === application.key);
        if (old && old.status !== application.status) {
          changes.push({ title: application.title, previousStatus: old.status, status: application.status });
        }
      }
      this.db.exec('COMMIT');
      return { checkedAt, applications: savedApplications, changes };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  fail(portal, error) {
    this.db.prepare('INSERT INTO runs (portal, checked_at, outcome, error) VALUES (?, ?, ?, ?)')
      .run(portal, new Date().toISOString(), 'failed', error);
  }

  requireAction(portal, message) {
    this.db.prepare('INSERT INTO runs (portal, checked_at, outcome, error) VALUES (?, ?, ?, ?)')
      .run(portal, new Date().toISOString(), 'needs_user_action', message);
  }

  latest(portal) {
    const run = this.db.prepare("SELECT * FROM runs WHERE portal = ? AND outcome = 'success' ORDER BY id DESC LIMIT 1").get(portal);
    if (!run) return null;
    const applications = this.db.prepare(`
      SELECT application_key AS key, title, status, url, requisition_id AS requisitionId
      FROM observations WHERE run_id = ? ORDER BY id
    `).all(run.id);
    return { checkedAt: run.checked_at, applications };
  }

  report(portal) {
    const latestCheck = this.db.prepare('SELECT checked_at AS checkedAt, outcome, error FROM runs WHERE portal = ? ORDER BY id DESC LIMIT 1').get(portal);
    return { latestCheck: latestCheck || null, lastSuccessfulCheck: this.latest(portal) };
  }

  history(portal) {
    return this.db.prepare(`
      SELECT r.checked_at AS checkedAt, o.application_key AS key, o.title, o.status
      FROM observations o JOIN runs r ON r.id = o.run_id
      WHERE r.portal = ? ORDER BY r.id, o.id
    `).all(portal);
  }

  close() {
    this.db.close();
  }
}
