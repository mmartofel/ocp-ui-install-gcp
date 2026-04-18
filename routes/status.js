'use strict';

const express = require('express');
const router  = express.Router();
const path    = require('path');
const fs      = require('fs');
const https   = require('https');
const multer  = require('multer');
const yaml    = require('js-yaml');

const credentialStore     = require('../lib/credentialStore');
const stateStore          = require('../lib/stateStore');
const clusterStatusPoller = require('../lib/clusterStatusPoller');

const kubeconfigUpload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 512 * 1024, files: 1 },
});

// TLS error codes that indicate a cert-chain trust failure (not a connection error)
const CERT_CHAIN_ERRORS = new Set([
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'CERT_UNTRUSTED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
]);

/**
 * Fetch an OAuth bearer token from the OpenShift OAuth server using the
 * Resource Owner Password Credentials grant.
 *
 * Tries with system CA first; if the OAuth endpoint's cert is not yet trusted
 * (e.g. mid-rotation or still self-signed) it retries with rejectUnauthorized:false.
 */
/**
 * Fetch an OAuth bearer token from OpenShift using the implicit grant flow —
 * the same mechanism used by `oc login`.
 *
 * Flow:
 *   GET /oauth/authorize?response_type=token&client_id=openshift-challenging-client
 *   Authorization: Basic base64(kubeadmin:<password>)
 *   X-CSRF-Token: 1
 *
 * OpenShift responds with 302; the Location header fragment contains the token:
 *   https://localhost/callback#access_token=sha256~...&expires_in=86400&...
 *
 * Note: Node.js https.request does NOT follow redirects, so we read the 302
 * Location header directly without any further HTTP call.
 */
function fetchOAuthToken(clusterName, baseDomain, password) {
  const baseUrl   = `https://oauth-openshift.apps.${clusterName}.${baseDomain}/oauth/authorize`;
  const query     = new URLSearchParams({
    response_type: 'token',
    client_id:     'openshift-challenging-client',
  }).toString();
  const userCreds = Buffer.from(`kubeadmin:${password}`).toString('base64');

  function attempt(rejectUnauthorized) {
    return new Promise((resolve, reject) => {
      const agent = new https.Agent({ rejectUnauthorized });
      const url   = new URL(baseUrl);
      const opts  = {
        hostname: url.hostname,
        port:     url.port || 443,
        path:     `${url.pathname}?${query}`,
        method:   'GET',
        agent,
        headers: {
          'Authorization': `Basic ${userCreds}`,
          'X-CSRF-Token':  '1',
        },
      };

      const req = https.request(opts, (resp) => {
        // Drain body regardless to avoid socket hang
        resp.resume();

        if (resp.statusCode === 401) {
          return reject(new Error('Nieprawidłowe hasło kubeadmin (HTTP 401)'));
        }

        if (resp.statusCode === 302 || resp.statusCode === 301) {
          const location = resp.headers['location'] || '';
          // Token is in the URL fragment: #access_token=sha256~...&...
          const hashIdx = location.indexOf('#');
          if (hashIdx === -1) {
            return reject(new Error('Brak fragmentu tokenu w odpowiedzi OAuth (Location bez #)'));
          }
          const fragment = new URLSearchParams(location.slice(hashIdx + 1));
          const token    = fragment.get('access_token');
          if (!token) {
            return reject(new Error('Brak access_token w odpowiedzi OAuth'));
          }
          return resolve(token);
        }

        reject(new Error(`Nieoczekiwana odpowiedź serwera OAuth (HTTP ${resp.statusCode})`));
      });

      req.on('error', (err) => reject(err));
      req.end();
    });
  }

  return attempt(true).catch(err => {
    if (CERT_CHAIN_ERRORS.has(err.code)) {
      return attempt(false);
    }
    throw err;
  });
}

/**
 * Build a minimal kubeconfig object that authenticates via bearer token.
 * insecure-skip-tls-verify is set because after Let's Encrypt rotation the API
 * server certificate may cover only *.apps.* and the base domain (not api.*),
 * causing hostname verification to fail despite the connection being encrypted.
 */
