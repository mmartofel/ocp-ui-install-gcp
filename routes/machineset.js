'use strict';

const express            = require('express');
const router             = express.Router();
const path               = require('path');
const k8s                = require('@kubernetes/client-node');
const { GoogleAuth }     = require('google-auth-library');
const { google }         = require('googleapis');
const stateStore         = require('../lib/stateStore');
const machinesetProcess  = require('../lib/machinesetProcess');
const credentialStore    = require('../lib/credentialStore');

const MACHINESET_GROUP     = 'machine.openshift.io';
const MACHINESET_VERSION   = 'v1beta1';
const MACHINESET_PLURAL    = 'machinesets';
const MACHINESET_NAMESPACE = 'openshift-machine-api';

const ALLOWED_GPU_TYPES = new Set([
  // NVIDIA L4
  'g2-standard-4',
  'g2-standard-8',
  'g2-standard-12',
  'g2-standard-16',
  'g2-standard-24',
  'g2-standard-32',
  'g2-standard-48',
  'g2-standard-96',
  // NVIDIA A100
  'a2-highgpu-1g',
  'a2-highgpu-2g',
  'a2-highgpu-4g',
]);

const MACHINESET_NAME_RE = /^[a-z0-9][a-z0-9-]{1,51}[a-z0-9]$/;

function requireAuth(req, res, next) {
  if (!credentialStore.has(req.session.id)) {
    if (req.method === 'GET') return res.redirect('/auth?warning=session_expired');
    return res.status(401).json({ error: 'session_expired' });
  }
  next();
}

function canAccess(req, install) {
  const projectId    = credentialStore.getProjectId(req.session.id);
  const installOwner = install.sa_project || install.gcp_project;
  return installOwner === projectId;
}

function makeCustomApi(installDir) {
  const kubeconfigPath = path.join(installDir, 'auth', 'kubeconfig');
  const kc = new k8s.KubeConfig();
  kc.loadFromFile(kubeconfigPath);
  return kc.makeApiClient(k8s.CustomObjectsApi);
}

// GET /machineset/:installId — progress page
router.get('/:installId', requireAuth, (req, res) => {
  const { installId } = req.params;
  const install = stateStore.getInstall(installId);

  if (!install)                return res.redirect('/status');
  if (!canAccess(req, install)) return res.redirect('/status');

  res.render('machineset', {
    installId,
    install,
    machineSetName: req.query.msName || '',
  });
});

// POST /machineset/:installId/start — begin GPU MachineSet creation
router.post('/:installId/start', requireAuth, (req, res) => {
  const { installId } = req.params;
  const install = stateStore.getInstall(installId);

  if (!install)
    return res.status(404).json({ error: 'Nie znaleziono instalacji.' });
  if (!canAccess(req, install))
    return res.status(403).json({ error: 'Brak dostępu do tego klastra.' });
  if (install.status !== 'complete')
    return res.status(400).json({ error: 'Klaster musi być w stanie complete.' });
  if (machinesetProcess.isRunning(installId))
    return res.status(400).json({ error: 'Tworzenie MachineSet jest już w toku.' });
  if (!install.install_dir)
    return res.status(400).json({ error: 'Brak katalogu instalacji (install_dir).' });

  const { machineSetName, machineType, zone, replicas: rawReplicas } = req.body;

  if (!machineSetName || !MACHINESET_NAME_RE.test(machineSetName)) {
    return res.status(400).json({
      error: 'Nieprawidłowa nazwa MachineSet. Użyj małych liter, cyfr i myślników (min. 3 znaki).',
    });
  }

  if (!machineType || !ALLOWED_GPU_TYPES.has(machineType)) {
    return res.status(400).json({ error: 'Nieprawidłowy typ instancji GPU.' });
  }

  if (!zone || typeof zone !== 'string' || zone.trim().length === 0) {
    return res.status(400).json({ error: 'Wybierz strefę (zone) dla MachineSet.' });
  }

  const replicas = parseInt(rawReplicas, 10);
  if (isNaN(replicas) || replicas < 0 || replicas > 10) {
    return res.status(400).json({ error: 'Liczba replik musi być liczbą całkowitą od 0 do 10.' });
  }

  const io = req.app.get('io');
  machinesetProcess.start(installId, install.install_dir, { machineSetName, machineType, zone: zone.trim(), replicas }, io);

  res.json({ ok: true });
});

