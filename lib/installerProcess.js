'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const stateStore = require('./stateStore');
const logScrubber = require('./logScrubber');
const { INSTALL_STAGES } = require('../config/defaults');

// installId -> { process, credFilePath, lineCounter }
const activeProcesses = new Map();

/**
 * Starts the openshift-install child process and streams logs via Socket.io.
 *
 * @param {object} opts
 * @param {string} opts.installId
 * @param {string} opts.installDir     - directory containing install-config.yaml
 * @param {string} opts.installerPath
 * @param {object} opts.credentials    - GCP service account credentials object
 * @param {object} io                  - Socket.io server instance
 */
function start({ installId, installDir, installerPath, credentials, ocpVersion }, io) {
  // Write SA key to tempfile inside install dir (mode 600, deleted on exit)
  const credFilePath = path.join(installDir, '.sa-key.json');
  fs.writeFileSync(credFilePath, JSON.stringify(credentials), { mode: 0o600 });

  stateStore.setInstallRunning(installId);

  const env = {
    ...process.env,
    GOOGLE_APPLICATION_CREDENTIALS: credFilePath,
    HOME: os.homedir(),
  };

  // Override release image when a specific OCP version was requested (x86_64 only)
  if (ocpVersion && typeof ocpVersion === 'string' && ocpVersion.trim()) {
    env.OPENSHIFT_INSTALL_RELEASE_IMAGE_OVERRIDE =
      `quay.io/openshift-release-dev/ocp-release:${ocpVersion.trim()}-x86_64`;
  }

  const proc = spawn(
    installerPath,
    ['create', 'cluster', '--dir', installDir, '--log-level', 'debug'],
    { env, cwd: installDir }
  );

  let lineCounter = 0;
  let currentStage = null;
  let currentPct   = 0;

  const room = `install:${installId}`;

  function processLine(line) {
    if (!line.trim()) return;

    const scrubbed = logScrubber.scrub(line);
    lineCounter++;

    // Parse JSON log line from openshift-install
    let parsed = { level: 'info', msg: scrubbed, ts: Date.now() };
    try {
      const obj = JSON.parse(line);
      parsed = {
        level: obj.level || 'info',
        msg:   logScrubber.scrub(obj.msg || ''),
        ts:    obj.ts ? Math.floor(obj.ts * 1000) : Date.now(),
      };
    } catch (_) {
      // not JSON, treat as plain text
    }

    // Detect installation stage from message
    for (const s of INSTALL_STAGES) {
      if (s.pattern.test(parsed.msg) && s.pct > currentPct) {
        currentStage = s.stage;
        currentPct   = s.pct;
        io.to(room).emit('install:progress', { stage: s.label, pct: s.pct });
      }
    }

    const logEntry = {
      lineNumber: lineCounter,
      level:      parsed.level,
      message:    parsed.msg,
      raw:        scrubbed,
      stage:      currentStage,
      ts:         parsed.ts,
    };

    stateStore.appendLog({
      installId,
      lineNumber: lineCounter,
      level:      parsed.level,
      message:    parsed.msg,
      raw:        scrubbed,
      stage:      currentStage,
      ts:         parsed.ts,
    });

    io.to(room).emit('log:line', logEntry);
  }

  // openshift-install writes structured logs to stderr
  let stderrBuf = '';
  proc.stderr.on('data', chunk => {
    stderrBuf += chunk.toString();
    const lines = stderrBuf.split('\n');
    stderrBuf = lines.pop(); // keep incomplete last line
    lines.forEach(processLine);
  });

  let stdoutBuf = '';
  proc.stdout.on('data', chunk => {
    stdoutBuf += chunk.toString();
    const lines = stdoutBuf.split('\n');
    stdoutBuf = lines.pop();
    lines.forEach(processLine);
  });

  proc.on('exit', (code) => {
    // Flush remaining buffer content
    if (stderrBuf.trim()) processLine(stderrBuf);
    if (stdoutBuf.trim()) processLine(stdoutBuf);

    // Delete SA key tempfile immediately
    try { fs.unlinkSync(credFilePath); } catch (_) {}

    activeProcesses.delete(installId);

    if (code === 0) {
      stateStore.setInstallStatus(installId, 'complete', 0);

      // Read console/api URLs from install state
      const urls = readInstallUrls(installDir);
      io.to(room).emit('install:complete', { installId, ...urls });
    } else {
      const status = code === null ? 'aborted' : 'failed';
      stateStore.setInstallStatus(installId, status, code);
      io.to(room).emit('install:failed', { installId, exitCode: code });
    }
  });

  proc.on('error', (err) => {
    console.error(`[installer] spawn error for ${installId}: ${err.message} (code: ${err.code})`);
    try { fs.unlinkSync(credFilePath); } catch (_) {}
    activeProcesses.delete(installId);
    stateStore.setInstallStatus(installId, 'failed', -1);
    // Persist error message so it's visible after page reload
    stateStore.appendLog({
      installId,
      lineNumber: 1,
      level:   'error',
      message: `Nie można uruchomić instalatora: ${err.message} (${err.code})`,
      raw:     err.message,
      stage:   null,
      ts:      Date.now(),
    });
    io.to(room).emit('log:line', { lineNumber: 1, level: 'error', message: `Nie można uruchomić instalatora: ${err.message} (${err.code})`, ts: Date.now() });
    io.to(room).emit('install:failed', { installId, exitCode: -1, error: err.message });
  });

  activeProcesses.set(installId, { process: proc, credFilePath, lineCounter: () => lineCounter });
}

