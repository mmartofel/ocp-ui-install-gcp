'use strict';

const express = require('express');
const router  = express.Router();
const path    = require('path');
const fs      = require('fs');

const credentialStore = require('../lib/credentialStore');
const stateStore      = require('../lib/stateStore');

function requireAuth(req, res, next) {
  if (!credentialStore.has(req.session.id)) {
    return res.status(401).json({ error: 'Sesja wygasła' });
  }
  next();
}

// GET /download/kubeconfig
router.get('/kubeconfig', requireAuth, (req, res) => {
  const installId  = req.session.installId;
  const install    = installId ? stateStore.getInstall(installId) : null;
  const projectId  = credentialStore.getProjectId(req.session.id);
  const installProject = install ? (install.sa_project || install.gcp_project) : null;

  if (!install || !projectId || installProject !== projectId) {
    return res.status(403).json({ error: 'Brak dostępu' });
  }

  if (install.status !== 'complete') {
    return res.status(404).json({ error: 'Instalacja nie została zakończona' });
  }

  const kubeconfigPath = path.join(install.install_dir, 'auth', 'kubeconfig');
  if (!fs.existsSync(kubeconfigPath)) {
    return res.status(404).json({ error: 'Plik kubeconfig nie istnieje' });
  }

  res.setHeader('Content-Disposition', `attachment; filename="kubeconfig-${install.cluster_name}"`);
  res.setHeader('Content-Type', 'application/octet-stream');
  res.sendFile(kubeconfigPath);
});

// GET /download/logs
router.get('/logs', requireAuth, (req, res) => {
  const installId  = req.session.installId;
  const install    = installId ? stateStore.getInstall(installId) : null;
  const projectId  = credentialStore.getProjectId(req.session.id);
  const installProject = install ? (install.sa_project || install.gcp_project) : null;

  if (!install || !projectId || installProject !== projectId) {
    return res.status(403).json({ error: 'Brak dostępu' });
  }

  const logPath = path.join(install.install_dir, '.openshift_install.log');
  if (fs.existsSync(logPath)) {
    res.setHeader('Content-Disposition', `attachment; filename="openshift-install-${install.cluster_name}.log"`);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.sendFile(logPath);
  }

  // Fall back to DB logs
  const lines = stateStore.getLogs(installId, 0);
  const content = lines.map(l => `[${new Date(l.ts).toISOString()}] ${l.level.toUpperCase()} ${l.message}`).join('\n');
  res.setHeader('Content-Disposition', `attachment; filename="openshift-install-${install.cluster_name}.log"`);
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.send(content);
});

// GET /download/install-config/:installId  — scrubbed YAML for reinstall
router.get('/install-config/:installId', requireAuth, (req, res) => {
  const install = stateStore.getInstall(req.params.installId);

  if (!install || !install.install_yaml) {
    return res.status(404).send('Brak zapisanego install-config dla tego klastra.');
  }

  const projectId    = credentialStore.getProjectId(req.session.id);
  const installOwner = install.sa_project || install.gcp_project;
  if (installOwner !== projectId) {
    return res.status(403).send('Brak dostępu.');
  }

  const filename = `install-config-${install.cluster_name}.yaml`;
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Type', 'application/yaml');
  res.send(install.install_yaml);
});

module.exports = router;
