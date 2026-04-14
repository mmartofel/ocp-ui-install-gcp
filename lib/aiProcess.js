'use strict';

const fs   = require('fs');
const path = require('path');
const k8s  = require('@kubernetes/client-node');

const stateStore = require('./stateStore');

// installId -> true (running flag)
const activeAiProcesses = new Map();

const TOTAL_STEPS = 6;

const OPERATORS = [
  {
    stepIndex:       1,
    label:           'Node Feature Discovery (NFD) Operator',
    namespace:       'openshift-nfd',
    createNamespace: true,
    operatorGroup: {
      name:             'openshift-nfd',
      targetNamespaces: ['openshift-nfd'],
    },
    subscription: {
      name:    'nfd',
      package: 'nfd',
      channel: 'stable',
      source:  'redhat-operators',
    },
    postInstall: async (customApi, emit) => {
      emit('info', '[NFD] Tworzenie NodeFeatureDiscovery CR...');
      await applyNamespacedCR(customApi, {
        group:     'nfd.openshift.io',
        version:   'v1',
        plural:    'nodefeaturediscoveries',
        namespace: 'openshift-nfd',
        body: {
          apiVersion: 'nfd.openshift.io/v1',
          kind:       'NodeFeatureDiscovery',
          metadata:   { name: 'nfd-instance', namespace: 'openshift-nfd' },
          spec:       { operand: { servicePort: 12000 }, workerConfig: { configData: '' } },
        },
      });
      emit('info', '[NFD] NodeFeatureDiscovery CR zastosowany.');
    },
  },
  {
    stepIndex:       2,
    label:           'NVIDIA GPU Operator',
    namespace:       'nvidia-gpu-operator',
    createNamespace: true,
    operatorGroup: {
      name:             'nvidia-gpu-operator-group',
      targetNamespaces: ['nvidia-gpu-operator'],
    },
    subscription: {
      name:    'gpu-operator-certified',
      package: 'gpu-operator-certified',
      channel: 'v24.9',
      source:  'certified-operators',
    },
    postInstall: async (customApi, emit) => {
      emit('info', '[GPU] Tworzenie ClusterPolicy CR...');
      await applyClusterCR(customApi, {
        group:   'nvidia.com',
        version: 'v1',
        plural:  'clusterpolicies',
        body: {
          apiVersion: 'nvidia.com/v1',
          kind:       'ClusterPolicy',
          metadata:   { name: 'gpu-cluster-policy' },
          spec: {
            operator: {
              defaultRuntime:       'crio',
              use_ocp_driver_toolkit: true,
              initContainer:        {},
            },
            sandboxWorkloads: {
              enabled:         false,
              defaultWorkload: 'container',
            },
            driver: {
              enabled:              true,
              useNvidiaDriverCRD:   false,
              useOpenKernelModules: false,
              upgradePolicy: {
                autoUpgrade:        true,
                maxParallelUpgrades: 1,
                maxUnavailable:     '25%',
                drain: {
                  enable: false, force: false,
                  deleteEmptyDir: false, timeoutSeconds: 300,
                },
                podDeletion: {
                  force: false, deleteEmptyDir: false, timeoutSeconds: 300,
                },
                waitForCompletion: { timeoutSeconds: 0 },
              },
              repoConfig:        { configMapName: '' },
              certConfig:        { name: '' },
              licensingConfig:   { nlsEnabled: true, configMapName: '' },
              virtualTopology:   { config: '' },
              kernelModuleConfig: { name: '' },
            },
            dcgm:         { enabled: true },
            dcgmExporter: {
              enabled:        true,
              config:         { name: '' },
              serviceMonitor: { enabled: true },
            },
            // Required by the CRD — must be present
            daemonsets: {
              updateStrategy: 'RollingUpdate',
              rollingUpdate:  { maxUnavailable: '1' },
            },
            devicePlugin: {
              enabled: true,
              config:  { name: '', default: '' },
              mps:     { root: '/run/nvidia/mps' },
            },
            gfd:                { enabled: true },
            migManager:         { enabled: true },
            mig:                { strategy: 'single' },
            nodeStatusExporter: { enabled: true },
            toolkit:            { enabled: true },
            validator: {
              plugin: {
                env: [{ name: 'WITH_WORKLOAD', value: 'false' }],
              },
            },
            vgpuManager:         { enabled: false },
            vgpuDeviceManager:   { enabled: true },
            sandboxDevicePlugin: { enabled: true },
            vfioManager:         { enabled: true },
            gds:                 { enabled: false },
            gdrcopy:             { enabled: false },
          },
        },
      });
      emit('info', '[GPU] ClusterPolicy CR zastosowany.');
    },
  },
  {
    stepIndex:       3,
    label:           'OpenShift Service Mesh Operator',
    namespace:       'openshift-operators',
    createNamespace: false,
    operatorGroup:   null, // already exists in openshift-operators
    subscription: {
      name:    'servicemeshoperator',
      package: 'servicemeshoperator',
      channel: 'stable',
      source:  'redhat-operators',
    },
    postInstall: null,
  },
  {
    stepIndex:       4,
    label:           'Red Hat OpenShift Serverless Operator',
    namespace:       'openshift-serverless',
    createNamespace: true,
    operatorGroup: {
      name:             'serverless-operators',
      targetNamespaces: [],  // AllNamespaces mode
    },
    subscription: {
      name:    'serverless-operator',
      package: 'serverless-operator',
      channel: 'stable',
      source:  'redhat-operators',
    },
    postInstall: null,
  },
  {
    stepIndex:       5,
    label:           'Red Hat Authorino Operator',
    namespace:       'openshift-operators',
    createNamespace: false,
    operatorGroup:   null, // already exists in openshift-operators
    subscription: {
      name:    'authorino-operator',
      package: 'authorino-operator',
      channel: 'stable',
      source:  'redhat-operators',
    },
    postInstall: null,
  },
  {
    stepIndex:       6,
    label:           'Red Hat OpenShift AI Operator',
    namespace:       'redhat-ods-operator',
    createNamespace: true,
    operatorGroup: {
      name:             'rhods-operator',
      targetNamespaces: [],  // AllNamespaces mode — rhods-operator does not support OwnNamespace
    },
    subscription: {
      name:    'rhods-operator',
      package: 'rhods-operator',
      channel: 'stable-3.x',
      source:  'redhat-operators',
    },
    postInstall: async (customApi, emit) => {
      emit('info', '[RHOAI] Tworzenie DataScienceCluster CR...');
      await applyClusterCR(customApi, {
        group:   'datasciencecluster.opendatahub.io',
        version: 'v1',
        plural:  'datascienceclusters',
        body: {
          apiVersion: 'datasciencecluster.opendatahub.io/v1',
          kind:       'DataScienceCluster',
          metadata:   { name: 'default-dsc' },
          spec: {
            components: {
              dashboard:            { managementState: 'Managed' },
              workbenches:          { managementState: 'Managed' },
              datasciencepipelines: { managementState: 'Managed' },
              modelmeshserving:     { managementState: 'Managed' },
              kserve:               { managementState: 'Managed' },
              ray:                  { managementState: 'Removed' },
              kueue:                { managementState: 'Removed' },
              trainingoperator:     { managementState: 'Removed' },
              trustyai:             { managementState: 'Removed' },
              modelregistry:        { managementState: 'Removed' },
              codeflare:            { managementState: 'Removed' },
            },
          },
        },
      });
      emit('info', '[RHOAI] DataScienceCluster CR zastosowany.');
    },
  },
];

