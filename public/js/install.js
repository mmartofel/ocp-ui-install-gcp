'use strict';

const installId    = window.INSTALL_ID;
let   lineCounter  = 0;
let   autoScroll   = true;
let   allLogLines  = []; // { lineNumber, level, message, raw, stage, ts }

// ── Socket.io connection ──────────────────────────────────────────────────────
const socket = io({ transports: ['websocket', 'polling'] });

socket.on('connect', () => {
  if (!installId) return;
  socket.emit('install:join', { installId });

  if (lineCounter > 0) {
    // Reconnected mid-install — request missed lines
    socket.emit('install:request_replay', { installId, fromLine: lineCounter });
  } else if (['complete', 'failed', 'aborted'].includes(window.INSTALL_STATUS)) {
    // Page loaded with a finished install — replay all stored logs
    socket.emit('install:request_replay', { installId, fromLine: 0 });
  }
});

socket.on('install:replay', ({ lines }) => {
  lines.forEach(appendLogEntry);
});

socket.on('log:line', (entry) => {
  appendLogEntry(entry);
});

socket.on('install:progress', ({ stage, pct }) => {
  updateProgress(pct, stage);
});

socket.on('install:status', ({ status }) => {
  applyStatus(status);
});

socket.on('install:complete', ({ consoleUrl, apiUrl }) => {
  applyStatus('complete');
  appendSystemLine(`✓ Instalacja zakończona pomyślnie!`);
  if (consoleUrl) appendSystemLine(`Konsola: ${consoleUrl}`);
  if (apiUrl)     appendSystemLine(`API:     ${apiUrl}`);

  document.getElementById('abortBtn').disabled = true;
  document.getElementById('abortBtn').classList.add('opacity-40', 'cursor-not-allowed');

  // Auto-redirect only when install just finished (was running on page load), not on history replay
  if (window.INSTALL_STATUS === 'running') {
    setTimeout(() => { window.location.href = '/status'; }, 3000);
  }
});

socket.on('install:failed', ({ exitCode, error }) => {
  applyStatus('failed');
  appendSystemLine(`✗ Instalacja zakończona błędem (kod: ${exitCode ?? 'N/A'}). ${error || ''}`, 'error');
  document.getElementById('abortBtn').disabled = true;
});

// ── Log rendering ─────────────────────────────────────────────────────────────
const logLines      = document.getElementById('logLines');
const logContainer  = document.getElementById('logContainer');
const lineCountEl   = document.getElementById('lineCount');
const autoScrollEl  = document.getElementById('autoScrollToggle');

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
  // Deduplicate
  if (entry.lineNumber <= lineCounter) return;
  lineCounter = entry.lineNumber;

  allLogLines.push(entry);

  const line = buildLogLine(entry);
  logLines.appendChild(line);

  lineCountEl.textContent = `${lineCounter} linii`;

  if (autoScroll) scrollToBottom();
  applyCurrentFilter();
}

function appendSystemLine(msg, level = 'info') {
  const entry = { lineNumber: ++lineCounter, level, message: msg, raw: msg, ts: Date.now() };
  allLogLines.push(entry);
  logLines.appendChild(buildLogLine(entry));
  if (autoScroll) scrollToBottom();
}

function buildLogLine(entry) {
  const el = document.createElement('div');
  el.dataset.level   = entry.level;
  el.dataset.message = entry.message.toLowerCase();

  const time    = entry.ts ? new Date(entry.ts).toLocaleTimeString('pl-PL') : '';
  const color   = LEVEL_COLORS[entry.level] || 'text-slate-200';
  const lvlBadge= `<span class="text-slate-600 mr-1">${time}</span>` +
                  `<span class="text-slate-600 mr-2">[${(entry.level || 'info').toUpperCase().padEnd(5)}]</span>`;

  el.innerHTML = `<span class="select-none">${lvlBadge}</span><span class="${color}">${escapeHtml(entry.message)}</span>`;
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

// ── Filtering ─────────────────────────────────────────────────────────────────
function filterLogs() {
  applyCurrentFilter();
}

function applyCurrentFilter() {
  const level  = document.getElementById('levelFilter').value;
  const search = document.getElementById('logSearch').value.toLowerCase();

  document.querySelectorAll('.log-line').forEach(el => {
    const matchLevel  = level === 'all' || (el.dataset.level || '').startsWith(level);
    const matchSearch = !search || (el.dataset.message || '').includes(search);
    el.style.display  = (matchLevel && matchSearch) ? '' : 'none';
  });
}

// ── Progress bar ──────────────────────────────────────────────────────────────
function updateProgress(pct, stageLabel) {
  document.getElementById('progressBar').style.width = `${pct}%`;
  document.getElementById('pctBadge').textContent    = `${pct}%`;

  if (stageLabel) {
    document.getElementById('statusText').textContent = stageLabel;
  }

  // Highlight stage pills up to current
  const STAGE_ORDER = ['infrastructure','bootstrap','bootstrapping','removing-bootstrap','cluster-operators','console','complete'];
  const current     = document.querySelectorAll('[data-stage]');
  let   activating  = false;
  current.forEach(pill => {
    const idx = STAGE_ORDER.indexOf(pill.dataset.stage);
    if (idx !== -1 && STAGE_ORDER.indexOf(pill.dataset.stage) <= pct / 15) {
      pill.classList.add('border-green-700', 'text-green-400');
      pill.classList.remove('border-slate-700', 'text-slate-500');
    }
  });
}

function applyStatus(status) {
  const indicator = document.getElementById('statusIndicator');
  const text      = document.getElementById('statusText');

  const MAP = {
    running:  { dot: 'bg-yellow-400 animate-pulse', txt: 'text-yellow-300', label: 'Trwa instalacja...' },
    complete: { dot: 'bg-green-400',                txt: 'text-green-300',  label: 'Instalacja zakończona' },
    failed:   { dot: 'bg-red-500',                  txt: 'text-red-400',    label: 'Instalacja nieudana' },
    aborted:  { dot: 'bg-slate-500',                txt: 'text-slate-400',  label: 'Instalacja przerwana' },
    idle:     { dot: 'bg-slate-500',                txt: 'text-slate-400',  label: 'Oczekiwanie...' },
  };

  const s = MAP[status] || MAP.idle;
  indicator.className = `w-2.5 h-2.5 rounded-full ${s.dot}`;
  text.className      = `text-sm font-medium ${s.txt}`;
  text.textContent    = s.label;
}

// ── Abort modal ───────────────────────────────────────────────────────────────
function confirmAbort() {
  document.getElementById('abortModal').classList.remove('hidden');
}
function closeAbortModal() {
  document.getElementById('abortModal').classList.add('hidden');
}
async function doAbort() {
  closeAbortModal();
  try {
    const resp = await fetch('/install/abort', { method: 'POST' });
    const data = await resp.json();
    appendSystemLine(`Instalacja przerwana. ${data.warning || ''}`, 'warn');
    applyStatus('aborted');
  } catch (err) {
    appendSystemLine(`Błąd przerywania: ${err.message}`, 'error');
  }
}

// ── Initial state ─────────────────────────────────────────────────────────────
applyStatus(window.INSTALL_STATUS || 'idle');

// If already complete/failed on page load, request replay of all logs
if (['complete', 'failed', 'aborted'].includes(window.INSTALL_STATUS) && installId) {
  fetch(`/install/status`)
    .then(r => r.json())
    .then(d => {
      if (d.status === 'complete') applyStatus('complete');
      else if (d.status === 'failed') applyStatus('failed');
    });
}