function buildTokenKubeconfig(clusterName, baseDomain, token) {
  return {
    apiVersion:       'v1',
    kind:             'Config',
    preferences:      {},
    'current-context': clusterName,
    clusters: [{
      name:    clusterName,
      cluster: {
        server:                   `https://api.${clusterName}.${baseDomain}:6443`,
        'insecure-skip-tls-verify': true,
      },
    }],
    contexts: [{
      name:    clusterName,
      context: { cluster: clusterName, user: 'kubeadmin', namespace: 'default' },
    }],
    users: [{
      name: 'kubeadmin',
      user: { token },
    }],
  };
}

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

// POST /status/regenerate-kubeconfig — fetch a fresh OAuth token and write a new kubeconfig
router.post('/regenerate-kubeconfig', requireAuthApi, async (req, res) => {
  const installId = req.query.cluster || req.session.installId;
  const install   = installId ? stateStore.getInstall(installId) : null;
  if (!install || !install.install_dir) {
    return res.status(404).json({ error: 'Nie znaleziono klastra' });
  }

  // 1. Read kubeadmin password from disk
  const passPath = path.join(install.install_dir, 'auth', 'kubeadmin-password');
  if (!fs.existsSync(passPath)) {
    return res.status(422).json({ error: 'Brak pliku kubeadmin-password — nie można wygenerować kubeconfig' });
  }
  const password = fs.readFileSync(passPath, 'utf8').trim();

  // 2. Exchange credentials for an OAuth token
  let token;
  try {
    token = await fetchOAuthToken(install.cluster_name, install.base_domain, password);
  } catch (err) {
    return res.status(502).json({ error: `Błąd uwierzytelniania OAuth: ${err.message}` });
  }

  // 3. Build token-based kubeconfig (no embedded CA)
  const configObj  = buildTokenKubeconfig(install.cluster_name, install.base_domain, token);
  const configYaml = yaml.dump(configObj, { lineWidth: -1 });

  // 4. Write to disk (0600)
  const kubeconfigPath = path.join(install.install_dir, 'auth', 'kubeconfig');
  try {
    fs.mkdirSync(path.dirname(kubeconfigPath), { recursive: true });
    fs.writeFileSync(kubeconfigPath, configYaml, { encoding: 'utf8', mode: 0o600 });
  } catch (err) {
    return res.status(500).json({ error: `Nie można zapisać kubeconfig: ${err.message}` });
  }

  // 5. Restart poller so it picks up the new token immediately
  clusterStatusPoller.stopPolling(installId);
  clusterStatusPoller.startPolling(installId, install.install_dir);

  return res.json({ success: true });
});

// POST /status/kubeconfig — replace kubeconfig after certificate rotation
router.post('/kubeconfig', requireAuthApi, kubeconfigUpload.single('kubeconfig'), (req, res) => {
  const installId = req.query.cluster || req.session.installId;
  if (!installId) return res.status(400).json({ error: 'Brak klastra' });

  const install = stateStore.getInstall(installId);
  if (!install || !install.install_dir) {
    return res.status(404).json({ error: 'Nie znaleziono klastra' });
  }

  // Accept multipart file upload or JSON body field
  let content;
  if (req.file) {
    content = req.file.buffer.toString('utf8');
  } else if (typeof req.body?.kubeconfig === 'string') {
    content = req.body.kubeconfig;
  } else {
    return res.status(400).json({ error: 'Brak pliku kubeconfig' });
  }

  // Validate YAML structure
  let parsed;
  try {
    parsed = yaml.load(content);
  } catch (e) {
    return res.status(400).json({ error: `Nieprawidłowy format YAML: ${e.message}` });
  }

  if (!parsed || parsed.kind !== 'Config' || !Array.isArray(parsed.clusters)) {
    return res.status(400).json({ error: 'Plik nie wygląda jak prawidłowy kubeconfig (oczekiwano kind: Config z tablicą clusters)' });
  }

  const kubeconfigPath = path.join(install.install_dir, 'auth', 'kubeconfig');
  try {
    fs.mkdirSync(path.dirname(kubeconfigPath), { recursive: true });
    fs.writeFileSync(kubeconfigPath, content, { encoding: 'utf8', mode: 0o600 });
  } catch (err) {
    return res.status(500).json({ error: `Nie można zapisać kubeconfig: ${err.message}` });
  }

  // Restart poller so it picks up the new credentials immediately
  clusterStatusPoller.stopPolling(installId);
  clusterStatusPoller.startPolling(installId, install.install_dir);

  return res.json({ success: true });
});

module.exports = router;
