'use strict';

const express  = require('express');
const router   = express.Router();
const fs       = require('fs');
const path     = require('path');
const { v4: uuidv4 } = require('uuid');

const credentialStore     = require('../lib/credentialStore');
const stateStore          = require('../lib/stateStore');
const installerProcess    = require('../lib/installerProcess');
const installConfigBuilder= require('../lib/installConfigBuilder');

const INSTALLER_PATH = path.resolve(
  process.env.INSTALLER_PATH || path.join(__dirname, '..', 'data', 'installer', 'openshift-install')
);

const TMP_DIR = path.join(__dirname, '..', 'tmp');

function requireAuth(req, res, next) {
  if (!credentialStore.has(req.session.id)) {
    return res.redirect('/auth?warning=session_expired');
  }
  next();
}

function requireConfig(req, res, next) {
  if (!req.session.installConfig) {
    return res.redirect('/config');
  }
  next();
}

// GET /install
router.get('/', requireAuth, (req, res) => {
  let install = req.session.installId
    ? stateStore.getInstall(req.session.installId)
    : null;

  // If the referenced install was destroyed, clear session and show idle state
  if (install && install.destroyed_at) {
    req.session.installId = null;
    install = null;
  }

  res.render('install', {
    title:     'Instalacja OpenShift',
    install,
    installId: install ? install.install_id : null,
  });
});

// POST /install/start
router.post('/start', requireAuth, requireConfig, (req, res) => {
  // Check for existing running install
  if (req.session.installId) {
    const existing = stateStore.getInstall(req.session.installId);
    if (existing && existing.status === 'running') {
      return res.status(409).json({ error: 'Instalacja jest już uruchomiona.' });
    }
  }

  const config     = req.session.installConfig;
  const credentials= credentialStore.getCredentials(req.session.id);
  const saProject  = credentials ? credentials.project_id : null;
  const installId  = uuidv4();
  const installDir = path.join(TMP_DIR, `install-${installId}`);

  // Create isolated install directory (mode 700)
  fs.mkdirSync(installDir, { recursive: true, mode: 0o700 });

  // Write install-config.yaml
  const yamlContent = installConfigBuilder.build(config);
  fs.writeFileSync(
    path.join(installDir, 'install-config.yaml'),
    yamlContent,
    { mode: 0o600 }
  );

  // Build scrubbed YAML for DB storage (pull secret and SSH key never stored to SQLite)
  const { pullSecret, sshKey, ...safeConfig } = config;
  const installYaml = installConfigBuilder.build({
    ...safeConfig,
    pullSecret: '# <UZUPEŁNIJ: pull secret z console.redhat.com/openshift/install/pull-secret>',
    sshKey:     '# <UZUPEŁNIJ: klucz publiczny SSH>',
  });

  // Persist install record
  stateStore.createInstall({
    installId,
    sessionId:   req.session.id,
    clusterName: config.clusterName,
    baseDomain:  config.baseDomain,
    gcpRegion:   config.region,
    gcpProject:  config.gcpProject,
    saProject,
    installYaml,
    installDir,
  });

  req.session.installId  = installId;
  req.session.installDir = installDir;

  // Start the process
  const io = req.app.get('io');
  installerProcess.start(
    { installId, installDir, installerPath: INSTALLER_PATH, credentials },
    io
  );

  return res.json({ success: true, installId, redirect: '/install' });
});

// POST /install/abort
router.post('/abort', requireAuth, (req, res) => {
  const installId = req.session.installId;
  if (!installId) {
    return res.status(404).json({ error: 'Brak aktywnej instalacji.' });
  }

  const aborted = installerProcess.abort(installId);
  if (!aborted) {
    return res.status(404).json({ error: 'Instalacja nie jest uruchomiona.' });
  }

  return res.json({
    success: true,
    warning: 'Instalacja została przerwana. Zasoby GCP mogą wymagać ręcznego usunięcia poleceniem: openshift-install destroy cluster',
  });
});

// GET /install/status  - polling fallback (Socket.io preferred)
router.get('/status', requireAuth, (req, res) => {
  const installId = req.session.installId;
  if (!installId) {
    return res.json({ status: 'idle' });
  }
  const install = stateStore.getInstall(installId);
  return res.json(install || { status: 'idle' });
});

module.exports = router;
