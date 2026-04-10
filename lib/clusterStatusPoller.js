'use strict';

const fs = require('fs');
const path = require('path');
const k8s = require('@kubernetes/client-node');
const stateStore = require('./stateStore');

const POLL_INTERVAL_MS = 60 * 1000;
const activePollers = new Map(); // installId -> intervalId

/**
 * Starts polling cluster status every 60 seconds after successful install.
 */
function startPolling(installId, installDir) {
  if (activePollers.has(installId)) return;

  const kubeconfigPath = path.join(installDir, 'auth', 'kubeconfig');
  if (!fs.existsSync(kubeconfigPath)) return;

  async function poll() {
    try {
      const status = await fetchClusterStatus(kubeconfigPath, installId);
      stateStore.upsertClusterStatus({
        installId,
        apiUrl:     status.apiUrl,
        consoleUrl: status.consoleUrl,
        nodeCount:  status.nodes.length,
        nodesReady: status.nodes.filter(n => n.ready).length,
        rawJson:    status,
      });
    } catch (err) {
      // Cluster may not be ready yet, keep trying
    }
  }

  poll(); // immediate first check
  const timer = setInterval(poll, POLL_INTERVAL_MS);
  activePollers.set(installId, timer);
}

function stopPolling(installId) {
  const timer = activePollers.get(installId);
  if (timer) {
    clearInterval(timer);
    activePollers.delete(installId);
  }
}

/**
 * Fetches cluster status using the kubeconfig from the install directory.
 */
async function fetchClusterStatus(kubeconfigPath, installId) {
  const kc = new k8s.KubeConfig();
  kc.loadFromFile(kubeconfigPath);

  const coreApi   = kc.makeApiClient(k8s.CoreV1Api);
  const customApi = kc.makeApiClient(k8s.CustomObjectsApi);

  // Fetch nodes
  const nodesResp = await coreApi.listNode();
  const nodes = (nodesResp.items || []).map(n => {
    const readyCond = (n.status.conditions || []).find(c => c.type === 'Ready');
    const roles = Object.keys(n.metadata.labels || {})
      .filter(k => k.startsWith('node-role.kubernetes.io/'))
      .map(k => k.replace('node-role.kubernetes.io/', ''));
    return {
      name:    n.metadata.name,
      ready:   readyCond && readyCond.status === 'True',
      roles:   roles.join(', ') || 'worker',
      version: n.status.nodeInfo?.kubeletVersion || '',
      age:     n.metadata.creationTimestamp,
    };
  });

  // Fetch cluster operators (OpenShift custom resource)
  let operators = [];
  let operatorErrors = [];
  try {
    const opResp = await customApi.listClusterCustomObject({
      group: 'config.openshift.io', version: 'v1', plural: 'clusteroperators',
    });
    operators = (opResp.items || []).map(op => {
      const available  = (op.status?.conditions || []).find(c => c.type === 'Available');
      const degraded   = (op.status?.conditions || []).find(c => c.type === 'Degraded');
      const progressing= (op.status?.conditions || []).find(c => c.type === 'Progressing');
      return {
        name:        op.metadata.name,
        available:   available?.status === 'True',
        degraded:    degraded?.status === 'True',
        progressing: progressing?.status === 'True',
        version:     op.status?.versions?.[0]?.version || '',
        source:      'platform',
      };
    });
  } catch (err) {
    console.error('[clusterStatusPoller] Failed to fetch ClusterOperators:', err.message);
    operatorErrors.push(`ClusterOperators: ${err.message}`);
  }

  // Fetch OLM-installed operators (ClusterServiceVersions across all namespaces)
  try {
    const csvResp = await customApi.listClusterCustomObject({
      group: 'operators.coreos.com', version: 'v1alpha1', plural: 'clusterserviceversions',
    });
    const olmOperators = (csvResp.items || [])
      .filter(csv => csv.status?.reason !== 'Copied' && csv.status?.phase !== 'Replacing')
      .map(csv => ({
        name:        csv.metadata.name,
        available:   csv.status?.phase === 'Succeeded',
        degraded:    csv.status?.phase === 'Failed',
        progressing: csv.status?.phase === 'Installing',
        version:     csv.spec?.version || '',
        source:      'olm',
      }));
    operators = [...operators, ...olmOperators];
  } catch (err) {
    console.error('[clusterStatusPoller] Failed to fetch ClusterServiceVersions (OLM):', err.message);
    operatorErrors.push(`OLM CSVs: ${err.message}`);
  }

  const install = stateStore.getInstall(installId);
  const consoleUrl = install
    ? `https://console-openshift-console.apps.${install.cluster_name}.${install.base_domain}`
    : null;
  const apiUrl = install
    ? `https://api.${install.cluster_name}.${install.base_domain}:6443`
    : null;

  return { nodes, operators, operatorErrors, apiUrl, consoleUrl };
}

module.exports = { startPolling, stopPolling, fetchClusterStatus };
