'use strict';

const express = require('express');
const router  = express.Router();
const path    = require('path');
const fs      = require('fs');

const credentialStore     = require('../lib/credentialStore');
const stateStore          = require('../lib/stateStore');
const clusterStatusPoller = require('../lib/clusterStatusPoller');

function requireAuth(req, res, next) {
  if (!credentialStore.has(req.session.id)) {
    return res.redirect('/auth?warning=session_expired');
  }
  next();
}

// For AJAX/fetch routes — return JSON 401 instead of HTML redirect
function requireAuthApi(req, res, next) {
  if (!credentialStore.has(req.session.id)) {
    return res.status(401).json({ error: 'session_expired' });
  }
  next();
}

// GET /status
router.get('/', requireAuth, (req, res) => {
  const projectId       = credentialStore.getProjectId(req.session.id);
  const installs        = stateStore.getInstallsByProject(projectId);
  const destroyedInstalls = stateStore.getDestroyedInstallsByProject(projectId);

  // Determine which cluster's details to show
  const requestedId = req.query.cluster;
  let selectedInstall = null;

  if (requestedId) {
    selectedInstall = installs.find(i => i.install_id === requestedId) || null;
  }
  if (!selectedInstall && req.session.installId) {
    selectedInstall = installs.find(i => i.install_id === req.session.installId) || null;
  }
  if (!selectedInstall && installs.length > 0) {
    selectedInstall = installs[0];
  }

  if (selectedInstall) {
    req.session.installId = selectedInstall.install_id;
    // Start polling for this cluster if not already running
    if (selectedInstall.install_dir) {
      clusterStatusPoller.startPolling(selectedInstall.install_id, selectedInstall.install_dir);
    }
  }

  res.render('status', {
    title:   'Status klastra',
    installs,
    destroyedInstalls,
    install: selectedInstall,
    installId: selectedInstall?.install_id || null,
  });
});

// GET /status/api  - JSON endpoint for polling (used by status.js client)
router.get('/api', requireAuthApi, async (req, res) => {
  const installId = req.query.cluster || req.session.installId;
  if (!installId) return res.json({ error: 'Brak klastra' });

  const install = stateStore.getInstall(installId);
  if (!install) return res.json({ error: 'Nie znaleziono klastra' });

  const clusterStatus = stateStore.getClusterStatus(installId);

  const kubeconfigPath = install.install_dir
    ? path.join(install.install_dir, 'auth', 'kubeconfig')
    : null;
  const kubeconfigExists = kubeconfigPath && fs.existsSync(kubeconfigPath);

  let kubeadminPassword = null;
  try {
    const passPath = path.join(install.install_dir, 'auth', 'kubeadmin-password');
    if (fs.existsSync(passPath)) {
      kubeadminPassword = fs.readFileSync(passPath, 'utf8').trim();
    }
  } catch (_) {}

  return res.json({
    install,
    clusterStatus: clusterStatus ? JSON.parse(clusterStatus.raw_json || '{}') : null,
    kubeconfigExists,
    kubeadminPassword,
    consoleUrl: `https://console-openshift-console.apps.${install.cluster_name}.${install.base_domain}`,
    apiUrl:     `https://api.${install.cluster_name}.${install.base_domain}:6443`,
  });
});

// POST /status/refresh  - force immediate status poll
router.post('/refresh', requireAuthApi, async (req, res) => {
  const installId = req.query.cluster || req.session.installId;
  const install   = installId ? stateStore.getInstall(installId) : null;

  if (!install || !install.install_dir) {
    return res.status(404).json({ error: 'Brak klastra' });
  }

  const kubeconfigPath = path.join(install.install_dir, 'auth', 'kubeconfig');
  try {
    const status = await clusterStatusPoller.fetchClusterStatus(kubeconfigPath, installId);
    stateStore.upsertClusterStatus({
      installId,
      apiUrl:     status.apiUrl,
      consoleUrl: status.consoleUrl,
      nodeCount:  status.nodes.length,
      nodesReady: status.nodes.filter(n => n.ready).length,
      rawJson:    status,
    });
    return res.json({ success: true, status });
  } catch (err) {
    return res.status(500).json({ error: `Błąd połączenia z klastrem: ${err.message}` });
  }
});

// POST /status/reconcile — live health check; marks install 'complete' if all platform operators healthy
router.post('/reconcile', requireAuthApi, async (req, res) => {
  const installId = req.query.cluster || req.session.installId;
  if (!installId) return res.status(400).json({ error: 'Brak klastra' });

  const install = stateStore.getInstall(installId);
  if (!install) return res.status(404).json({ error: 'Nie znaleziono klastra' });

  if (install.status === 'complete') {
    return res.json({ success: true, already: true });
  }

  const kubeconfigPath = install.install_dir
    ? path.join(install.install_dir, 'auth', 'kubeconfig')
    : null;

  if (!kubeconfigPath || !fs.existsSync(kubeconfigPath)) {
    return res.status(422).json({ error: 'Brak pliku kubeconfig — klaster nie uruchomił się poprawnie.' });
  }

  try {
    const status = await clusterStatusPoller.fetchClusterStatus(kubeconfigPath, installId);

    // Persist fresh cluster status snapshot
    stateStore.upsertClusterStatus({
      installId,
      apiUrl:     status.apiUrl,
      consoleUrl: status.consoleUrl,
      nodeCount:  status.nodes.length,
      nodesReady: status.nodes.filter(n => n.ready).length,
      rawJson:    status,
    });

    // Health check: platform ClusterOperators only (source === 'platform')
    const platformOps = status.operators.filter(op => op.source === 'platform');
    const degradedOps = platformOps.filter(op => op.degraded || !op.available);
    const healthy = status.nodes.length > 0
      && status.nodes.every(n => n.ready)
      && platformOps.length > 0
      && degradedOps.length === 0;

    if (healthy) {
      stateStore.setInstallStatus(installId, 'complete', 0);
    }

    return res.json({
      success:           true,
      healthy,
      degradedOperators: degradedOps.map(op => op.name),
      nodeCount:         status.nodes.length,
      nodesReady:        status.nodes.filter(n => n.ready).length,
    });
  } catch (err) {
    return res.status(500).json({ error: `Błąd połączenia z klastrem: ${err.message}` });
  }
});

module.exports = router;
