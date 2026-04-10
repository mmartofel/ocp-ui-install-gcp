'use strict';

// Uses built-in node:sqlite (available in Node.js >= 22.5)
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, '..', 'data', 'db', 'state.sqlite');

let db;

function initialize() {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS installs (
      install_id   TEXT PRIMARY KEY,
      session_id   TEXT NOT NULL,
      cluster_name TEXT,
      base_domain  TEXT,
      gcp_region   TEXT,
      gcp_project  TEXT,
      status       TEXT CHECK(status IN ('pending','running','complete','failed','aborted')) DEFAULT 'pending',
      started_at   INTEGER,
      finished_at  INTEGER,
      exit_code    INTEGER,
      install_dir  TEXT
    );

    CREATE TABLE IF NOT EXISTS install_logs (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      install_id  TEXT NOT NULL,
      line_number INTEGER NOT NULL,
      level       TEXT,
      message     TEXT NOT NULL,
      raw         TEXT NOT NULL,
      stage       TEXT,
      ts          INTEGER,
      FOREIGN KEY (install_id) REFERENCES installs(install_id)
    );

    CREATE TABLE IF NOT EXISTS cluster_status (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      install_id  TEXT NOT NULL,
      checked_at  INTEGER,
      api_url     TEXT,
      console_url TEXT,
      node_count  INTEGER,
      nodes_ready INTEGER,
      raw_json    TEXT,
      FOREIGN KEY (install_id) REFERENCES installs(install_id)
    );
  `);

  // Schema migration: add destroyed_at if the column doesn't exist yet
  try {
    db.exec('ALTER TABLE installs ADD COLUMN destroyed_at INTEGER DEFAULT NULL');
  } catch (_) { /* column already exists */ }

  // Schema migration: add sa_project (SA's own GCP project, may differ from deployment target)
  try {
    db.exec('ALTER TABLE installs ADD COLUMN sa_project TEXT DEFAULT NULL');
  } catch (_) { /* column already exists */ }

  // Schema migration: store scrubbed install-config YAML (without pull secret / SSH key)
  try {
    db.exec('ALTER TABLE installs ADD COLUMN install_yaml TEXT DEFAULT NULL');
  } catch (_) { /* column already exists */ }

  // Backfill sa_project for existing records using .sa-key.json where available
  const needsBackfill = db.prepare(
    "SELECT install_id, install_dir, gcp_project FROM installs WHERE sa_project IS NULL AND install_dir IS NOT NULL"
  ).all();
  for (const row of needsBackfill) {
    try {
      const saKey = JSON.parse(fs.readFileSync(path.join(row.install_dir, '.sa-key.json'), 'utf8'));
      if (saKey.project_id) {
        db.prepare("UPDATE installs SET sa_project = ? WHERE install_id = ?")
          .run(saKey.project_id, row.install_id);
      }
    } catch (_) { /* SA key not present or unreadable */ }
  }
  // Propagate: if any install in the same gcp_project has a known sa_project, apply to others
  db.exec(`
    UPDATE installs
    SET sa_project = (
      SELECT sa_project FROM installs i2
      WHERE i2.gcp_project = installs.gcp_project AND i2.sa_project IS NOT NULL
      LIMIT 1
    )
    WHERE sa_project IS NULL AND gcp_project IS NOT NULL
  `);
}

function createInstall({ installId, sessionId, clusterName, baseDomain, gcpRegion, gcpProject, saProject, installYaml, installDir }) {
  db.prepare(`
    INSERT INTO installs (install_id, session_id, cluster_name, base_domain, gcp_region, gcp_project, sa_project, install_yaml, status, started_at, install_dir)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
  `).run(installId, sessionId, clusterName, baseDomain, gcpRegion, gcpProject, saProject || null, installYaml || null, Date.now(), installDir);
}

function setInstallStatus(installId, status, exitCode = null) {
  db.prepare(`
    UPDATE installs SET status = ?, finished_at = ?, exit_code = ? WHERE install_id = ?
  `).run(status, Date.now(), exitCode, installId);
}

function setInstallRunning(installId) {
  db.prepare(`UPDATE installs SET status = 'running', started_at = ? WHERE install_id = ?`).run(Date.now(), installId);
}

function getInstall(installId) {
  return db.prepare('SELECT * FROM installs WHERE install_id = ?').get(installId);
}

function getActiveInstall(sessionId) {
  return db.prepare(`
    SELECT * FROM installs WHERE session_id = ? AND status IN ('pending', 'running')
    ORDER BY started_at DESC LIMIT 1
  `).get(sessionId);
}

function getLastInstall(sessionId) {
  return db.prepare(`
    SELECT * FROM installs WHERE session_id = ? ORDER BY started_at DESC LIMIT 1
  `).get(sessionId);
}

function getRunningInstalls() {
  return db.prepare(`SELECT * FROM installs WHERE status = 'running'`).all();
}

function getServerRestartFailed() {
  return db.prepare(`SELECT * FROM installs WHERE status = 'failed' AND exit_code = -1`).all();
}

function getDestroyedInstallsByProject(saProject) {
  return db.prepare(`
    SELECT * FROM installs
    WHERE sa_project = ? AND destroyed_at IS NOT NULL
    ORDER BY destroyed_at DESC
  `).all(saProject);
}

function getInstallsByProject(saProject) {
  return db.prepare(`
    SELECT * FROM installs
    WHERE sa_project = ? AND status IN ('complete', 'failed') AND destroyed_at IS NULL
    ORDER BY finished_at DESC
  `).all(saProject);
}

function getLatestCompleteByProject(saProject) {
  return db.prepare(`
    SELECT * FROM installs
    WHERE sa_project = ? AND status = 'complete' AND destroyed_at IS NULL
    ORDER BY finished_at DESC LIMIT 1
  `).get(saProject);
}

function markDestroyed(installId) {
  db.prepare(`UPDATE installs SET destroyed_at = ? WHERE install_id = ?`)
    .run(Date.now(), installId);
}

function appendLog({ installId, lineNumber, level, message, raw, stage, ts }) {
  db.prepare(`
    INSERT INTO install_logs (install_id, line_number, level, message, raw, stage, ts)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(installId, lineNumber, level || 'info', message, raw, stage || null, ts || Date.now());
}