// GET /machineset/:installId/status — current job status
router.get('/:installId/status', requireAuth, (req, res) => {
  const { installId } = req.params;
  const install = stateStore.getInstall(installId);

  if (!install)
    return res.status(404).json({ error: 'Nie znaleziono instalacji.' });
  if (!canAccess(req, install))
    return res.status(403).json({ error: 'Brak dostępu do tego klastra.' });

  res.json({
    gpuMachinesetCreatedAt: install.gpu_machineset_created_at || null,
    isRunning:              machinesetProcess.isRunning(installId),
  });
});

// GET /machineset/:installId/list — live list of all MachineSets
router.get('/:installId/list', requireAuth, async (req, res) => {
  const { installId } = req.params;
  const install = stateStore.getInstall(installId);

  if (!install)                return res.status(404).json({ error: 'Nie znaleziono instalacji.' });
  if (!canAccess(req, install)) return res.status(403).json({ error: 'Brak dostępu do tego klastra.' });
  if (!install.install_dir)    return res.json({ machineSets: [], error: 'Brak katalogu instalacji.' });

  try {
    const customApi = makeCustomApi(install.install_dir);
    const result = await customApi.listNamespacedCustomObject({
      group:     MACHINESET_GROUP,
      version:   MACHINESET_VERSION,
      namespace: MACHINESET_NAMESPACE,
      plural:    MACHINESET_PLURAL,
    });

    const machineSets = (result.items || []).map(ms => {
      const name           = ms.metadata?.name || '';
      const replicas       = ms.spec?.replicas ?? 0;
      const readyReplicas  = ms.status?.readyReplicas ?? 0;
      const providerSpec   = ms.spec?.template?.spec?.providerSpec?.value || {};
      const instanceType   = providerSpec.machineType || '';
      const zone           = providerSpec.zone || '';
      const templateLabels = ms.spec?.template?.spec?.metadata?.labels || {};
      const isGpu          = name.toLowerCase().includes('-gpu') || templateLabels['GPU'] === 'YES';

      return { name, replicas, readyReplicas, instanceType, zone, isGpu };
    });

    res.json({ machineSets });
  } catch (err) {
    console.error(`[machineset/list] Error for ${installId}:`, err.message);
    res.json({ machineSets: [], error: 'Klaster niedostępny.' });
  }
});

// POST /machineset/:installId/scale — patch replicas on a MachineSet
router.post('/:installId/scale', requireAuth, async (req, res) => {
  const { installId } = req.params;
  const install = stateStore.getInstall(installId);

  if (!install)                return res.status(404).json({ error: 'Nie znaleziono instalacji.' });
  if (!canAccess(req, install)) return res.status(403).json({ error: 'Brak dostępu do tego klastra.' });
  if (!install.install_dir)    return res.status(400).json({ error: 'Brak katalogu instalacji.' });

  const { name, replicas: rawReplicas } = req.body;

  if (!name || typeof name !== 'string' || name.length === 0) {
    return res.status(400).json({ error: 'Brak nazwy MachineSet.' });
  }

  const replicas = parseInt(rawReplicas, 10);
  if (isNaN(replicas) || replicas < 0 || replicas > 99) {
    return res.status(400).json({ error: 'Nieprawidłowa liczba replik (0–99).' });
  }

  try {
    const customApi = makeCustomApi(install.install_dir);
    // Use JSON Patch (RFC 6902) format — the client library prefers application/json-patch+json
    await customApi.patchNamespacedCustomObject({
      group:     MACHINESET_GROUP,
      version:   MACHINESET_VERSION,
      namespace: MACHINESET_NAMESPACE,
      plural:    MACHINESET_PLURAL,
      name,
      body:      [{ op: 'replace', path: '/spec/replicas', value: replicas }],
    });
    res.json({ ok: true });
  } catch (err) {
    console.error(`[machineset/scale] Error for ${installId}:`, err.message);
    res.status(500).json({ error: `Błąd skalowania: ${err.message}` });
  }
});

