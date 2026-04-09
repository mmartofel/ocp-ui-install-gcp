'use strict';

const stateStore     = require('../lib/stateStore');
const destroyProcess = require('../lib/destroyProcess');

function attachSocketHandlers(io) {
  io.on('connection', (socket) => {

    // Client joins destroy room
    socket.on('destroy:join', ({ installId }) => {
      if (!installId) return;
      socket.join(`destroy:${installId}`);

      // If destroy already completed, notify immediately
      const install = stateStore.getInstall(installId);
      if (install && install.destroyed_at) {
        socket.emit('destroy:complete', { installId });
      } else if (install && !destroyProcess.isRunning(installId)) {
        // Destroy not started yet or process info lost (server restart)
        // Do nothing — client will wait for server-sent events
      }
    });

    // Client joins the room for a specific install session
    socket.on('install:join', ({ installId }) => {
      if (!installId) return;
      const room = `install:${installId}`;
      socket.join(room);

      // Send current install status immediately
      const install = stateStore.getInstall(installId);
      if (install) {
        socket.emit('install:status', { status: install.status });

        // If install is complete or failed, send the final event
        if (install.status === 'complete') {
          socket.emit('install:complete', { installId });
        } else if (install.status === 'failed' || install.status === 'aborted') {
          socket.emit('install:failed', { installId, exitCode: install.exit_code });
        }
      }
    });

    // Client reconnected and requests missed log lines
    socket.on('install:request_replay', ({ installId, fromLine }) => {
      if (!installId) return;

      const lines  = stateStore.getLogs(installId, fromLine || 0);
      const total  = stateStore.getLogCount(installId);
      socket.emit('install:replay', { lines, total });
    });
  });
}

module.exports = { attachSocketHandlers };
