'use strict';

const fs   = require('fs');
const path = require('path');
const k8s  = require('@kubernetes/client-node');

const stateStore = require('./stateStore');

// installId -> true (running flag)
const activeMachinesetProcesses = new Map();

const TOTAL_STEPS = 3;

const MACHINESET_GROUP     = 'machine.openshift.io';
const MACHINESET_VERSION   = 'v1beta1';
const MACHINESET_PLURAL    = 'machinesets';
const MACHINESET_NAMESPACE = 'openshift-machine-api';

// ── Helper: sleep ─────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Helper: extract HTTP status code from @kubernetes/client-node v1.x errors ─

function httpCode(err) {
  return err?.code
    || err?.response?.statusCode
    || err?.statusCode
    || (typeof err?.message === 'string'
        && Number(/HTTP-Code:\s*(\d+)/.exec(err.message)?.[1]))
    || 0;
}

// ── Helper: find worker MachineSet from list ──────────────────────────────────

function findWorkerMachineSet(items) {
  if (!items || items.length === 0) {
    throw new Error('Brak MachineSetów w klastrze. Sprawdź namespace openshift-machine-api.');
  }
  // Prefer a MachineSet whose name contains 'worker'
  const worker = items.find(ms => (ms.metadata?.name || '').toLowerCase().includes('worker'));
  return worker || items[0];
}

// ── Main: start MachineSet creation ──────────────────────────────────────────

