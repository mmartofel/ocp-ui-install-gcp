'use strict';

// In-memory store - credentials never persisted to disk beyond the SA key tempfile
// used during install. Map is process-lifetime only (cleared on restart).
const store = new Map(); // sessionId -> { credentials, projectId, clientEmail, expiresAt, timer }

const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

function set(sessionId, credentialsObj) {
  // Clear existing entry if any
  remove(sessionId);

  const timer = setTimeout(() => {
    store.delete(sessionId);
  }, TTL_MS);

  store.set(sessionId, {
    credentials: credentialsObj,
    projectId: credentialsObj.project_id,
    clientEmail: credentialsObj.client_email,
    expiresAt: Date.now() + TTL_MS,
    timer,
  });
}

function get(sessionId) {
  const entry = store.get(sessionId);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    remove(sessionId);
    return null;
  }
  return entry;
}

function getCredentials(sessionId) {
  const entry = get(sessionId);
  return entry ? entry.credentials : null;
}

function getProjectId(sessionId) {
  const entry = get(sessionId);
  return entry ? entry.projectId : null;
}

function remove(sessionId) {
  const entry = store.get(sessionId);
  if (entry && entry.timer) {
    clearTimeout(entry.timer);
  }
  store.delete(sessionId);
}

function has(sessionId) {
  return get(sessionId) !== null;
}

module.exports = { set, get, getCredentials, getProjectId, remove, has };
