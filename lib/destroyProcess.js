'use strict';

const { spawn } = require('child_process');
const fs        = require('fs');
const path      = require('path');
const os        = require('os');

const stateStore  = require('./stateStore');
const logScrubber = require('./logScrubber');

// installId -> { process, credFilePath }
const activeDestroys = new Map();

/**
 * Starts the openshift-install destroy cluster subprocess and streams logs via Socket.io.
 *
 * @param {object} opts
 * @param {string} opts.installId
 * @param {string} opts.installDir
 * @param {string} opts.installerPath
 * @param {object} opts.credentials  - GCP service account credentials object
 * @param {object} io                - Socket.io server instance
 */
function start({ installId, installDir, installerPath, credentials }, io) {
  const credFilePath = path.join(installDir, '.sa-key-destroy.json');
  fs.writeFileSync(credFilePath, JSON.stringify(credentials), { mode: 0o600 });

  const room = `destroy:${installId}`;

  const proc = spawn(
    installerPath,
    ['destroy', 'cluster', '--dir', installDir, '--log-level', 'debug'],
    {
      env: {
        ...process.env,
        GOOGLE_APPLICATION_CREDENTIALS: credFilePath,
        HOME: os.homedir(),
      },
      cwd: installDir,
    }
  );

  function processLine(line) {
    if (!line.trim()) return;

    const scrubbed = logScrubber.scrub(line);
    let parsed = { level: 'info', msg: scrubbed, ts: Date.now() };
    try {
      const obj = JSON.parse(line);
      parsed = {
        level: obj.level || 'info',
        msg:   logScrubber.scrub(obj.msg || ''),
        ts:    obj.ts ? Math.floor(obj.ts * 1000) : Date.now(),
      };
    } catch (_) {}

    io.to(room).emit('destroy:line', {
      level:   parsed.level,
      message: parsed.msg,
      raw:     scrubbed,
      ts:      parsed.ts,
    });
  }

  let stderrBuf = '';
  proc.stderr.on('data', chunk => {
    stderrBuf += chunk.toString();
    const lines = stderrBuf.split('\n');
    stderrBuf = lines.pop();
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
    if (stderrBuf.trim()) processLine(stderrBuf);
    if (stdoutBuf.trim()) processLine(stdoutBuf);

    try { fs.unlinkSync(credFilePath); } catch (_) {}
    activeDestroys.delete(installId);

    if (code === 0) {
      stateStore.markDestroyed(installId);
      io.to(room).emit('destroy:complete', { installId });
    } else {
      io.to(room).emit('destroy:failed', { installId, exitCode: code });
    }
  });

  proc.on('error', (err) => {
    console.error(`[destroy] spawn error for ${installId}: ${err.message}`);
    try { fs.unlinkSync(credFilePath); } catch (_) {}
    activeDestroys.delete(installId);
    io.to(room).emit('destroy:failed', { installId, exitCode: -1, error: err.message });
  });

  activeDestroys.set(installId, { process: proc, credFilePath });
}

function isRunning(installId) {
  return activeDestroys.has(installId);
}

function hasAnyRunning() {
  return activeDestroys.size > 0;
}

module.exports = { start, isRunning, hasAnyRunning };
