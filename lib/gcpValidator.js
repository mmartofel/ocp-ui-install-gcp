'use strict';

const { GoogleAuth } = require('google-auth-library');
const { google } = require('googleapis');

/**
 * Validates GCP service account credentials and returns project info.
 * Throws on auth failure.
 */
async function verifyCredentials(credentialsObj) {
  const auth = new GoogleAuth({
    credentials: credentialsObj,
    scopes: ['https://www.googleapis.com/auth/cloud-platform'],
  });

  const client = await auth.getClient();

  // Verify credentials are valid by obtaining an access token — no extra IAM permissions required
  await client.getAccessToken();

  return {
    projectId:   credentialsObj.project_id,
    projectName: credentialsObj.project_id,
    clientEmail: credentialsObj.client_email,
  };
}

/**
 * Checks if a Cloud DNS managed zone exists for the given base domain.
 */
async function verifyDnsZone(credentialsObj, projectId, baseDomain) {
  const auth = new GoogleAuth({
    credentials: credentialsObj,
    scopes: ['https://www.googleapis.com/auth/cloud-platform'],
  });
  const client = await auth.getClient();
  const dns = google.dns({ version: 'v1', auth: client });

  const resp = await dns.managedZones.list({ project: projectId });
  const zones = resp.data.managedZones || [];

  // baseDomain must end with a dot in GCP DNS format
  const domainWithDot = baseDomain.endsWith('.') ? baseDomain : baseDomain + '.';
  const found = zones.find(z => z.dnsName === domainWithDot);

  return {
    exists: !!found,
    zone: found || null,
    zones: zones.map(z => ({ name: z.name, dnsName: z.dnsName })),
  };
}

/**
 * Lists available regions for a GCP project.
 */
async function listRegions(credentialsObj, projectId) {
  const auth = new GoogleAuth({
    credentials: credentialsObj,
    scopes: ['https://www.googleapis.com/auth/compute'],
  });
  const client = await auth.getClient();
  const compute = google.compute({ version: 'v1', auth: client });

  const resp = await compute.regions.list({ project: projectId });
  return (resp.data.items || []).map(r => ({
    value: r.name,
    label: `${r.name} (${r.description || r.name})`,
    status: r.status,
  }));
}

/**
 * Lists public Cloud DNS managed zones for a GCP project.
 */
async function listPublicDnsZones(credentialsObj, projectId) {
  const auth = new GoogleAuth({
    credentials: credentialsObj,
    scopes: ['https://www.googleapis.com/auth/cloud-platform'],
  });
  const client = await auth.getClient();
  const dns    = google.dns({ version: 'v1', auth: client });

  const resp  = await dns.managedZones.list({ project: projectId });
  const zones = resp.data.managedZones || [];

  return zones
    .filter(z => !z.visibility || z.visibility === 'public')
    .map(z => ({ name: z.name, dnsName: z.dnsName }));
}

module.exports = { verifyCredentials, verifyDnsZone, listPublicDnsZones, listRegions };