async function start(installId, installDir, params, io) {
  if (activeMachinesetProcesses.has(installId)) return;
  activeMachinesetProcesses.set(installId, true);

  const room = `machineset:${installId}`;

  function emit(level, message, extra = {}) {
    io.to(room).emit('machineset:line', { level, message, ts: Date.now(), ...extra });
  }

  async function run() {
    const kubeconfigPath = path.join(installDir, 'auth', 'kubeconfig');
    if (!fs.existsSync(kubeconfigPath)) {
      throw new Error(`Kubeconfig nie znaleziony: ${kubeconfigPath}`);
    }

    const kc = new k8s.KubeConfig();
    kc.loadFromFile(kubeconfigPath);

    const coreApi   = kc.makeApiClient(k8s.CoreV1Api);
    const customApi = kc.makeApiClient(k8s.CustomObjectsApi);

    emit('info', `Rozpoczynanie tworzenia GPU MachineSet dla klastra...`);
    emit('info', `Parametry: nazwa=${params.machineSetName}, typ=${params.machineType}, strefa=${params.zone}, repliki=${params.replicas}`);

    // ── Step 1: Fetch worker MachineSet template ──────────────────────────────

    emit('info', `\n── Krok 1/${TOTAL_STEPS}: Pobieranie szablonu worker MachineSet ──`);
    io.to(room).emit('machineset:step_start', {
      stepIndex:  1,
      label:      'Pobieranie szablonu worker MachineSet',
      totalSteps: TOTAL_STEPS,
    });

    emit('info', `Listowanie MachineSetów w namespace ${MACHINESET_NAMESPACE}...`);
    const msList = await customApi.listNamespacedCustomObject({
      group:     MACHINESET_GROUP,
      version:   MACHINESET_VERSION,
      namespace: MACHINESET_NAMESPACE,
      plural:    MACHINESET_PLURAL,
    });

    const workerMs = findWorkerMachineSet(msList.items);
    emit('info', `Używam szablonu: ${workerMs.metadata.name}`);

    io.to(room).emit('machineset:step_done', {
      stepIndex:  1,
      label:      'Pobieranie szablonu worker MachineSet',
      totalSteps: TOTAL_STEPS,
    });

    // ── Step 2: Create GPU MachineSet ─────────────────────────────────────────

    emit('info', `\n── Krok 2/${TOTAL_STEPS}: Tworzenie GPU MachineSet ──`);
    io.to(room).emit('machineset:step_start', {
      stepIndex:  2,
      label:      'Tworzenie GPU MachineSet',
      totalSteps: TOTAL_STEPS,
    });

    // Deep clone the worker MachineSet
    const newMs = JSON.parse(JSON.stringify(workerMs));

    // Strip immutable/server-assigned metadata
    delete newMs.metadata.uid;
    delete newMs.metadata.resourceVersion;
    delete newMs.metadata.creationTimestamp;
    delete newMs.metadata.generation;
    delete newMs.metadata.managedFields;
    delete newMs.metadata.annotations;
    delete newMs.status;

    // Set new name
    newMs.metadata.name = params.machineSetName;

    // Update selector and template labels to use new MachineSet name
    const MACHINESET_LABEL = 'machine.openshift.io/cluster-api-machineset';
    if (newMs.spec?.selector?.matchLabels) {
      newMs.spec.selector.matchLabels[MACHINESET_LABEL] = params.machineSetName;
    }
    if (newMs.spec?.template?.metadata?.labels) {
      newMs.spec.template.metadata.labels[MACHINESET_LABEL] = params.machineSetName;
    }

    // Set desired replicas
    newMs.spec.replicas = params.replicas;

    // Apply GPU-specific providerSpec settings
    const ps = newMs.spec?.template?.spec?.providerSpec?.value;
    if (!ps) {
      throw new Error('Nie można odczytać providerSpec z szablonu worker MachineSet.');
    }
    ps.machineType       = params.machineType;
    ps.zone              = params.zone;
    ps.onHostMaintenance = 'Terminate';
    ps.restartPolicy     = 'Always';

    // Add GPU=YES label to node template
    if (!newMs.spec.template.spec.metadata) {
      newMs.spec.template.spec.metadata = {};
    }
    if (!newMs.spec.template.spec.metadata.labels) {
      newMs.spec.template.spec.metadata.labels = {};
    }
    newMs.spec.template.spec.metadata.labels['GPU'] = 'YES';

    emit('info', `Tworzenie MachineSet: ${params.machineSetName} (${params.machineType}, repliki: ${params.replicas})`);

    try {
      await customApi.createNamespacedCustomObject({
        group:     MACHINESET_GROUP,
        version:   MACHINESET_VERSION,
        namespace: MACHINESET_NAMESPACE,
        plural:    MACHINESET_PLURAL,
        body:      newMs,
      });
      emit('info', `MachineSet ${params.machineSetName} utworzony pomyślnie.`);
    } catch (err) {
      if (httpCode(err) === 409) {
        throw new Error(`MachineSet o nazwie "${params.machineSetName}" już istnieje. Wybierz inną nazwę.`);
      }
      throw err;
    }

    io.to(room).emit('machineset:step_done', {
      stepIndex:  2,
      label:      'Tworzenie GPU MachineSet',
      totalSteps: TOTAL_STEPS,
    });

    // ── Step 3: Wait for machines / nodes ─────────────────────────────────────

    emit('info', `\n── Krok 3/${TOTAL_STEPS}: Oczekiwanie na węzły GPU ──`);
    io.to(room).emit('machineset:step_start', {
      stepIndex:  3,
      label:      'Oczekiwanie na węzły GPU',
      totalSteps: TOTAL_STEPS,
    });

    if (params.replicas === 0) {
      emit('info', `Pominięto oczekiwanie — liczba replik = 0.`);
    } else {
      const TARGET_COUNT = params.replicas;
      const TIMEOUT_MS   = 30 * 60 * 1000; // 30 minutes
      const POLL_MS      = 20 * 1000;
      const startTime    = Date.now();
      let lastReady      = -1;

      emit('info', `Oczekiwanie na ${TARGET_COUNT} gotowych węzłów GPU (timeout: 30 min)...`);

      while (Date.now() - startTime < TIMEOUT_MS) {
        if (!activeMachinesetProcesses.has(installId)) {
          emit('warning', 'Tworzenie MachineSet anulowane.');
          return;
        }

        try {
          const ms = await customApi.getNamespacedCustomObject({
            group:     MACHINESET_GROUP,
            version:   MACHINESET_VERSION,
            namespace: MACHINESET_NAMESPACE,
            plural:    MACHINESET_PLURAL,
            name:      params.machineSetName,
          });

          const readyReplicas   = ms.status?.readyReplicas   || 0;
          const currentReplicas = ms.status?.replicas        || 0;
          const desired         = ms.spec?.replicas          || 0;

          if (readyReplicas !== lastReady) {
            emit('info', `  MachineSet status: ${readyReplicas}/${desired} gotowych (aktualne: ${currentReplicas})`);
            lastReady = readyReplicas;
          }

          if (readyReplicas >= TARGET_COUNT) {
            emit('info', `  MachineSet osiągnął ${readyReplicas} gotowych replik.`);
            break;
          }

          // Also verify GPU=YES nodes are Ready
          const nodeList = await coreApi.listNode({ labelSelector: 'GPU=YES' });
          const gpuNodes = (nodeList.items || []).filter(n => {
            const readyCond = (n.status?.conditions || []).find(c => c.type === 'Ready');
            return readyCond?.status === 'True';
          });

          if (gpuNodes.length >= TARGET_COUNT) {
            emit('info', `  ${gpuNodes.length} węzłów GPU gotowych: ${gpuNodes.map(n => n.metadata.name).join(', ')}`);
            break;
          }
        } catch (pollErr) {
          emit('debug', `  Błąd odczytu statusu: ${pollErr.message}`);
        }

        // Fast-fail: detect Machine provisioning errors (outside polling try/catch so errors propagate)
        try {
          const machineList = await customApi.listNamespacedCustomObject({
            group:         MACHINESET_GROUP,
            version:       MACHINESET_VERSION,
            namespace:     MACHINESET_NAMESPACE,
            plural:        'machines',
            labelSelector: `machine.openshift.io/cluster-api-machineset=${params.machineSetName}`,
          });
          for (const machine of (machineList.items || [])) {
            const errMsg = machine.status?.errorMessage;
            const phase  = machine.status?.phase;
            if (errMsg) {
              throw new Error(`Provisioning maszyny ${machine.metadata?.name}: ${errMsg}`);
            }
            if (phase === 'Failed') {
              throw new Error(`Maszyna ${machine.metadata?.name} weszła w stan Failed.`);
            }
          }
        } catch (machineErr) {
          if (machineErr.message.startsWith('Provisioning') || machineErr.message.startsWith('Maszyna')) {
            throw machineErr;
          }
          emit('debug', `  Pominięto błąd odpytywania maszyn: ${machineErr.message}`);
        }

        await sleep(POLL_MS);
      }

      // Final check after loop
      const nodeList = await coreApi.listNode({ labelSelector: 'GPU=YES' });
      const readyGpuNodes = (nodeList.items || []).filter(n => {
        const readyCond = (n.status?.conditions || []).find(c => c.type === 'Ready');
        return readyCond?.status === 'True';
      });

      if (readyGpuNodes.length < TARGET_COUNT && Date.now() - startTime >= TIMEOUT_MS) {
        throw new Error(
          `Przekroczono czas oczekiwania. Gotowych węzłów GPU: ${readyGpuNodes.length}/${TARGET_COUNT}. ` +
          `Sprawdź status MachineSet w konsoli OpenShift.`
        );
      }

      emit('info', `  Węzły GPU gotowe: ${readyGpuNodes.map(n => n.metadata.name).join(', ')}`);
    }

    io.to(room).emit('machineset:step_done', {
      stepIndex:  3,
      label:      'Oczekiwanie na węzły GPU',
      totalSteps: TOTAL_STEPS,
    });

    emit('info', `\n✓ GPU MachineSet "${params.machineSetName}" utworzony pomyślnie.`);
    stateStore.markGpuMachinesetCreated(installId);
    activeMachinesetProcesses.delete(installId);
    io.to(room).emit('machineset:complete', { installId, machineSetName: params.machineSetName });
  }

  run().catch(err => {
    console.error(`[machinesetProcess] Error for ${installId}:`, err.message);
    io.to(room).emit('machineset:line', {
      level:   'error',
      message: `✗ Błąd tworzenia MachineSet: ${err.message}`,
      ts:      Date.now(),
    });
    activeMachinesetProcesses.delete(installId);
    io.to(room).emit('machineset:failed', { installId, error: err.message });
  });
}

function isRunning(installId) {
  return activeMachinesetProcesses.has(installId);
}

module.exports = { start, isRunning };