// ── Helper: sleep ─────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Helper: extract HTTP status code from @kubernetes/client-node v1.x errors ─
// v1.x throws ApiException with err.code (not err.response?.statusCode)

function httpCode(err) {
  return err?.code                                                        // ApiException v1.x
    || err?.response?.statusCode                                          // older 0.x path
    || err?.statusCode                                                    // some wrappers
    || (typeof err?.message === 'string'
        && Number(/HTTP-Code:\s*(\d+)/.exec(err.message)?.[1]))          // message fallback
    || 0;
}

// ── Helper: apply (create, ignore AlreadyExists) ──────────────────────────────

async function applyNamespace(coreApi, name) {
  try {
    await coreApi.createNamespace({ body: { apiVersion: 'v1', kind: 'Namespace', metadata: { name } } });
  } catch (err) {
    if (httpCode(err) !== 409) throw err;
  }
}

async function applyNamespacedCR(customApi, { group, version, plural, namespace, body }) {
  try {
    await customApi.createNamespacedCustomObject({ group, version, namespace, plural, body });
  } catch (err) {
    if (httpCode(err) !== 409) throw err;
  }
}

async function applyClusterCR(customApi, { group, version, plural, body }) {
  try {
    await customApi.createClusterCustomObject({ group, version, plural, body });
  } catch (err) {
    if (httpCode(err) !== 409) throw err;
  }
}

// ── Helper: wait for CSV to reach Succeeded via subscription status ───────────

async function waitForCsv(customApi, namespace, subscriptionName, emit, timeoutMs = 20 * 60 * 1000) {
  const start = Date.now();
  let lastPhase = '';

  while (Date.now() - start < timeoutMs) {
    try {
      const sub = await customApi.getNamespacedCustomObject({
        group:     'operators.coreos.com',
        version:   'v1alpha1',
        namespace,
        plural:    'subscriptions',
        name:      subscriptionName,
      });

      const installedCSV = sub.status?.installedCSV;
      const currentCSV   = sub.status?.currentCSV;
      const state        = sub.status?.state;

      if (installedCSV) {
        try {
          const csv = await customApi.getNamespacedCustomObject({
            group:     'operators.coreos.com',
            version:   'v1alpha1',
            namespace,
            plural:    'clusterserviceversions',
            name:      installedCSV,
          });
          const phase = csv.status?.phase || 'Unknown';
          if (phase !== lastPhase) {
            emit('info', `  CSV ${installedCSV}: faza ${phase}`);
            lastPhase = phase;
          }
          if (phase === 'Succeeded') return csv;
          if (phase === 'Failed') throw new Error(`CSV ${installedCSV} zakończony błędem`);
        } catch (csvErr) {
          if (csvErr.message.includes('zakończony błędem')) throw csvErr;
          // CSV not yet visible
        }
      } else if (currentCSV) {
        if (state !== lastPhase) {
          emit('debug', `  Subskrypcja: currentCSV=${currentCSV}, state=${state || 'pending'}`);
          lastPhase = state || '';
        }
      } else {
        emit('debug', `  Oczekiwanie na przetworzenie subskrypcji...`);
      }
    } catch (err) {
      if (err.message.includes('zakończony błędem')) throw err;
      emit('debug', `  Błąd odczytu subskrypcji: ${err.message}`);
    }

    await sleep(15 * 1000);
  }

  throw new Error(`Przekroczono czas oczekiwania na CSV dla ${subscriptionName} w ${namespace}`);
}

