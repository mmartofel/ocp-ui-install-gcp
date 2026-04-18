'use strict';

const installId   = window.INSTALL_ID;
let   lineCounter = 0;
let   autoScroll  = true;

const socket = io({ transports: ['websocket', 'polling'] });

socket.on('connect', () => {
  if (!installId) return;
  socket.emit('machineset:join', { installId });
});

socket.on('machineset:line', (entry) => {
  appendLogEntry(entry);
});

socket.on('machineset:step_start', ({ stepIndex }) => {
  markStepActive(stepIndex);
});

socket.on('machineset:step_done', ({ stepIndex }) => {
  markStepDone(stepIndex);
});

socket.on('machineset:complete', () => {
  applyStatus('complete');
  appendSystemLine('✓ GPU MachineSet utworzony pomyślnie.');
  document.getElementById('logCursor').classList.add('hidden');
  showResult('complete');
});

socket.on('machineset:failed', ({ error }) => {
  applyStatus('failed');
  appendSystemLine(`✗ Tworzenie zakończone błędem: ${error || 'Nieznany błąd'}`, 'error');
  document.getElementById('logCursor').classList.add('hidden');
  showResult('failed', error);
});

socket.on('machineset:status', ({ gpuMachinesetCreatedAt, isRunning }) => {
  if (gpuMachinesetCreatedAt) {
    applyStatus('complete');
    document.getElementById('logCursor').classList.add('hidden');
    showResult('complete');
    // Mark all steps done
    for (let i = 1; i <= 3; i++) markStepDone(i);
  } else if (!isRunning) {
    applyStatus('idle');
  }
});

// ── Step indicator ────────────────────────────────────────────────────────────

function markStepActive(stepIndex) {
  const item = document.querySelector(`.step-item[data-step="${stepIndex}"]`);
  if (!item) return;
  const dot  = item.querySelector('.step-dot');
  const icon = item.querySelector('.step-icon');
  const text = item.querySelector('span:last-child');
  dot.className  = 'step-dot w-5 h-5 rounded-full border border-blue-500 bg-blue-900/50 flex items-center justify-center flex-shrink-0';
  icon.className = 'step-icon text-xs text-blue-400 animate-pulse';
  icon.textContent = '●';
  text.className = 'text-sm text-blue-300';
}

function markStepDone(stepIndex) {
  const item = document.querySelector(`.step-item[data-step="${stepIndex}"]`);
  if (!item) return;
  const dot  = item.querySelector('.step-dot');
  const icon = item.querySelector('.step-icon');
  const text = item.querySelector('span:last-child');
  dot.className  = 'step-dot w-5 h-5 rounded-full border border-green-600 bg-green-900/40 flex items-center justify-center flex-shrink-0';
  icon.className = 'step-icon text-xs text-green-400';
  icon.textContent = '✓';
  text.className = 'text-sm text-green-300';
}

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
  const el    = document.createElement('div');
  const time  = entry.ts ? new Date(entry.ts).toLocaleTimeString('pl-PL') : '';
  const color = LEVEL_COLORS[entry.level] || 'text-slate-200';
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

// ── Result banner ─────────────────────────────────────────────────────────────

function showResult(status, error) {
  const banner = document.getElementById('resultBanner');
  const title  = document.getElementById('resultTitle');
  const detail = document.getElementById('resultDetail');

  if (status === 'complete') {
    banner.className   = 'rounded-xl px-5 py-4 border bg-green-950/50 border-green-800';
    title.className    = 'text-sm font-semibold text-green-300';
    title.textContent  = '✓ GPU MachineSet utworzony pomyślnie';
    detail.className   = 'text-xs mt-1 text-green-400/70';
    detail.textContent = 'MachineSet z instancjami GPU jest gotowy. Węzły GPU są widoczne na stronie Status.';
  } else {
    banner.className   = 'rounded-xl px-5 py-4 border bg-red-950/50 border-red-800';
    title.className    = 'text-sm font-semibold text-red-300';
    title.textContent  = '✗ Błąd tworzenia GPU MachineSet';
    detail.className   = 'text-xs mt-1 text-red-400/70';
    detail.textContent = error
      ? `Szczegóły: ${error}. Sprawdź logi powyżej i spróbuj ponownie.`
      : 'Sprawdź logi powyżej i spróbuj ponownie.';
  }

  banner.classList.remove('hidden');
}

// ── Status indicator ──────────────────────────────────────────────────────────

function applyStatus(status) {
  const indicator = document.getElementById('statusIndicator');
  const text      = document.getElementById('statusText');

  const MAP = {
    complete: { dot: 'bg-green-400',                txt: 'text-green-300', label: 'GPU MachineSet utworzony pomyślnie'   },
    failed:   { dot: 'bg-red-500',                  txt: 'text-red-400',   label: 'Błąd tworzenia GPU MachineSet'        },
    running:  { dot: 'bg-blue-400 animate-pulse',   txt: 'text-blue-300',  label: 'Tworzenie GPU MachineSet w toku...'   },
    idle:     { dot: 'bg-slate-500',                txt: 'text-slate-400', label: 'Oczekiwanie...'                       },
  };

  const s = MAP[status] || MAP.running;
  indicator.className = `w-2.5 h-2.5 rounded-full ${s.dot}`;
  text.className      = `text-sm font-medium ${s.txt}`;
  text.textContent    = s.label;
}
