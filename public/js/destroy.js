'use strict';

const installId   = window.INSTALL_ID;
let   lineCounter = 0;
let   autoScroll  = true;

const socket = io({ transports: ['websocket', 'polling'] });

socket.on('connect', () => {
  if (!installId) return;
  socket.emit('destroy:join', { installId });
});

socket.on('destroy:line', (entry) => {
  appendLogEntry(entry);
});

socket.on('destroy:complete', () => {
  applyStatus('complete');
  appendSystemLine('✓ Klaster został pomyślnie usunięty.');
  document.getElementById('logCursor').classList.add('hidden');
  showResult('complete');
});

socket.on('destroy:failed', ({ exitCode, error }) => {
  applyStatus('failed');
  appendSystemLine(
    `✗ Usuwanie zakończone błędem (kod: ${exitCode ?? 'N/A'}). ${error || ''}`,
    'error'
  );
  document.getElementById('logCursor').classList.add('hidden');
  showResult('failed', exitCode);
  showForcePurgeButton();
});

// ── Log rendering ─────────────────────────────────────────────────────────────
const logLinesEl   = document.getElementById('logLines');
const logContainer = document.getElementById('logContainer');
const lineCountEl  = document.getElementById('lineCount');
const autoScrollEl = document.getElementById('autoScrollToggle');

autoScrollEl.addEventListener('change', () => {
  autoScroll = autoScrollEl.checked;
  if (autoScroll) scrollToBottom();
});

logContainer.addEventListener('scroll', () => {
  const atBottom = logContainer.scrollHeight - logContainer.scrollTop <= logContainer.clientHeight + 50;
  if (!atBottom && autoScrollEl.checked) {
    autoScrollEl.checked = false;
    autoScroll = false;
  }
});

const LEVEL_COLORS = {
  error:   'text-red-400',
  warning: 'text-yellow-400',
  warn:    'text-yellow-400',
  debug:   'text-slate-500',
  info:    'text-slate-200',
};

function appendLogEntry(entry) {
  lineCounter++;
  const el = buildLogLine({ ...entry, lineNumber: lineCounter });
  logLinesEl.appendChild(el);
  lineCountEl.textContent = `${lineCounter} linii`;
  if (autoScroll) scrollToBottom();
}

function appendSystemLine(msg, level = 'info') {
  lineCounter++;
  logLinesEl.appendChild(buildLogLine({ lineNumber: lineCounter, level, message: msg, ts: Date.now() }));
  if (autoScroll) scrollToBottom();
}

function buildLogLine(entry) {
  const el   = document.createElement('div');
  const time = entry.ts ? new Date(entry.ts).toLocaleTimeString('pl-PL') : '';
  const color= LEVEL_COLORS[entry.level] || 'text-slate-200';
  el.innerHTML =
    `<span class="select-none">` +
    `<span class="text-slate-600 mr-1">${time}</span>` +
    `<span class="text-slate-600 mr-2">[${(entry.level || 'info').toUpperCase().padEnd(5)}]</span>` +
    `</span><span class="${color}">${escapeHtml(entry.message)}</span>`;
  el.className = 'log-line leading-5';
  return el;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function scrollToBottom() {
  logContainer.scrollTop = logContainer.scrollHeight;
}

function showResult(status, exitCode) {
  const banner = document.getElementById('resultBanner');
  const title  = document.getElementById('resultTitle');
  const detail = document.getElementById('resultDetail');

  if (status === 'complete') {
    banner.className   = 'rounded-xl px-5 py-4 border bg-green-950/50 border-green-800';
    title.className    = 'text-sm font-semibold text-green-300';
    title.textContent  = '✓ Klaster usunięty pomyślnie';
    detail.className   = 'text-xs mt-1 text-green-400/70';
    detail.textContent = 'Wszystkie zasoby GCP zostały usunięte. Klaster przeniesiony do historii.';
  } else {
    banner.className   = 'rounded-xl px-5 py-4 border bg-red-950/50 border-red-800';
    title.className    = 'text-sm font-semibold text-red-300';
    title.textContent  = `✗ Błąd usuwania klastra (kod: ${exitCode ?? 'N/A'})`;
    detail.className   = 'text-xs mt-1 text-red-400/70';
    detail.textContent = 'Część zasobów GCP może wymagać ręcznego usunięcia. Sprawdź logi powyżej.';
  }

  banner.classList.remove('hidden');
}

function showForcePurgeButton() {
  const btn = document.getElementById('forcePurgeBtn');
  if (!btn) return;
  btn.classList.remove('hidden');
  btn.addEventListener('click', openForcePurgeModal);
}

function openForcePurgeModal() {
  document.getElementById('forcePurgeError').classList.add('hidden');
  document.getElementById('forcePurgeConfirmBtn').disabled = false;
  document.getElementById('forcePurgeConfirmBtn').textContent = 'Usuń metadane';
  document.getElementById('forcePurgeModal').classList.remove('hidden');
}

function closeForcePurgeModal() {
  document.getElementById('forcePurgeModal').classList.add('hidden');
}

async function confirmForcePurge() {
  const btn = document.getElementById('forcePurgeConfirmBtn');
  const err = document.getElementById('forcePurgeError');
  btn.disabled = true;
  btn.textContent = 'Usuwam...';
  err.classList.add('hidden');

  try {
    const res = await fetch(`/destroy/${installId}`, { method: 'DELETE' });
    const data = await res.json();
    if (data.redirect) {
      window.location.href = data.redirect;
    } else {
      err.textContent = data.error || 'Błąd usuwania metadanych.';
      err.classList.remove('hidden');
      btn.disabled = false;
      btn.textContent = 'Usuń metadane';
    }
  } catch (e) {
    err.textContent = `Błąd połączenia: ${e.message}`;
    err.classList.remove('hidden');
    btn.disabled = false;
    btn.textContent = 'Usuń metadane';
  }
}

document.getElementById('forcePurgeModal')?.addEventListener('click', (e) => {
  if (e.target === document.getElementById('forcePurgeModal')) closeForcePurgeModal();
});

function applyStatus(status) {
  const indicator = document.getElementById('statusIndicator');
  const text      = document.getElementById('statusText');

  const MAP = {
    complete: { dot: 'bg-green-400',              txt: 'text-green-300',  label: 'Klaster usunięty pomyślnie' },
    failed:   { dot: 'bg-red-500',                txt: 'text-red-400',    label: 'Błąd usuwania klastra'      },
    running:  { dot: 'bg-red-400 animate-pulse',  txt: 'text-red-300',    label: 'Usuwanie klastra w toku...' },
  };

  const s = MAP[status] || MAP.running;
  indicator.className = `w-2.5 h-2.5 rounded-full ${s.dot}`;
  text.className      = `text-sm font-medium ${s.txt}`;
  text.textContent    = s.label;
}
