'use strict';

const express  = require('express');
const router   = express.Router();
const Joi      = require('joi');
const validator= require('validator');
const fs       = require('fs');
const path     = require('path');
const { exec } = require('child_process');

const credentialStore     = require('../lib/credentialStore');
const gcpValidator        = require('../lib/gcpValidator');
const installConfigBuilder= require('../lib/installConfigBuilder');
const { GCP_REGIONS, MACHINE_TYPES, NETWORK_TYPES } = require('../config/defaults');

function requireAuth(req, res, next) {
  if (!credentialStore.has(req.session.id)) {
    return res.redirect('/auth?warning=session_expired');
  }
  next();
}

// For AJAX/fetch routes — return JSON 401 instead of HTML redirect
function requireAuthApi(req, res, next) {
  if (!credentialStore.has(req.session.id)) {
    return res.status(401).json({ error: 'session_expired' });
  }
  next();
}

// Runs a shell command and resolves with stdout, or '' on any error
function execPromise(cmd, timeoutMs = 5000) {
  return new Promise(resolve => {
    exec(cmd, { timeout: timeoutMs }, (err, stdout) => resolve(err ? '' : stdout.trim()));
  });
}

// Pre-load optional defaults from local files (read once per request, errors silently ignored)
const ROOT = path.join(__dirname, '..');
function readFileSafe(filePath) {
  try { return fs.readFileSync(filePath, 'utf8').trim(); } catch (_) { return ''; }
}

// GET /config
router.get('/', requireAuth, (req, res) => {
  const projectId = credentialStore.getProjectId(req.session.id);

  const pullSecretDefault = readFileSafe(path.join(ROOT, 'pull-secret.txt'));
  const sshKeyDefault     = readFileSafe(path.join(ROOT, 'ssh', 'id_rsa.pub'));

  res.render('config', {
    title:        'Konfiguracja klastra',
    projectId,
    regions:      GCP_REGIONS,
    machineTypes: MACHINE_TYPES,
    networkTypes: NETWORK_TYPES,
    saved:        req.session.installConfig || {},
    pullSecretDefault,
    sshKeyDefault,
  });
});

// POST /config/validate-dns
router.post('/validate-dns', requireAuthApi, async (req, res) => {
  try {
    const { baseDomain, gcpProject } = req.body;
    if (!baseDomain) return res.status(400).json({ error: 'baseDomain wymagany' });

    const creds       = credentialStore.getCredentials(req.session.id);
    const saProjectId = credentialStore.getProjectId(req.session.id);
    // Prefer the project entered in the form (may differ from the SA's own project)
    const projectId   = (gcpProject && /^[a-z0-9-]+$/.test(gcpProject.trim()))
      ? gcpProject.trim()
      : saProjectId;
    const result      = await gcpValidator.verifyDnsZone(creds, projectId, baseDomain);

    return res.json(result);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// GET /config/autodetect  - detect project, base domain, and regions automatically
router.get('/autodetect', requireAuthApi, async (req, res) => {
  try {
    const creds     = credentialStore.getCredentials(req.session.id);
    const saProject = credentialStore.getProjectId(req.session.id);

    // Try to get active gcloud project; fall back to SA's own project
    const gcloudProject = await execPromise('gcloud config get-value project');
    const gcpProject    = gcloudProject || saProject;

    // Fetch DNS zones and regions in parallel
    const [zones, regions] = await Promise.all([
      gcpValidator.listPublicDnsZones(creds, gcpProject).catch(() => []),
      gcpValidator.listRegions(creds, gcpProject).catch(() => GCP_REGIONS),
    ]);

    // First public DNS zone → suggested baseDomain (strip trailing dot)
    const baseDomain = zones.length > 0
      ? zones[0].dnsName.replace(/\.$/, '')
      : '';

    // First region in the live list as default
    const region = regions.length > 0 ? regions[0].value : '';

    return res.json({ gcpProject, baseDomain, region, regions });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// GET /config/regions  - returns live GCP regions for this project
router.get('/regions', requireAuth, async (req, res) => {
  try {
    const creds     = credentialStore.getCredentials(req.session.id);
    const projectId = credentialStore.getProjectId(req.session.id);
    const regions   = await gcpValidator.listRegions(creds, projectId);
    return res.json({ regions });
  } catch (_) {
    // Fall back to static list on error
    return res.json({ regions: GCP_REGIONS });
  }
});

const configSchema = Joi.object({
  clusterName: Joi.string().alphanum().min(3).max(20).required(),
  baseDomain:  Joi.string().hostname().required(),
  gcpProject:  Joi.string().pattern(/^[a-z0-9-]+$/).min(3).max(63).required(),
  region:      Joi.string().pattern(/^[a-z]+-[a-z]+\d+$/).required(),
  masterType:  Joi.string().pattern(/^[a-z0-9-]+$/).required(),
  workerType:  Joi.string().pattern(/^[a-z0-9-]+$/).required(),
  workerCount: Joi.number().integer().min(2).max(20).required(),
  pullSecret:  Joi.string().min(100).required(),
  sshKey:      Joi.string().pattern(/^(ssh-rsa|ssh-ed25519|ecdsa-sha2)/).required(),
  networkType: Joi.string().valid('OVNKubernetes', 'OpenShiftSDN').default('OVNKubernetes'),
  podCidr:     Joi.string().ip({ cidr: 'required' }).default('10.128.0.0/14'),
  serviceCidr: Joi.string().ip({ cidr: 'required' }).default('172.30.0.0/16'),
  machineCidr: Joi.string().ip({ cidr: 'required' }).default('10.0.0.0/16'),
  fips:        Joi.boolean().default(false),
});

// POST /config  - save config and show YAML preview
router.post('/', requireAuthApi, (req, res) => {
  const { error, value } = configSchema.validate(req.body, { abortEarly: false });
  if (error) {
    const errors = error.details.map(d => d.message);
    return res.status(400).json({ errors });
  }

  // Sanitize string fields
  value.clusterName = validator.escape(value.clusterName);

  // Build YAML preview
  const yamlPreview = installConfigBuilder.build(value);

  // Save to session (pull secret stored separately since it's large)
  req.session.installConfig = value;

  return res.json({ success: true, yamlPreview });
});

module.exports = router;
