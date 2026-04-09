'use strict';

const express  = require('express');
const router   = express.Router();
const multer   = require('multer');
const upload   = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 } });

const credentialStore = require('../lib/credentialStore');
const gcpValidator    = require('../lib/gcpValidator');
const stateStore      = require('../lib/stateStore');

// GET /auth
router.get('/', (req, res) => {
  const warning = req.query.warning || null;

  // Pass current session info so the view can show it without JS
  let sessionInfo = null;
  const entry = credentialStore.get(req.session.id);
  if (entry) {
    sessionInfo = {
      projectId:   entry.projectId,
      clientEmail: entry.clientEmail,
    };
  }

  res.render('auth', { title: 'Logowanie do GCP', warning, sessionInfo });
});

// POST /auth/credentials  (JSON body or file upload)
router.post('/credentials', upload.single('credentialsFile'), async (req, res) => {
  try {
    let rawJson;

    if (req.file) {
      rawJson = req.file.buffer.toString('utf8');
    } else if (req.body.credentialsJson) {
      rawJson = req.body.credentialsJson;
    } else {
      return res.status(400).json({ error: 'Brak pliku credentials lub JSON.' });
    }

    // Parse and validate structure
    let credObj;
    try {
      credObj = JSON.parse(rawJson);
    } catch (_) {
      return res.status(400).json({ error: 'Nieprawidłowy format JSON.' });
    }

    const required = ['type', 'project_id', 'private_key', 'client_email'];
    const missing  = required.filter(k => !credObj[k]);
    if (missing.length > 0) {
      return res.status(400).json({ error: `Brakujące pola w credentials: ${missing.join(', ')}` });
    }
    if (credObj.type !== 'service_account') {
      return res.status(400).json({ error: 'Wymagane credentials typu service_account.' });
    }

    // Verify with GCP API
    let projectInfo;
    try {
      projectInfo = await gcpValidator.verifyCredentials(credObj);
    } catch (err) {
      const msg = err.message || '';
      if (msg.includes('401') || msg.includes('403')) {
        return res.status(401).json({ error: 'Błąd autoryzacji GCP. Sprawdź czy konto serwisowe jest aktywne.' });
      }
      return res.status(400).json({ error: `Błąd weryfikacji GCP: ${err.message}` });
    }

    // Store in memory
    credentialStore.set(req.session.id, credObj);
    req.session.projectInfo = projectInfo;

    // Session recovery: link to existing completed install for this project
    const existingInstall = stateStore.getLatestCompleteByProject(credObj.project_id);
    if (existingInstall) {
      req.session.installId = existingInstall.install_id;
    }

    return res.json({
      success:     true,
      projectId:   projectInfo.projectId,
      projectName: projectInfo.projectName,
      clientEmail: projectInfo.clientEmail,
      redirect:    existingInstall ? '/status' : '/config',
    });

  } catch (err) {
    console.error('Auth error:', err);
    return res.status(500).json({ error: 'Wewnętrzny błąd serwera.' });
  }
});

// POST /auth/logout
router.post('/logout', (req, res) => {
  credentialStore.remove(req.session.id);
  req.session.destroy(() => {
    res.redirect('/auth');
  });
});

module.exports = router;
