'use strict';

const express         = require('express');
const router          = express.Router();
const stateStore      = require('../lib/stateStore');
const aiProcess       = require('../lib/aiProcess');
const credentialStore = require('../lib/credentialStore');

function requireAuth(req, res, next) {
  if (!credentialStore.has(req.session.id)) {
    if (req.method === 'GET') return res.redirect('/auth?warning=session_expired');
    return res.status(401).json({ error: 'session_expired' });
  }
  next();
}

// Ownership check: same pattern as routes/destroy.js — compare GCP project IDs.
// install.session_id reflects the session at install-time and changes on re-login,
// so we use the project from the active credential instead.
function canAccess(req, install) {
  const projectId    = credentialStore.getProjectId(req.session.id);
  const installOwner = install.sa_project || install.gcp_project;
  return installOwner === projectId;
}

// GET /ai/:installId — progress page
router.get('/:installId', requireAuth, (req, res) => {
  const { installId } = req.params;
  const install = stateStore.getInstall(installId);

  if (!install)               return res.redirect('/status');
  if (!canAccess(req, install)) return res.redirect('/status');

  res.render('ai', { installId, install });
});

// POST /ai/:installId/start — begin AI operator installation
router.post('/:installId/start', requireAuth, (req, res) => {
  const { installId } = req.params;
  const install = stateStore.getInstall(installId);

  if (!install)
    return res.status(404).json({ error: 'Nie znaleziono instalacji.' });
  if (!canAccess(req, install))
    return res.status(403).json({ error: 'Brak dostępu do tego klastra.' });
  if (install.status !== 'complete')
    return res.status(400).json({ error: 'Klaster musi być w stanie complete.' });
  if (install.ai_enabled_at)
    return res.status(400).json({ error: 'Klaster jest już przygotowany dla AI.' });
  if (aiProcess.isRunning(installId))
    return res.status(400).json({ error: 'Instalacja AI jest już w toku.' });
  if (!install.install_dir)
    return res.status(400).json({ error: 'Brak katalogu instalacji (install_dir).' });

  const io = req.app.get('io');
  aiProcess.start(installId, install.install_dir, io);

  res.json({ ok: true });
});

// GET /ai/:installId/status — current AI status (for polling)
router.get('/:installId/status', requireAuth, (req, res) => {
  const { installId } = req.params;
  const install = stateStore.getInstall(installId);

  if (!install)
    return res.status(404).json({ error: 'Nie znaleziono instalacji.' });
  if (!canAccess(req, install))
    return res.status(403).json({ error: 'Brak dostępu do tego klastra.' });

  res.json({
    aiEnabledAt: install.ai_enabled_at || null,
    isRunning:   aiProcess.isRunning(installId),
  });
});

module.exports = router;
