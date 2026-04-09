'use strict';

require('dotenv').config();

const express      = require('express');
const http         = require('http');
const { Server }   = require('socket.io');
const path         = require('path');
const session      = require('express-session');
const helmet       = require('helmet');
const rateLimit    = require('express-rate-limit');
const fs           = require('fs');
const { execSync } = require('child_process');

const stateStore       = require('./lib/stateStore');
const installerProcess = require('./lib/installerProcess');
const { attachSocketHandlers } = require('./sockets/installSocket');

const INSTALLER_PATH = path.resolve(
  process.env.INSTALLER_PATH || path.join(__dirname, 'data', 'installer', 'openshift-install')
);

const PORT = parseInt(process.env.PORT || '3000', 10);

async function main() {
  // ── 1. Check openshift-install binary ───────────────────────────────────────
  try {
    fs.accessSync(INSTALLER_PATH, fs.constants.X_OK);
  } catch (_) {
    console.error('\n[ERROR] Binarka openshift-install nie znaleziona lub nie jest wykonywalna.');
    console.error(`        Oczekiwana lokalizacja: ${INSTALLER_PATH}`);
    console.error('        Pobierz z: https://console.redhat.com/openshift/install/gcp/installer-provisioned');
    console.error(`        i umieść w: ${path.dirname(INSTALLER_PATH)}\n`);
    process.exit(1);
  }

  let installerVersion = 'unknown';
  try {
    const out = execSync(`"${INSTALLER_PATH}" version 2>&1`, { timeout: 5000 }).toString();
    const m   = out.match(/openshift-install ([\d.]+)/);
    installerVersion = m ? m[1] : 'unknown';
  } catch (_) {}

  // ── 2. Initialize SQLite ─────────────────────────────────────────────────────
  stateStore.initialize();

  // ── 3. Express app ───────────────────────────────────────────────────────────
  const app    = express();
  const server = http.createServer(app);

  // ── 4. Security ──────────────────────────────────────────────────────────────
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc:    ["'self'"],
        scriptSrc:     ["'self'", "'unsafe-inline'", 'cdn.tailwindcss.com'],
        scriptSrcAttr: ["'unsafe-inline'"],
        styleSrc:      ["'self'", "'unsafe-inline'", 'cdn.tailwindcss.com', 'fonts.googleapis.com'],
        fontSrc:       ["'self'", 'fonts.gstatic.com'],
        connectSrc:    ["'self'", 'ws:', 'wss:'],
        imgSrc:        ["'self'", 'data:'],
      },
    },
  }));

  if (!process.env.SESSION_SECRET) {
    console.error('\n[ERROR] SESSION_SECRET nie jest ustawiony. Skopiuj .env.example do .env i wypełnij.\n');
    process.exit(1);
  }

  app.use(session({
    secret:            process.env.SESSION_SECRET,
    resave:            false,
    saveUninitialized: false,
    cookie: {
      secure:   process.env.NODE_ENV === 'production',
      httpOnly: true,
      sameSite: 'strict',
      maxAge:   24 * 60 * 60 * 1000,
    },
  }));

  // ── 5. Middleware ─────────────────────────────────────────────────────────────
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));

  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));

  app.use(express.static(path.join(__dirname, 'public')));

  app.locals.installerVersion = installerVersion;

  // ── 6. Rate limiting ──────────────────────────────────────────────────────────
  const authLimiter = rateLimit({
    windowMs: 60 * 1000,
    max:      10,
    message:  { error: 'Zbyt wiele prób. Spróbuj ponownie za minutę.' },
  });

  // ── 7. Routes ─────────────────────────────────────────────────────────────────
  app.get('/', (req, res) => {
    if (!credentialStore.has(req.session.id)) return res.redirect('/auth');
    if (!req.session.installConfig)            return res.redirect('/config');
    if (req.session.installId) {
      const install = stateStore.getInstall(req.session.installId);
      if (install?.status === 'running')       return res.redirect('/install');
      if (install?.status === 'complete')      return res.redirect('/status');
    }
    return res.redirect('/config');
  });

  const credentialStore = require('./lib/credentialStore');
  const destroyProcess  = require('./lib/destroyProcess');
  // Make credentialStore available via req; expose running-install/destroy flags for nav templates
  app.use((req, res, next) => {
    req.credentialStore = credentialStore;
    if (req.session?.id) {
      res.locals.isAuthenticated   = credentialStore.has(req.session.id);
      const activeInstall = stateStore.getActiveInstall(req.session.id);
      res.locals.hasRunningInstall = !!(activeInstall && activeInstall.status === 'running');
    } else {
      res.locals.isAuthenticated   = false;
      res.locals.hasRunningInstall = false;
    }
    res.locals.hasRunningDestroy = destroyProcess.hasAnyRunning();
    next();
  });

  app.use('/auth',     authLimiter, require('./routes/auth'));
  app.use('/config',               require('./routes/config'));
  app.use('/install',              require('./routes/install'));
  app.use('/status',               require('./routes/status'));
  app.use('/destroy',              require('./routes/destroy'));
  app.use('/download',             require('./routes/download'));

  // ── 8. Socket.io ──────────────────────────────────────────────────────────────
  const io = new Server(server, { cors: { origin: false } });
  app.set('io', io);
  attachSocketHandlers(io);

  // ── 9. Handle orphaned installs from previous server run ──────────────────────
  await installerProcess.resumeOrphanedInstalls(io);

  // ── 10. Start ─────────────────────────────────────────────────────────────────
  server.listen(PORT, () => {
    console.log(`\n┌───────────────────────────────────────────────────────────┐`);
    console.log(`│   Red Hat OpenShift Installer for Google Cloud Platform   │`);
    console.log(`│   http://localhost:${PORT.toString().padEnd(4)}                                   │`);
    console.log(`│   openshift-install ${installerVersion.padEnd(10)}                            │`);
    console.log(`└───────────────────────────────────────────────────────────┘\n`);
  });
}

main().catch(err => {
  console.error('Krytyczny błąd podczas startu:', err);
  process.exit(1);
});