// ── Main: start AI operator installation ─────────────────────────────────────

async function start(installId, installDir, io) {
  if (activeAiProcesses.has(installId)) return;
  activeAiProcesses.set(installId, true);

  const room = `ai:${installId}`;

  function emit(level, message, extra = {}) {
    io.to(room).emit('ai:line', { level, message, ts: Date.now(), ...extra });
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

    emit('info', `Rozpoczynanie instalacji operatorów AI dla klastra...`);
    emit('info', `Łączenie z klastrem przez kubeconfig: ${kubeconfigPath}`);

    for (const op of OPERATORS) {
      if (!activeAiProcesses.has(installId)) {
        emit('warning', 'Instalacja anulowana.');
        return;
      }

      emit('info', `\n── Krok ${op.stepIndex}/${TOTAL_STEPS}: ${op.label} ──`);
      io.to(room).emit('ai:step_start', { stepIndex: op.stepIndex, label: op.label, totalSteps: TOTAL_STEPS });

      // 1. Create namespace
      if (op.createNamespace) {
        emit('info', `[Krok ${op.stepIndex}] Tworzenie namespace: ${op.namespace}`);
        await applyNamespace(coreApi, op.namespace);
        emit('info', `[Krok ${op.stepIndex}] Namespace ${op.namespace} gotowy.`);
      }

      // 2. Create OperatorGroup
      if (op.operatorGroup) {
        emit('info', `[Krok ${op.stepIndex}] Tworzenie OperatorGroup: ${op.operatorGroup.name}`);
        const ogBody = {
          apiVersion: 'operators.coreos.com/v1',
          kind:       'OperatorGroup',
          metadata:   { name: op.operatorGroup.name, namespace: op.namespace },
          spec:       {},
        };
        if (op.operatorGroup.targetNamespaces.length > 0) {
          ogBody.spec.targetNamespaces = op.operatorGroup.targetNamespaces;
        }
        await applyNamespacedCR(customApi, {
          group:     'operators.coreos.com',
          version:   'v1',
          plural:    'operatorgroups',
          namespace: op.namespace,
          body:      ogBody,
        });
        emit('info', `[Krok ${op.stepIndex}] OperatorGroup gotowy.`);
      }

      // 3. Create Subscription
      emit('info', `[Krok ${op.stepIndex}] Tworzenie Subscription: ${op.subscription.name} (kanał: ${op.subscription.channel})`);
      await applyNamespacedCR(customApi, {
        group:     'operators.coreos.com',
        version:   'v1alpha1',
        plural:    'subscriptions',
        namespace: op.namespace,
        body: {
          apiVersion: 'operators.coreos.com/v1alpha1',
          kind:       'Subscription',
          metadata:   { name: op.subscription.name, namespace: op.namespace },
          spec: {
            channel:             op.subscription.channel,
            installPlanApproval: 'Automatic',
            name:                op.subscription.package,
            source:              op.subscription.source,
            sourceNamespace:     'openshift-marketplace',
          },
        },
      });
      emit('info', `[Krok ${op.stepIndex}] Subscription utworzony. Oczekiwanie na instalację CSV...`);

      // 4. Wait for CSV
      await waitForCsv(customApi, op.namespace, op.subscription.name, emit);
      emit('info', `[Krok ${op.stepIndex}] Operator ${op.label} zainstalowany pomyślnie.`);

      // 5. Post-install CR
      if (op.postInstall) {
        await op.postInstall(customApi, emit);
      }

      io.to(room).emit('ai:step_done', { stepIndex: op.stepIndex, label: op.label, totalSteps: TOTAL_STEPS });
    }

    emit('info', '\n✓ Wszystkie operatory AI zainstalowane pomyślnie.');
    stateStore.markAiEnabled(installId);
    activeAiProcesses.delete(installId);
    io.to(room).emit('ai:complete', { installId });
  }

  run().catch(err => {
    console.error(`[aiProcess] Error for ${installId}:`, err.message);
    io.to(room).emit('ai:line', { level: 'error', message: `✗ Błąd instalacji: ${err.message}`, ts: Date.now() });
    activeAiProcesses.delete(installId);
    io.to(room).emit('ai:failed', { installId, error: err.message });
  });
}

function isRunning(installId) {
  return activeAiProcesses.has(installId);
}

module.exports = { start, isRunning };