function abort(installId) {
  const entry = activeProcesses.get(installId);
  if (!entry) return false;

  entry.process.kill('SIGTERM');

  // Escalate after 30s
  setTimeout(() => {
    if (activeProcesses.has(installId)) {
      entry.process.kill('SIGKILL');
    }
  }, 30000);

  return true;
}

function isRunning(installId) {
  return activeProcesses.has(installId);
}

/**
 * Checks if an install actually succeeded by looking for auth/kubeconfig.
 * Marks it 'complete' or 'failed' accordingly and notifies connected clients.
 */
function _recoverOrFail(io, install) {
  const kubeconfigPath = path.join(install.install_dir, 'auth', 'kubeconfig');
  if (fs.existsSync(kubeconfigPath)) {
    const urls = readInstallUrls(install.install_dir);
    stateStore.setInstallStatus(install.install_id, 'complete', 0);
    io.to(`install:${install.install_id}`).emit('install:complete', {
      installId: install.install_id, ...urls,
    });
  } else {
    stateStore.setInstallStatus(install.install_id, 'failed', -1);
    io.to(`install:${install.install_id}`).emit('install:failed', {
      installId: install.install_id,
      exitCode: -1,
      error: 'Serwer został zrestartowany podczas instalacji. Sprawdź logi w katalogu instalacji.',
    });
  }
}

/**
 * On server start: recover installs that were 'running' or previously false-failed
 * (exit_code = -1 means server restart, not a real installer failure).
 * If auth/kubeconfig exists the install succeeded — mark it complete.
 */
async function resumeOrphanedInstalls(io) {
  for (const install of stateStore.getRunningInstalls()) {
    _recoverOrFail(io, install);
  }
  for (const install of stateStore.getServerRestartFailed()) {
    _recoverOrFail(io, install);
  }
}

function readInstallUrls(installDir) {
  // openshift-install writes these to stdout on completion and to metadata files
  try {
    const metaPath = path.join(installDir, 'metadata.json');
    if (fs.existsSync(metaPath)) {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      const clusterName = meta.clusterName || '';
      const domain      = meta.gcp?.rootZone || '';
      if (clusterName && domain) {
        return {
          consoleUrl: `https://console-openshift-console.apps.${clusterName}.${domain}`,
          apiUrl:     `https://api.${clusterName}.${domain}:6443`,
        };
      }
    }
  } catch (_) {}
  return { consoleUrl: null, apiUrl: null };
}

module.exports = { start, abort, isRunning, resumeOrphanedInstalls };