// POST /machineset/:installId/delete — delete a MachineSet (only when scaled to 0)
router.post('/:installId/delete', requireAuth, async (req, res) => {
  const { installId } = req.params;
  const install = stateStore.getInstall(installId);

  if (!install)                return res.status(404).json({ error: 'Nie znaleziono instalacji.' });
  if (!canAccess(req, install)) return res.status(403).json({ error: 'Brak dostępu do tego klastra.' });
  if (!install.install_dir)    return res.status(400).json({ error: 'Brak katalogu instalacji.' });

  const { name } = req.body;
  if (!name || typeof name !== 'string' || name.length === 0) {
    return res.status(400).json({ error: 'Brak nazwy MachineSet.' });
  }

  try {
    const customApi = makeCustomApi(install.install_dir);

    // Fetch current state and verify replicas are 0 before deleting
    const ms = await customApi.getNamespacedCustomObject({
      group:     MACHINESET_GROUP,
      version:   MACHINESET_VERSION,
      namespace: MACHINESET_NAMESPACE,
      plural:    MACHINESET_PLURAL,
      name,
    });

    const specReplicas   = ms.spec?.replicas   ?? 0;
    const statusReplicas = ms.status?.replicas  ?? 0;

    if (specReplicas !== 0) {
      return res.status(400).json({
        error: `MachineSet ma ustawione ${specReplicas} replik. Skaluj do 0 przed usunięciem.`,
      });
    }
    if (statusReplicas !== 0) {
      return res.status(400).json({
        error: `MachineSet wciąż ma ${statusReplicas} aktywnych maszyn. Poczekaj na ich usunięcie.`,
      });
    }

    await customApi.deleteNamespacedCustomObject({
      group:     MACHINESET_GROUP,
      version:   MACHINESET_VERSION,
      namespace: MACHINESET_NAMESPACE,
      plural:    MACHINESET_PLURAL,
      name,
    });

    res.json({ ok: true });
  } catch (err) {
    console.error(`[machineset/delete] Error for ${installId}:`, err.message);
    res.status(500).json({ error: `Błąd usuwania: ${err.message}` });
  }
});

// GET /machineset/:installId/available-types?zone= — GPU types available in a specific zone
router.get('/:installId/available-types', requireAuth, async (req, res) => {
  const { installId } = req.params;
  const { zone }      = req.query;

  if (!zone || typeof zone !== 'string' || !zone.trim()) {
    return res.status(400).json({ error: 'Brak parametru zone.' });
  }

  const install = stateStore.getInstall(installId);
  if (!install)                return res.status(404).json({ error: 'Nie znaleziono instalacji.' });
  if (!canAccess(req, install)) return res.status(403).json({ error: 'Brak dostępu.' });

  const credentials = credentialStore.getCredentials(req.session.id);
  if (!credentials) return res.status(401).json({ error: 'session_expired' });

  const projectId = credentialStore.getProjectId(req.session.id);

  try {
    const auth = new GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    });
    const client  = await auth.getClient();
    const compute = google.compute({ version: 'v1', auth: client });

    const resp = await compute.machineTypes.list({ project: projectId, zone: zone.trim() });
    const names = new Set((resp.data.items || []).map(m => m.name));

    const availableTypes = [...ALLOWED_GPU_TYPES].filter(t => names.has(t));
    res.json({ availableTypes });
  } catch (err) {
    console.error(`[machineset/available-types] Error for ${installId}:`, err.message);
    // On API error fall back to full list — safer than blocking the user
    res.json({ availableTypes: [...ALLOWED_GPU_TYPES] });
  }
});

module.exports = router;
