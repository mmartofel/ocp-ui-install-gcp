'use strict';

const SCRUB_PATTERNS = [
  // GCP service account private key
  { pattern: /"private_key"\s*:\s*"[^"]{20,}"/g,      replace: '"private_key": "[REDACTED]"' },
  // GCP OAuth access tokens (ya29.xxx)
  { pattern: /ya29\.[A-Za-z0-9_\-.]{20,}/g,            replace: '[GCP_TOKEN_REDACTED]' },
  // OpenShift pull secret auth blocks
  { pattern: /"auths"\s*:\s*\{[\s\S]*?\}/g,             replace: '"auths": {"[REDACTED]": {}}' },
  // Generic password fields
  { pattern: /"(password|passwd|secret|token)"\s*:\s*"[^"]{4,}"/gi, replace: '"$1": "[REDACTED]"' },
  // Bearer tokens in HTTP headers
  { pattern: /Bearer\s+[A-Za-z0-9_\-.]{20,}/g,          replace: 'Bearer [REDACTED]' },
  // SSH private key content
  { pattern: /-----BEGIN [A-Z ]+ PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+ PRIVATE KEY-----/g, replace: '[SSH_KEY_REDACTED]' },
];

function scrub(line) {
  let result = line;
  for (const { pattern, replace } of SCRUB_PATTERNS) {
    result = result.replace(pattern, replace);
  }
  return result;
}

module.exports = { scrub };
