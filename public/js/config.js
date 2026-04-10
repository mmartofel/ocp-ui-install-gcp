'use strict';

// Auto-detect GCP project, base domain, and regions on page load
async function autoDetectGcpValues() {
  try {
    const resp = await fetch('/config/autodetect');
    if (!resp.ok) return;
    const data = await resp.json();

    const gcpProjectEl = document.querySelector('[name="gcpProject"]');
    const baseDomainEl = document.getElementById('baseDomain');
    const regionEl     = document.querySelector('[name="region"]');

    // Fill gcpProject if empty or still showing the SA's own project id (default)
    if (gcpProjectEl && (!gcpProjectEl.value.trim() || gcpProjectEl.value.trim() === window.SA_PROJECT_ID)) {
      gcpProjectEl.value = data.gcpProject || '';
    }

    // Fill baseDomain if empty
    if (baseDomainEl && !baseDomainEl.value.trim() && data.baseDomain) {
      baseDomainEl.value = data.baseDomain;
    }

    // Rebuild region select with live regions; preserve already-chosen value
    if (regionEl && data.regions && data.regions.length > 0) {
      const currentValue = regionEl.value;
      // Remove all options except the placeholder
      while (regionEl.options.length > 1) regionEl.remove(1);
      data.regions.forEach(r => {
        const opt = document.createElement('option');
        opt.value       = r.value;
        opt.textContent = r.label || r.value;
        regionEl.appendChild(opt);
      });
      // Restore user-selected value or default to detected region
      regionEl.value = currentValue || data.region || '';
    }
  } catch (_) {
    // Non-blocking — silently ignore any error
  }
}

// Kick off auto-detect immediately (non-blocking)
autoDetectGcpValues();

// DNS Zone verification
async function checkDns() {
  const baseDomain = document.getElementById('baseDomain').value.trim();
  const statusEl   = document.getElementById('dnsStatus');
  const btn        = document.getElementById('dnsCheckBtn');

  if (!baseDomain) {
    statusEl.textContent = 'Podaj domenę bazową przed sprawdzeniem DNS.';
    statusEl.className   = 'form-hint text-yellow-400';
    return;
  }

  btn.textContent = 'Sprawdzam...';
  btn.disabled    = true;

  try {
    const gcpProjectEl = document.querySelector('[name="gcpProject"]');
    const gcpProject   = gcpProjectEl ? gcpProjectEl.value.trim() : '';

    const resp = await fetch('/config/validate-dns', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ baseDomain, gcpProject }),
    });

    if (resp.status === 401) {
      statusEl.textContent = 'Sesja wygasła. Zaloguj się ponownie.';
      statusEl.className   = 'form-hint text-yellow-400';
      return;
    }

    const data = await resp.json();

    if (!resp.ok) {
      statusEl.textContent = `Błąd: ${data.error || 'Nieznany błąd serwera'}`;
      statusEl.className   = 'form-hint text-red-400';
      return;
    }

    if (data.exists) {
      statusEl.textContent = `✓ Znaleziono strefę DNS: ${data.zone.name}`;
      statusEl.className   = 'form-hint text-green-400';
    } else {
      const zoneList = data.zones.slice(0, 3).map(z => z.dnsName).join(', ');
      statusEl.textContent = `✗ Nie znaleziono strefy DNS dla "${baseDomain}". Dostępne strefy: ${zoneList || 'brak'}`;
      statusEl.className   = 'form-hint text-red-400';
    }
  } catch (err) {
    statusEl.textContent = `Błąd sprawdzania DNS: ${err.message}`;
    statusEl.className   = 'form-hint text-yellow-400';
  } finally {
    btn.textContent = 'Sprawdź DNS';
    btn.disabled    = false;
  }
}

