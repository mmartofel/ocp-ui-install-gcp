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
      const msg = `<tr><td colspan="4" class="px-5 py-4 text-slate-500 text-center text-xs">
        Instalacja nie powiodła się — klaster niedostępny.
      </td></tr>`;
      document.getElementById('nodesBody').innerHTML = msg;
      document.getElementById('operatorsBody').innerHTML = msg;
      document.getElementById('nodesReady').textContent = 'Niedostępny';
      document.getElementById('nodesReady').className = 'text-xs text-red-400';
      document.getElementById('operatorsReady').textContent = '';
      return;
    }

    if (!data.kubeconfigExists) {
      const msg = `<tr><td colspan="4" class="px-5 py-4 text-slate-500 text-center text-xs">
        Kubeconfig niedostępny — sprawdź katalog instalacji.
      </td></tr>`;
      document.getElementById('nodesBody').innerHTML = msg;
      document.getElementById('operatorsBody').innerHTML = msg;
      document.getElementById('nodesReady').textContent = 'Brak kubeconfig';
      document.getElementById('nodesReady').className = 'text-xs text-yellow-400';
      document.getElementById('operatorsReady').textContent = '';
      return;
    }

    if (!status) {
      const msg = `<tr><td colspan="4" class="px-5 py-4 text-slate-500 text-center text-xs">
        Brak danych — kliknij "Odśwież" aby załadować status klastra.
      </td></tr>`;
      document.getElementById('nodesBody').innerHTML = msg;
      document.getElementById('operatorsBody').innerHTML = msg;
      document.getElementById('nodesReady').textContent = 'Ładowanie...';
      document.getElementById('nodesReady').className = 'text-xs text-slate-500';
      document.getElementById('operatorsReady').textContent = '';
      return;
    }

    if (status.nodes) renderNodes(status.nodes);
    if (status.operators) renderOperators(status.operators);

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
    tbody.innerHTML = `<tr><td colspan="4" class="px-5 py-4 text-slate-600 text-center text-xs">Brak danych węzłów.</td></tr>`;
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
      <td class="px-5 py-3 font-mono text-xs text-slate-500">${n.version || '-'}</td>
    </tr>
  `).join('');
}

function renderOperators(operators) {
  const tbody   = document.getElementById('operatorsBody');
  const readyEl = document.getElementById('operatorsReady');

  const availCount = operators.filter(o => o.available && !o.degraded).length;
  readyEl.textContent = `${availCount}/${operators.length} dostępnych`;
  readyEl.className   = availCount === operators.length ? 'text-xs text-green-400' : 'text-xs text-yellow-400';

  if (!operators.length) {
    tbody.innerHTML = `<tr><td colspan="4" class="px-5 py-4 text-slate-600 text-center text-xs">Brak danych operatorów.</td></tr>`;
    return;
  }

  tbody.innerHTML = operators.map(op => `
    <tr class="border-b border-slate-800/50 hover:bg-slate-800/30">
      <td class="px-5 py-3 font-mono text-xs text-slate-200">${op.name}</td>
      <td class="px-5 py-3 text-xs ${op.available ? 'text-green-400' : 'text-red-400'}">
        ${op.available ? '✓ Tak' : '✗ Nie'}
      </td>
      <td class="px-5 py-3 text-xs ${op.degraded ? 'text-red-400' : 'text-slate-500'}">
        ${op.degraded ? '✗ Tak' : '–'}
      </td>
      <td class="px-5 py-3 font-mono text-xs text-slate-500">${op.version || '-'}</td>
    </tr>
  `).join('');
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

// Reload when user returns to this tab (e.g. after re-login in another tab)
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && installId) loadStatus();
});

// ── Initial load ──────────────────────────────────────────────────────────────
if (installId) {
  loadStatus();
  refreshInterval = setInterval(loadStatus, 60 * 1000);
}
