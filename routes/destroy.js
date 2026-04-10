'use strict';

const express = require('express');
const router  = express.Router();
const path    = require('path');
const fs      = require('fs');

const credentialStore = require('../lib/credentialStore');
const stateStore      = require('../lib/stateStore');
const destroyProcess  = require('../lib/destroyProcess');

const INSTALLER_PATH = path.resolve(
  process.env.INSTALLER_PATH || path.join(__dirname, '..', 'data', 'installer', 'openshift-install')
);

function requireAuth(req, res, next) {
  if (!credentialStore.has(req.session.id)) {
    return res.redirect('/auth?warning=session_expired');
  }
  next();
}

function requireAuthApi(req, res, next) {
  if (!credentialStore.has(req.session.id)) {
    return res.status(401).json({ error: 'session_expired' });
  }
  next();
}

// GET /destroy/:installId  — show destroy log page
router.get('/:installId', requireAuth, (req, res) => {
  const { installId } = req.params;
  const install = stateStore.getInstall(installId);

  if (!install) return res.redirect('/status');

  const projectId    = credentialStore.getProjectId(req.session.id);
  const installOwner = install.sa_project || install.gcp_project;
  if (installOwner !== projectId) return res.redirect('/status');

  res.render('destroy', {
    title:     'Usuwanie klastra',
    install,
    installId,
    isRunning: destroyProcess.isRunning(installId),
  });
});

// POST /destroy/:installId  — start destroy process
router.post('/:installId', requireAuthApi, (req, res) => {
  const { installId } = req.params;
  const install = stateStore.getInstall(installId);

  if (!install) {
    return res.status(404).json({ error: 'Nie znaleziono instalacji.' });
  }

  const projectId    = credentialStore.getProjectId(req.session.id);
  const installOwner = install.sa_project || install.gcp_project;
  if (installOwner !== projectId) {
    return res.status(403).json({ error: 'Brak dostępu do tego klastra.' });
  }

  if (install.status !== 'complete' && install.status !== 'failed') {
    return res.status(400).json({ error: 'Klaster nie jest w stanie umożliwiającym usunięcie.' });
  }

  if (install.destroyed_at) {
    return res.status(400).json({ error: 'Klaster został już usunięty.' });
  }

  if (destroyProcess.isRunning(installId)) {
    return res.status(409).json({ error: 'Usuwanie już w toku.', redirect: `/destroy/${installId}` });
  }

  const installDir = install.install_dir;
  const dirExists  = installDir && fs.existsSync(installDir);

  if (!dirExists) {
    // Install dir missing — GCP resources may already be gone or were never created.
    // Require explicit force flag before wiping the DB record.
    if (req.query.force !== 'true') {
      return res.status(422).json({
        needsForce: true,
        message: 'Katalog instalacji nie istnieje — zasoby GCP mogą wymagać ręcznego usunięcia ' +
                 '(np. poleceniem openshift-install destroy cluster). ' +
                 'Czy mimo to usunąć klaster z interfejsu?',
      });
    }
    // Force: remove only from DB
    stateStore.markDestroyed(installId);
    return res.json({ success: true, redirect: '/status' });
  }

  const credentials = credentialStore.getCredentials(req.session.id);
  const io = req.app.get('io');

  destroyProcess.start(
    { installId, installDir, installerPath: INSTALLER_PATH, credentials },
    io
  );

  return res.json({ success: true, redirect: `/destroy/${installId}` });
});

module.exports = router;