function getLogs(installId, fromLine = 0) {
  return db.prepare(`
    SELECT * FROM install_logs WHERE install_id = ? AND line_number >= ?
    ORDER BY line_number ASC
  `).all(installId, fromLine);
}

function getLogCount(installId) {
  const row = db.prepare('SELECT COUNT(*) as cnt FROM install_logs WHERE install_id = ?').get(installId);
  return row ? row.cnt : 0;
}

function upsertClusterStatus({ installId, apiUrl, consoleUrl, nodeCount, nodesReady, rawJson }) {
  db.prepare(`
    INSERT INTO cluster_status (install_id, checked_at, api_url, console_url, node_count, nodes_ready, raw_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(installId, Date.now(), apiUrl, consoleUrl, nodeCount, nodesReady, JSON.stringify(rawJson));
}

function getClusterStatus(installId) {
  return db.prepare(`
    SELECT * FROM cluster_status WHERE install_id = ? ORDER BY checked_at DESC LIMIT 1
  `).get(installId);
}

module.exports = {
  initialize,
  createInstall,
  setInstallStatus,
  setInstallRunning,
  getInstall,
  getActiveInstall,
  getLastInstall,
  getRunningInstalls,
  getServerRestartFailed,
  getDestroyedInstallsByProject,
  getInstallsByProject,
  getLatestCompleteByProject,
  markDestroyed,
  appendLog,
  getLogs,
  getLogCount,
  upsertClusterStatus,
  getClusterStatus,
};
