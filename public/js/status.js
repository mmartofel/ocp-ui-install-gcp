'use strict';

const installId = window.INSTALL_ID;
let refreshInterval;

async function loadStatus() {
  if (!installId) return;

  try {
    const resp = await fetch(`/status/api?cluster=${installId}`);

    if (resp.status === 401) {
      showSessionExpired();
      return;
    }

    const data = await resp.json();

    if (data.error === 'session_expired') {
      showSessionExpired();
      return;
    }

    if (data.error) return;

    // Hide session banner if credentials recovered (e.g. re-logged in another tab)
    document.getElementById('sessionExpiredBanner').classList.add('hidden');

    if (data.consoleUrl) {
      document.getElementById('consoleUrl').textContent = data.consoleUrl;
      document.getElementById('consoleUrl').setAttribute('href', data.consoleUrl);
    }
    if (data.apiUrl) {
      document.getElementById('apiUrl').textContent = data.apiUrl;
    }
    if (data.kubeadminPassword) {
      document.getElementById('kubeadminPass').textContent = data.kubeadminPassword;
    }

    const install = data.install;
    const status  = data.clusterStatus;

    if (!install || install.status !== 'complete') {
      const nodesMsg = `<tr><td colspan="6" class="px-5 py-4 text-slate-500 text-center text-xs">Instalacja nie powiodła się — klaster niedostępny.</td></tr>`;
      const opsMsg   = `<tr><td colspan="5" class="px-5 py-4 text-slate-500 text-center text-xs">Instalacja nie powiodła się — klaster niedostępny.</td></tr>`;
      document.getElementById('nodesBody').innerHTML = nodesMsg;
      document.getElementById('operatorsBody').innerHTML = opsMsg;
      document.getElementById('nodesReady').textContent = 'Niedostępny';
      document.getElementById('nodesReady').className = 'text-xs text-red-400';
      document.getElementById('operatorsReady').textContent = '';
      return;
    }

    if (!data.kubeconfigExists) {
      const nodesMsg = `<tr><td colspan="6" class="px-5 py-4 text-slate-500 text-center text-xs">Kubeconfig niedostępny — sprawdź katalog instalacji.</td></tr>`;
      const opsMsg   = `<tr><td colspan="5" class="px-5 py-4 text-slate-500 text-center text-xs">Kubeconfig niedostępny — sprawdź katalog instalacji.</td></tr>`;
      document.getElementById('nodesBody').innerHTML = nodesMsg;
      document.getElementById('operatorsBody').innerHTML = opsMsg;
      document.getElementById('nodesReady').textContent = 'Brak kubeconfig';
      document.getElementById('nodesReady').className = 'text-xs text-yellow-400';
      document.getElementById('operatorsReady').textContent = '';
      return;
    }

    if (!status) {
      const nodesMsg = `<tr><td colspan="6" class="px-5 py-4 text-slate-500 text-center text-xs">Brak danych — kliknij "Odśwież" aby załadować status klastra.</td></tr>`;
      const opsMsg   = `<tr><td colspan="5" class="px-5 py-4 text-slate-500 text-center text-xs">Brak danych — kliknij "Odśwież" aby załadować status klastra.</td></tr>`;
      document.getElementById('nodesBody').innerHTML = nodesMsg;
      document.getElementById('operatorsBody').innerHTML = opsMsg;
      document.getElementById('nodesReady').textContent = 'Ładowanie...';
      document.getElementById('nodesReady').className = 'text-xs text-slate-500';
      document.getElementById('operatorsReady').textContent = '';
      return;
    }

    if (status.ocpVersion) document.getElementById('ocpVersion').textContent = status.ocpVersion;
    if (status.infraProvider) document.getElementById('infraProvider').textContent = status.infraProvider;

    if (status.nodes) renderNodes(status.nodes);
    if (status.operators) renderOperators(status.operators, status.operatorErrors);

    // Load MachineSets (live from k8s)
    await loadMachineSets();

  } catch (err) {
    console.error('Status load error:', err);
  }
}

function showSessionExpired() {
  document.getElementById('sessionExpiredBanner').classList.remove('hidden');
  clearInterval(refreshInterval);
}