// Preview YAML without starting installation
async function previewConfig() {
  const result = await submitConfigForm({ previewOnly: true });
  if (result && result.yamlPreview) {
    document.getElementById('yamlPreview').textContent = result.yamlPreview;
    document.getElementById('yamlPreviewSection').classList.remove('hidden');
    document.getElementById('yamlPreviewSection').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

// Serialize form to object
function getFormData() {
  const form   = document.getElementById('configForm');
  const data   = Object.fromEntries(new FormData(form).entries());
  data.fips    = form.querySelector('[name="fips"]').checked;
  data.workerCount = parseInt(data.workerCount, 10);
  return data;
}

async function submitConfigForm({ previewOnly = false } = {}) {
  const msgEl = document.getElementById('configMsg');
  msgEl.classList.add('hidden');

  try {
    const resp = await fetch('/config', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(getFormData()),
    });

    if (resp.status === 401) {
      showMsg(msgEl, 'Sesja wygasła. <a href="/auth" class="underline text-yellow-200">Zaloguj się ponownie.</a>', 'error');
      return null;
    }

    const data = await resp.json();

    if (!resp.ok) {
      const errors = data.errors || [data.error] || ['Błąd walidacji'];
      showMsg(msgEl, errors.join('\n'), 'error');
      return null;
    }

    return data;
  } catch (err) {
    showMsg(msgEl, err.message, 'error');
    return null;
  }
}

// Form submit → save config + start installation
document.getElementById('configForm').addEventListener('submit', async (e) => {
  e.preventDefault();

  const btn     = document.getElementById('startBtn');
  const label   = document.getElementById('startLabel');
  const spinner = document.getElementById('startSpinner');

  btn.disabled      = true;
  label.textContent = 'Zapisuję konfigurację...';
  spinner.classList.remove('hidden');

  // 1. Save config
  const configResult = await submitConfigForm();
  if (!configResult) {
    btn.disabled = false;
    label.textContent = 'Rozpocznij instalację →';
    spinner.classList.add('hidden');
    return;
  }

  // 2. Start installation
  label.textContent = 'Uruchamiam instalator...';
  try {
    const resp = await fetch('/install/start', { method: 'POST' });
    const data = await resp.json();

    if (!resp.ok) {
      throw new Error(data.error || 'Błąd uruchamiania instalacji');
    }

    window.location.href = data.redirect || '/install';
  } catch (err) {
    showMsg(document.getElementById('configMsg'), err.message, 'error');
    btn.disabled = false;
    label.textContent = 'Rozpocznij instalację →';
    spinner.classList.add('hidden');
  }
});

async function fetchOcpVersions() {
  const channelEl = document.getElementById('ocpChannelSelect');
  const versionEl = document.getElementById('ocpVersionSelect');
  const hintEl    = document.getElementById('ocpVersionHint');
  const btn       = document.getElementById('fetchVersionsBtn');
  const channel   = channelEl.value;
  if (!channel) return;

  btn.textContent    = 'Pobieranie...';
  btn.disabled       = true;
  hintEl.textContent = '';
  hintEl.className   = 'form-hint';

  try {
    const resp = await fetch(`/config/ocp-versions?channel=${encodeURIComponent(channel)}`);

    if (resp.status === 401) {
      hintEl.textContent = 'Sesja wygasła. Zaloguj się ponownie.';
      hintEl.className   = 'form-hint text-yellow-400';
      return;
    }

    const data = await resp.json();

    if (!resp.ok) {
      hintEl.textContent = `Błąd: ${data.error || 'Nieznany błąd'}`;
      hintEl.className   = 'form-hint text-red-400';
      return;
    }

    const currentValue = versionEl.value;
    versionEl.innerHTML = '<option value="">domyślna wersja instalatora</option>';

    if (!data.versions || data.versions.length === 0) {
      hintEl.textContent = `Brak dostępnych wersji w kanale ${channel}.`;
      hintEl.className   = 'form-hint text-yellow-400';
      return;
    }

    // Display newest first
    const reversed = data.versions.slice().reverse();
    reversed.forEach(v => {
      const opt = document.createElement('option');
      opt.value       = v;
      opt.textContent = v;
      versionEl.appendChild(opt);
    });

    versionEl.value = (currentValue && data.versions.includes(currentValue))
      ? currentValue : reversed[0];

    hintEl.textContent = `Załadowano ${data.versions.length} wersji z kanału ${channel}.`;
    hintEl.className   = 'form-hint text-green-400';
  } catch (err) {
    hintEl.textContent = `Błąd: ${err.message}`;
    hintEl.className   = 'form-hint text-yellow-400';
  } finally {
    btn.textContent = 'Pobierz wersje';
    btn.disabled    = false;
  }
}

function showMsg(el, text, type) {
  el.innerHTML = text.replace(/\n/g, '<br>');
  el.className = `p-4 rounded-lg text-sm ${
    type === 'error'
      ? 'bg-red-950/50 border border-red-800 text-red-300'
      : 'bg-green-950/50 border border-green-800 text-green-300'
  }`;
  el.classList.remove('hidden');
  el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
