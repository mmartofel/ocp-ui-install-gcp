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
  try {
    const opResp = await customApi.listClusterCustomObject(
      'config.openshift.io', 'v1', 'clusteroperators'
    );
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
      };
    });
  } catch (_) {
    // ClusterOperator CRD may not be accessible, skip
  }

  const install = stateStore.getInstall(installId);
  const consoleUrl = install
    ? `https://console-openshift-console.apps.${install.cluster_name}.${install.base_domain}`
    : null;
  const apiUrl = install
    ? `https://api.${install.cluster_name}.${install.base_domain}:6443`
    : null;

  return { nodes, operators, apiUrl, consoleUrl };
}

module.exports = { startPolling, stopPolling, fetchClusterStatus };