function renderNodes(nodes) {
  const tbody   = document.getElementById('nodesBody');
  const readyEl = document.getElementById('nodesReady');

  const readyCount = nodes.filter(n => n.ready).length;
  readyEl.textContent = `${readyCount}/${nodes.length} gotowych`;
  readyEl.className   = readyCount === nodes.length ? 'text-xs text-green-400' : 'text-xs text-yellow-400';

  if (!nodes.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="px-5 py-4 text-slate-600 text-center text-xs">Brak danych węzłów.</td></tr>`;
    return;
  }

  tbody.innerHTML = nodes.map(n => `
    <tr class="border-b border-slate-800/50 hover:bg-slate-800/30">
      <td class="px-5 py-3 font-mono text-xs text-slate-200">${n.name}</td>
      <td class="px-5 py-3">
        <span class="px-2 py-0.5 rounded text-xs bg-slate-800 text-slate-400 font-mono">${n.roles}</span>
      </td>
      <td class="px-5 py-3">
        <span class="flex items-center gap-1.5 text-xs ${n.ready ? 'text-green-400' : 'text-red-400'}">
          <span class="w-1.5 h-1.5 rounded-full ${n.ready ? 'bg-green-400' : 'bg-red-400'}"></span>
          ${n.ready ? 'Ready' : 'NotReady'}
        </span>
      </td>
      <td class="px-5 py-3 font-mono text-xs text-slate-400">${n.instanceType || '-'}</td>
      <td class="px-5 py-3 font-mono text-xs text-slate-400">${n.zone || '-'}</td>
      <td class="px-5 py-3 font-mono text-xs text-slate-500">${n.version || '-'}</td>
    </tr>
  `).join('');
}

function renderOperators(operators, operatorErrors) {
  const tbody   = document.getElementById('operatorsBody');
  const readyEl = document.getElementById('operatorsReady');

  const availCount = operators.filter(o => o.available && !o.degraded).length;
  readyEl.textContent = `${availCount}/${operators.length} dostępnych`;
  readyEl.className   = availCount === operators.length ? 'text-xs text-green-400' : 'text-xs text-yellow-400';

  if (!operators.length) {
    const errMsg = operatorErrors && operatorErrors.length
      ? `Błąd pobierania operatorów: ${operatorErrors.join('; ')}`
      : 'Brak danych operatorów.';
    tbody.innerHTML = `<tr><td colspan="6" class="px-5 py-4 text-slate-600 text-center text-xs">${errMsg}</td></tr>`;
    return;
  }

  tbody.innerHTML = operators.map(op => {
    const isOlm = op.source === 'olm';
    const typeBadge = isOlm
      ? `<span class="px-1.5 py-0.5 rounded text-xs bg-blue-900/50 text-blue-400 font-mono">OLM</span>`
      : `<span class="px-1.5 py-0.5 rounded text-xs bg-slate-800 text-slate-400 font-mono">Platform</span>`;
    const namespaceTd = op.namespace
      ? `<td class="px-5 py-3 font-mono text-xs text-slate-400">${op.namespace}</td>`
      : `<td class="px-5 py-3 text-xs text-slate-600 italic">cluster-scoped</td>`;
    return `
    <tr class="border-b border-slate-800/50 hover:bg-slate-800/30">
      <td class="px-5 py-3 font-mono text-xs text-slate-200">${op.name}</td>
      ${namespaceTd}
      <td class="px-5 py-3">${typeBadge}</td>
      <td class="px-5 py-3 text-xs ${op.available ? 'text-green-400' : 'text-red-400'}">
        ${op.available ? '✓ Tak' : '✗ Nie'}
      </td>
      <td class="px-5 py-3 text-xs ${op.degraded ? 'text-red-400' : 'text-green-400'}">
        ${op.degraded ? '✗ Tak' : '✓ Nie'}
      </td>
      <td class="px-5 py-3 font-mono text-xs text-slate-500">${op.version || '-'}</td>
    </tr>`;
  }).join('');
}

async function refreshStatus() {
  const icon    = document.getElementById('refreshIcon');
  const errEl   = document.getElementById('refreshError');
  icon.classList.add('animate-spin');
  errEl.classList.add('hidden');
  try {
    const resp = await fetch(`/status/refresh?cluster=${installId}`, { method: 'POST' });
    if (resp.status === 401) {
      showSessionExpired();
      return;
    }
    if (!resp.ok) {
      const data = await resp.json().catch(() => ({}));
      errEl.textContent = data.error || 'Błąd połączenia z klastrem.';
      errEl.classList.remove('hidden');
      return;
    }
    await loadStatus();
  } catch (err) {
    errEl.textContent = `Błąd: ${err.message}`;
    errEl.classList.remove('hidden');
  } finally {
    icon.classList.remove('animate-spin');
  }
}

async function reconcileCluster() {
  const btn   = document.getElementById('reconcileBtn');
  const icon  = document.getElementById('reconcileIcon');
  const errEl = document.getElementById('refreshError');

  btn.disabled = true;
  icon.classList.add('animate-spin');
  errEl.classList.add('hidden');
  errEl.className = 'hidden bg-red-950/50 border border-red-800 rounded-xl px-4 py-2.5 text-xs text-red-300';

  try {
    const resp = await fetch(`/status/reconcile?cluster=${installId}`, { method: 'POST' });
    if (resp.status === 401) { showSessionExpired(); return; }

    const data = await resp.json();

    if (!resp.ok) {
      errEl.textContent = data.error || 'Błąd weryfikacji klastra.';
      errEl.classList.remove('hidden');
      return;
    }

    if (data.healthy || data.already) {
      window.location.reload();
      return;
    }

    const list = data.degradedOperators?.length
      ? data.degradedOperators.join(', ')
      : 'nieznane';
    errEl.textContent = `Klaster nie jest w pełni sprawny. Zdegradowane operatory: ${list}. Poczekaj chwilę i spróbuj ponownie.`;
    errEl.className = 'bg-yellow-950/50 border border-yellow-700 rounded-xl px-4 py-2.5 text-xs text-yellow-300';
    errEl.classList.remove('hidden');
  } catch (err) {
    errEl.textContent = `Błąd: ${err.message}`;
    errEl.classList.remove('hidden');
  } finally {
    btn.disabled = false;
    icon.classList.remove('animate-spin');
  }
}

function copyVal(elementId) {
  const el   = document.getElementById(elementId);
  const text = el.textContent;
  const btn  = el.nextElementSibling;

  function onCopied() {
    if (!btn) return;
    const orig = btn.textContent;
    btn.textContent = '✓ Skopiowano';
    setTimeout(() => { btn.textContent = orig; }, 2000);
  }

  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(onCopied).catch(() => fallbackCopy(text, onCopied));
  } else {
    fallbackCopy(text, onCopied);
  }
}

function fallbackCopy(text, callback) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  try { document.execCommand('copy'); callback(); } catch (_) {}
  document.body.removeChild(ta);
}

// ── AI modal ──────────────────────────────────────────────────────────────────
let aiTargetId = null;

function openAiModal(id, name) {
  aiTargetId = id;
  document.getElementById('aiClusterName').textContent = name;
  document.getElementById('aiError').classList.add('hidden');
  document.getElementById('aiConfirmBtn').disabled = false;
  document.getElementById('aiConfirmBtn').textContent = 'Uruchom instalację AI';
  document.getElementById('aiModal').classList.remove('hidden');
}

function closeAiModal() {
  document.getElementById('aiModal').classList.add('hidden');
  aiTargetId = null;
}

async function confirmAiSetup() {
  if (!aiTargetId) return;

  const btn = document.getElementById('aiConfirmBtn');
  const err = document.getElementById('aiError');
  btn.disabled = true;
  btn.textContent = 'Uruchamiam...';
  err.classList.add('hidden');

  try {
    const resp = await fetch(`/ai/${aiTargetId}/start`, { method: 'POST' });
    const data = await resp.json();

    if (resp.status === 401) {
      err.textContent = 'Sesja wygasła. Zaloguj się ponownie.';
      err.classList.remove('hidden');
      btn.disabled = false;
      btn.textContent = 'Uruchom instalację AI';
      return;
    }

    if (!resp.ok) {
      err.textContent = data.error || 'Błąd uruchamiania instalacji AI.';
      err.classList.remove('hidden');
      btn.disabled = false;
      btn.textContent = 'Uruchom instalację AI';
      return;
    }

    window.location.href = `/ai/${aiTargetId}`;
  } catch (e) {
    err.textContent = `Błąd: ${e.message}`;
    err.classList.remove('hidden');
    btn.disabled = false;
    btn.textContent = 'Uruchom instalację AI';
  }
}

// Close AI modal on backdrop click
document.getElementById('aiModal').addEventListener('click', (e) => {
  if (e.target === document.getElementById('aiModal')) closeAiModal();
});

// ── Destroy modal ─────────────────────────────────────────────────────────────
let destroyTargetId = null;

function openDestroyModal(id, name) {
  destroyTargetId = id;
  document.getElementById('destroyClusterName').textContent = name;
  document.getElementById('destroyError').classList.add('hidden');
  document.getElementById('destroyConfirmBtn').disabled = false;
  document.getElementById('destroyConfirmBtn').textContent = 'Usuń klaster';
  document.getElementById('destroyModal').classList.remove('hidden');
}

function closeDestroyModal() {
  document.getElementById('destroyModal').classList.add('hidden');
  destroyTargetId = null;
}

async function confirmDestroy(force = false) {
  if (!destroyTargetId) return;

  const btn = document.getElementById('destroyConfirmBtn');
  const err = document.getElementById('destroyError');
  btn.disabled = true;
  btn.textContent = force ? 'Usuwam z interfejsu...' : 'Uruchamiam...';
  err.classList.add('hidden');

  try {
    const url  = `/destroy/${destroyTargetId}${force ? '?force=true' : ''}`;
    const resp = await fetch(url, { method: 'POST' });
    const data = await resp.json();

    if (resp.status === 401) {
      err.textContent = 'Sesja wygasła. Zaloguj się ponownie.';
      err.classList.remove('hidden');
      btn.disabled = false;
      btn.textContent = 'Usuń klaster';
      return;
    }

    // Install dir missing — ask user for explicit confirmation before force-removing from DB
    if (resp.status === 422 && data.needsForce) {
      err.textContent = data.message;
      err.classList.remove('hidden');
      btn.disabled = false;
      btn.textContent = 'Usuń tylko z interfejsu';
      btn.onclick = () => confirmDestroy(true);
      return;
    }

    if (!resp.ok) {
      err.textContent = data.error || 'Błąd uruchamiania usuwania.';
      err.classList.remove('hidden');
      btn.disabled = false;
      btn.textContent = 'Usuń klaster';
      return;
    }

    window.location.href = data.redirect;
  } catch (e) {
    err.textContent = `Błąd: ${e.message}`;
    err.classList.remove('hidden');
    btn.disabled = false;
    btn.textContent = 'Usuń klaster';
  }
}

// Close modal on backdrop click
document.getElementById('destroyModal').addEventListener('click', (e) => {
  if (e.target === document.getElementById('destroyModal')) closeDestroyModal();
});

// ── Purge cluster (permanent metadata removal) ────────────────────────────────
let purgeTargetId = null;

function openPurgeModal(id, name) {
  purgeTargetId = id;
  document.getElementById('purgeClusterName').textContent = name;
  document.getElementById('purgeError').classList.add('hidden');
  document.getElementById('purgeConfirmBtn').disabled = false;
  document.getElementById('purgeConfirmBtn').textContent = 'Usuń na zawsze';
  document.getElementById('purgeModal').classList.remove('hidden');
}

function closePurgeModal() {
  document.getElementById('purgeModal').classList.add('hidden');
  purgeTargetId = null;
}

async function confirmPurge() {
  if (!purgeTargetId) return;

  const btn = document.getElementById('purgeConfirmBtn');
  const err = document.getElementById('purgeError');
  btn.disabled = true;
  btn.textContent = 'Usuwam...';
  err.classList.add('hidden');

  try {
    const resp = await fetch(`/destroy/${purgeTargetId}/purge`, { method: 'DELETE' });
    const data = await resp.json();

    if (resp.status === 401) {
      err.textContent = 'Sesja wygasła. Zaloguj się ponownie.';
      err.classList.remove('hidden');
      btn.disabled = false;
      btn.textContent = 'Usuń na zawsze';
      return;
    }

    if (!resp.ok) {
      err.textContent = data.error || 'Błąd usuwania danych klastra.';
      err.classList.remove('hidden');
      btn.disabled = false;
      btn.textContent = 'Usuń na zawsze';
      return;
    }

    // Remove the table row directly — no full page reload needed
    const row = document.querySelector(`[data-purge-id="${purgeTargetId}"]`);
    if (row) row.remove();
    closePurgeModal();
  } catch (e) {
    err.textContent = `Błąd połączenia: ${e.message}`;
    err.classList.remove('hidden');
    btn.disabled = false;
    btn.textContent = 'Usuń na zawsze';
  }
}

document.getElementById('purgeModal')?.addEventListener('click', (e) => {
  if (e.target === document.getElementById('purgeModal')) closePurgeModal();
});

// Reload when user returns to this tab (e.g. after re-login in another tab)
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && installId) loadStatus();
});

// ── MachineSet functions ──────────────────────────────────────────────────────

// GCP GPU instance specs lookup — used by table and modal
const GPU_INSTANCE_SPECS = {
  // NVIDIA L4 (g2 series)
  'g2-standard-4':  { vcpu: 4,  ramGb: 16,  gpuCount: 1, gpuModel: 'NVIDIA L4',   gpuMemGb: 24  },
  'g2-standard-8':  { vcpu: 8,  ramGb: 32,  gpuCount: 1, gpuModel: 'NVIDIA L4',   gpuMemGb: 24  },
  'g2-standard-12': { vcpu: 12, ramGb: 48,  gpuCount: 1, gpuModel: 'NVIDIA L4',   gpuMemGb: 24  },
  'g2-standard-16': { vcpu: 16, ramGb: 64,  gpuCount: 1, gpuModel: 'NVIDIA L4',   gpuMemGb: 24  },
  'g2-standard-24': { vcpu: 24, ramGb: 96,  gpuCount: 2, gpuModel: 'NVIDIA L4',   gpuMemGb: 48  },
  'g2-standard-32': { vcpu: 32, ramGb: 128, gpuCount: 2, gpuModel: 'NVIDIA L4',   gpuMemGb: 48  },
  'g2-standard-48': { vcpu: 48, ramGb: 192, gpuCount: 4, gpuModel: 'NVIDIA L4',   gpuMemGb: 96  },
  'g2-standard-96': { vcpu: 96, ramGb: 384, gpuCount: 8, gpuModel: 'NVIDIA L4',   gpuMemGb: 192 },
  // NVIDIA A100 40 GB (a2-highgpu series)
  'a2-highgpu-1g':  { vcpu: 12, ramGb: 85,  gpuCount: 1, gpuModel: 'NVIDIA A100', gpuMemGb: 40  },
  'a2-highgpu-2g':  { vcpu: 24, ramGb: 170, gpuCount: 2, gpuModel: 'NVIDIA A100', gpuMemGb: 80  },
  'a2-highgpu-4g':  { vcpu: 48, ramGb: 340, gpuCount: 4, gpuModel: 'NVIDIA A100', gpuMemGb: 160 },
};

// GPU type groups — used to rebuild the instance type dropdown dynamically
const GPU_TYPE_GROUPS = [
  {
    label: 'NVIDIA L4',
    types: ['g2-standard-4','g2-standard-8','g2-standard-12','g2-standard-16',
            'g2-standard-24','g2-standard-32','g2-standard-48','g2-standard-96'],
  },
  {
    label: 'NVIDIA A100',
    types: ['a2-highgpu-1g','a2-highgpu-2g','a2-highgpu-4g'],
  },
];

// Cached MachineSet list — updated on each loadMachineSets() call
let cachedMachineSets = [];

async function loadMachineSets() {
  if (!installId) return;
  const tbody = document.getElementById('machineSetsBody');
  if (!tbody) return;

  try {
    const resp = await fetch(`/machineset/${installId}/list`);
    if (resp.status === 401) { showSessionExpired(); return; }
    if (!resp.ok) return;
    const data = await resp.json();
    cachedMachineSets = data.machineSets || [];
    renderMachineSets(cachedMachineSets);
  } catch (_) {}
}

function renderMachineSets(machineSets) {
  const tbody = document.getElementById('machineSetsBody');
  if (!tbody) return;

  if (!machineSets.length) {
    tbody.innerHTML = `<tr><td colspan="8" class="px-5 py-4 text-slate-600 text-center text-xs">Brak MachineSetów.</td></tr>`;
    return;
  }

  tbody.innerHTML = machineSets.map(ms => {
    const specs = GPU_INSTANCE_SPECS[ms.instanceType] || null;
    const cpuCell = specs
      ? `${specs.vcpu} vCPU / ${specs.ramGb} GB`
      : '—';
    const gpuCell = specs
      ? `${specs.gpuCount}× ${specs.gpuModel} / ${specs.gpuMemGb} GB`
      : '—';

    return `
    <tr class="border-b border-slate-800/50 hover:bg-slate-800/30">
      <td class="px-5 py-3">
        <div class="flex items-center gap-2">
          <span class="font-mono text-xs text-slate-200">${ms.name}</span>
          ${ms.isGpu ? `<span class="px-1.5 py-0.5 rounded text-xs bg-green-900/40 text-green-400 font-mono">GPU</span>` : ''}
        </div>
      </td>
      <td class="px-5 py-3 font-mono text-xs text-slate-400">${ms.zone || '—'}</td>
      <td class="px-5 py-3 text-xs text-slate-400">${ms.readyReplicas} z ${ms.replicas}</td>
      <td class="px-5 py-3 font-mono text-xs text-slate-400">${ms.instanceType || '—'}</td>
      <td class="px-5 py-3 text-xs text-slate-400">${cpuCell}</td>
      <td class="px-5 py-3 text-xs ${ms.isGpu ? 'text-green-400/80' : 'text-slate-400'}">${gpuCell}</td>
      <td class="px-5 py-3">
        <div class="flex items-center gap-1">
          <button onclick="scaleMachineSet('${ms.name}', ${ms.replicas - 1})"
                  ${ms.replicas <= 0 ? 'disabled' : ''}
                  class="w-6 h-6 flex items-center justify-center rounded border border-slate-600 hover:border-slate-400 text-slate-400 hover:text-white text-sm disabled:opacity-30 disabled:cursor-not-allowed transition-colors">
            −
          </button>
          <span class="w-8 text-center text-xs text-slate-300 font-mono">${ms.replicas}</span>
          <button onclick="scaleMachineSet('${ms.name}', ${ms.replicas + 1})"
                  class="w-6 h-6 flex items-center justify-center rounded border border-slate-600 hover:border-slate-400 text-slate-400 hover:text-white text-sm transition-colors">
            +
          </button>
        </div>
      </td>
      <td class="px-5 py-3 text-right">
        <button onclick="openMsDeleteModal('${ms.name}', ${ms.replicas})"
                class="px-2 py-1 text-xs border ${ms.replicas === 0 ? 'border-red-900 hover:border-red-600 text-red-500 hover:text-red-400' : 'border-slate-700 text-slate-600 cursor-not-allowed'} rounded transition-colors"
                title="${ms.replicas === 0 ? 'Usuń MachineSet' : 'Skaluj do 0 przed usunięciem'}">
          Usuń
        </button>
      </td>
    </tr>`;
  }).join('');
}

async function scaleMachineSet(name, newReplicas) {
  if (newReplicas < 0) return;
  try {
    const resp = await fetch(`/machineset/${installId}/scale`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ name, replicas: newReplicas }),
    });
    if (resp.status === 401) { showSessionExpired(); return; }
    await loadMachineSets();
  } catch (err) {
    console.error('Scale error:', err);
  }
}

// ── MachineSet delete modal ───────────────────────────────────────────────────
let msDeleteTarget = null;

function openMsDeleteModal(name, replicas) {
  msDeleteTarget = name;

  document.getElementById('msDeleteName').textContent = name;
  document.getElementById('msDeleteError').classList.add('hidden');

  const blocked  = document.getElementById('msDeleteBlockedMsg');
  const confirm  = document.getElementById('msDeleteConfirmMsg');
  const confirmBtn = document.getElementById('msDeleteConfirmBtn');

  if (replicas > 0) {
    document.getElementById('msDeleteReplicaCount').textContent = replicas;
    blocked.classList.remove('hidden');
    confirm.classList.add('hidden');
    confirmBtn.classList.add('hidden');
  } else {
    blocked.classList.add('hidden');
    confirm.classList.remove('hidden');
    confirmBtn.classList.remove('hidden');
    confirmBtn.disabled = false;
    confirmBtn.textContent = 'Usuń MachineSet';
  }

  document.getElementById('msDeleteModal').classList.remove('hidden');
}

function closeMsDeleteModal() {
  document.getElementById('msDeleteModal').classList.add('hidden');
  msDeleteTarget = null;
}

async function confirmMsDelete() {
  if (!msDeleteTarget) return;

  const btn = document.getElementById('msDeleteConfirmBtn');
  const err = document.getElementById('msDeleteError');
  btn.disabled = true;
  btn.textContent = 'Usuwam...';
  err.classList.add('hidden');

  try {
    const resp = await fetch(`/machineset/${installId}/delete`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ name: msDeleteTarget }),
    });
    const data = await resp.json();

    if (resp.status === 401) {
      err.textContent = 'Sesja wygasła. Zaloguj się ponownie.';
      err.classList.remove('hidden');
      btn.disabled = false;
      btn.textContent = 'Usuń MachineSet';
      return;
    }

    if (!resp.ok) {
      err.textContent = data.error || 'Błąd usuwania MachineSet.';
      err.classList.remove('hidden');
      btn.disabled = false;
      btn.textContent = 'Usuń MachineSet';
      return;
    }

    closeMsDeleteModal();
    await loadMachineSets();
  } catch (e) {
    err.textContent = `Błąd: ${e.message}`;
    err.classList.remove('hidden');
    btn.disabled = false;
    btn.textContent = 'Usuń MachineSet';
  }
}

document.getElementById('msDeleteModal')?.addEventListener('click', (e) => {
  if (e.target === document.getElementById('msDeleteModal')) closeMsDeleteModal();
});

// ── GPU MachineSet modal ──────────────────────────────────────────────────────
let gpuTargetId = null;

// Build zone list: zones already used by existing MachineSets + standard a/b/c/d for region
function buildZoneOptions(region) {
  const knownZones = new Set();

  // Collect zones from already-loaded MachineSets
  cachedMachineSets.forEach(ms => {
    if (ms.zone) knownZones.add(ms.zone);
  });

  // Add standard GCP zones for the region (a, b, c, d) as fallback / extras
  ['a', 'b', 'c', 'd'].forEach(suffix => {
    if (region) knownZones.add(`${region}-${suffix}`);
  });

  return [...knownZones].sort();
}

async function fetchAvailableGpuTypes(zone) {
  if (!zone || !installId) return null;
  try {
    const resp = await fetch(`/machineset/${installId}/available-types?zone=${encodeURIComponent(zone)}`);
    if (!resp.ok) return null;
    const data = await resp.json();
    return data.availableTypes || null;
  } catch (_) {
    return null;
  }
}

function updateMachineTypeDropdown(availableTypes) {
  const sel = document.getElementById('gpuMachineType');
  if (!sel) return;
  const prev = sel.value;
  sel.innerHTML = '';

  for (const group of GPU_TYPE_GROUPS) {
    const groupTypes = availableTypes
      ? group.types.filter(t => availableTypes.includes(t))
      : group.types;
    if (!groupTypes.length) continue;

    const optgroup = document.createElement('optgroup');
    optgroup.label = group.label;
    for (const t of groupTypes) {
      const s = GPU_INSTANCE_SPECS[t];
      const opt = document.createElement('option');
      opt.value = t;
      opt.textContent = s
        ? `${t} — ${s.vcpu} vCPU / ${s.ramGb} GB RAM / ${s.gpuCount}× ${s.gpuModel} ${s.gpuMemGb} GB  ★`
        : t;
      optgroup.appendChild(opt);
    }
    sel.appendChild(optgroup);
  }

  // Restore prior selection if still available, otherwise pick first
  if ([...sel.options].some(o => o.value === prev)) {
    sel.value = prev;
  } else if (sel.options.length > 0) {
    sel.value = sel.options[0].value;
  }

  // Show/hide unavailability warning and gate confirm button
  const warn = document.getElementById('gpuTypeUnavailableWarn');
  const confirmBtn = document.getElementById('gpuConfirmBtn');
  const isEmpty = sel.options.length === 0;
  if (warn) warn.classList.toggle('hidden', !isEmpty);
  if (confirmBtn) confirmBtn.disabled = isEmpty;
}

function openGpuModal(id) {
  gpuTargetId = id;

  // Auto-suggest name from first MachineSet in table
  const firstCell = document.querySelector('#machineSetsBody tr td:first-child span.font-mono');
  if (firstCell) {
    const baseName = firstCell.textContent.trim();
    document.getElementById('gpuMsName').value = baseName ? `${baseName}-gpu` : '';
  } else {
    document.getElementById('gpuMsName').value = '';
  }

  // Populate zone dropdown
  const region = window.GCP_REGION || '';
  const zones  = buildZoneOptions(region);
  const zoneSelect = document.getElementById('gpuZone');
  zoneSelect.innerHTML = zones.map(z => `<option value="${z}">${z}</option>`).join('');
  // Pre-select the zone of the first worker MachineSet if available
  const firstWorkerZone = cachedMachineSets.find(ms => !ms.isGpu)?.zone;
  if (firstWorkerZone && zones.includes(firstWorkerZone)) {
    zoneSelect.value = firstWorkerZone;
  }

  document.getElementById('gpuError').classList.add('hidden');
  document.getElementById('gpuConfirmBtn').textContent = 'Utwórz MachineSet';
  document.getElementById('gpuModal').classList.remove('hidden');

  // Trigger initial instance type availability check for the pre-selected zone
  const initZone = document.getElementById('gpuZone').value;
  if (initZone) {
    updateMachineTypeDropdown(null); // reset to full list while loading
    fetchAvailableGpuTypes(initZone).then(updateMachineTypeDropdown);
  }
}

function closeGpuModal() {
  document.getElementById('gpuModal').classList.add('hidden');
  gpuTargetId = null;
}

async function confirmGpuMachineSet() {
  if (!gpuTargetId) return;

  const btn  = document.getElementById('gpuConfirmBtn');
  const err  = document.getElementById('gpuError');
  const name = document.getElementById('gpuMsName').value.trim();
  const type = document.getElementById('gpuMachineType').value;
  const zone = document.getElementById('gpuZone').value;
  const reps = parseInt(document.getElementById('gpuReplicas').value, 10);

  if (!name) {
    err.textContent = 'Podaj nazwę MachineSet.';
    err.classList.remove('hidden');
    return;
  }

  if (!zone) {
    err.textContent = 'Wybierz strefę (zone).';
    err.classList.remove('hidden');
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Tworzę...';
  err.classList.add('hidden');

  try {
    const resp = await fetch(`/machineset/${gpuTargetId}/start`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ machineSetName: name, machineType: type, zone, replicas: reps }),
    });
    const data = await resp.json();

    if (resp.status === 401) {
      err.textContent = 'Sesja wygasła. Zaloguj się ponownie.';
      err.classList.remove('hidden');
      btn.disabled = false;
      btn.textContent = 'Utwórz MachineSet';
      return;
    }

    if (!resp.ok) {
      err.textContent = data.error || 'Błąd tworzenia MachineSet.';
      err.classList.remove('hidden');
      btn.disabled = false;
      btn.textContent = 'Utwórz MachineSet';
      return;
    }

    window.location.href = `/machineset/${gpuTargetId}?msName=${encodeURIComponent(name)}`;
  } catch (e) {
    err.textContent = `Błąd: ${e.message}`;
    err.classList.remove('hidden');
    btn.disabled = false;
    btn.textContent = 'Utwórz MachineSet';
  }
}

document.getElementById('gpuModal')?.addEventListener('click', (e) => {
  if (e.target === document.getElementById('gpuModal')) closeGpuModal();
});

// Update instance type dropdown when zone selection changes
document.getElementById('gpuZone')?.addEventListener('change', async function () {
  updateMachineTypeDropdown(null); // reset to full list while fetching
  const available = await fetchAvailableGpuTypes(this.value);
  updateMachineTypeDropdown(available);
});

// ── One-click kubeconfig regeneration via OAuth ───────────────────────────────

function regenerateKubeconfig() {
  document.getElementById('regenError').classList.add('hidden');
  document.getElementById('regenConfirmBtn').disabled = false;
  document.getElementById('regenConfirmBtn').textContent = '';
  // Re-inject icon + label (button content was replaced on previous run)
  document.getElementById('regenConfirmBtn').innerHTML = `
    <svg id="regenConfirmIcon" class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
            d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/>
    </svg>
    Regeneruj`;
  document.getElementById('regenModal').classList.remove('hidden');
}

function closeRegenModal() {
  document.getElementById('regenModal').classList.add('hidden');
}

async function confirmRegenKubeconfig() {
  const btn     = document.getElementById('regenConfirmBtn');
  const errEl   = document.getElementById('regenError');
  const btnIcon = document.getElementById('regenIcon');

  btn.disabled = true;
  btn.innerHTML = `
    <svg class="w-3.5 h-3.5 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
            d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/>
    </svg>
    Regeneruję...`;
  errEl.classList.add('hidden');
  if (btnIcon) btnIcon.classList.add('animate-spin');

  try {
    const resp = await fetch(`/status/regenerate-kubeconfig?cluster=${installId}`, { method: 'POST' });
    if (resp.status === 401) { showSessionExpired(); return; }

    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      errEl.textContent = data.error || 'Błąd regeneracji kubeconfig.';
      errEl.classList.remove('hidden');
      btn.disabled = false;
      btn.innerHTML = `
        <svg id="regenConfirmIcon" class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/>
        </svg>
        Regeneruj`;
      return;
    }

    closeRegenModal();
    if (btnIcon) btnIcon.classList.remove('animate-spin');
    await loadStatus();
  } catch (e) {
    errEl.textContent = `Błąd: ${e.message}`;
    errEl.classList.remove('hidden');
    btn.disabled = false;
    btn.innerHTML = `
      <svg id="regenConfirmIcon" class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
              d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/>
      </svg>
      Regeneruj`;
  }
}

document.getElementById('regenModal')?.addEventListener('click', (e) => {
  if (e.target === document.getElementById('regenModal')) closeRegenModal();
});

// ── Kubeconfig replacement modal ──────────────────────────────────────────────

function openKubeconfigModal() {
  document.getElementById('kubeconfigFile').value = '';
  document.getElementById('kubeconfigError').classList.add('hidden');
  document.getElementById('kubeconfigSuccess').classList.add('hidden');
  document.getElementById('kubeconfigSubmitBtn').disabled = false;
  document.getElementById('kubeconfigSubmitBtn').textContent = 'Zastąp kubeconfig';
  document.getElementById('kubeconfigModal').classList.remove('hidden');
}

function closeKubeconfigModal() {
  document.getElementById('kubeconfigModal').classList.add('hidden');
}

async function submitKubeconfig() {
  const fileInput = document.getElementById('kubeconfigFile');
  const errEl     = document.getElementById('kubeconfigError');
  const okEl      = document.getElementById('kubeconfigSuccess');
  const btn       = document.getElementById('kubeconfigSubmitBtn');

  errEl.classList.add('hidden');
  okEl.classList.add('hidden');

  if (!fileInput.files || !fileInput.files[0]) {
    errEl.textContent = 'Wybierz plik kubeconfig.';
    errEl.classList.remove('hidden');
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Wysyłam...';

  try {
    const form = new FormData();
    form.append('kubeconfig', fileInput.files[0]);

    const resp = await fetch(`/status/kubeconfig?cluster=${installId}`, {
      method: 'POST',
      body:   form,
    });

    const data = await resp.json().catch(() => ({}));

    if (resp.status === 401) {
      showSessionExpired();
      return;
    }

    if (!resp.ok) {
      errEl.textContent = data.error || 'Błąd zastępowania kubeconfig.';
      errEl.classList.remove('hidden');
      btn.disabled = false;
      btn.textContent = 'Zastąp kubeconfig';
      return;
    }

    okEl.classList.remove('hidden');
    btn.disabled = true;
    btn.textContent = 'Zastąpiono';

    setTimeout(() => {
      closeKubeconfigModal();
      loadStatus();
    }, 1500);
  } catch (e) {
    errEl.textContent = `Błąd: ${e.message}`;
    errEl.classList.remove('hidden');
    btn.disabled = false;
    btn.textContent = 'Zastąp kubeconfig';
  }
}

document.getElementById('kubeconfigModal')?.addEventListener('click', (e) => {
  if (e.target === document.getElementById('kubeconfigModal')) closeKubeconfigModal();
});

// ── Initial load ──────────────────────────────────────────────────────────────
if (installId) {
  loadStatus();
  refreshInterval = setInterval(loadStatus, 60 * 1000);
}
