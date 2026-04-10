# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install
npm run dev                 # Development (nodemon, auto-reload)
npm start                   # Production
```

The server exits immediately on startup if:
- `data/installer/openshift-install` binary is missing or not executable
- `SESSION_SECRET` is not set in `.env`

## Architecture

**Node.js/Express backend + EJS views + Socket.io for real-time log streaming.**

The app is a 4-step wizard: GCP login → cluster config → installation → status dashboard.

### Key data flows

**GCP credentials** — uploaded as service account JSON via `POST /auth/credentials` → verified live against GCP API in `lib/gcpValidator.js` → stored *only* in a process-memory Map in `lib/credentialStore.js` (TTL 4h, never written to disk until the installer runs).

**Installation** — `POST /install/start` writes `install-config.yaml` to `tmp/install-<uuid>/`, writes the SA key as a 0600 tempfile, spawns `openshift-install create cluster --dir ... --log-level debug` via `lib/installerProcess.js`. The process writes JSON-structured log lines to stderr. Each line is scrubbed by `lib/logScrubber.js`, persisted to SQLite via `lib/stateStore.js`, and broadcast to the client via Socket.io room `install:<installId>`. The SA key tempfile is deleted immediately on process exit regardless of outcome.

**Log replay on reconnect** — all log lines are stored in `install_logs` SQLite table with line numbers. When a client reconnects it emits `install:request_replay` with `fromLine`, and the server sends the missed lines in bulk.

**Progress detection** — `openshift-install` emits no explicit percentage. Stage/progress is derived from regex patterns on log messages defined in `config/defaults.js` → `INSTALL_STAGES`.

**Cluster status** — after a successful install, `lib/clusterStatusPoller.js` polls every 60s using the kubeconfig at `tmp/install-<uuid>/auth/kubeconfig` via `@kubernetes/client-node`. It reads `CoreV1Api` for nodes and the OpenShift `config.openshift.io/v1/clusteroperators` custom resource.

### File map

| Path | Role |
|------|------|
| `server.js` | Entry point: binary check, SQLite init, Express + Socket.io bootstrap |
| `lib/installerProcess.js` | Spawns and manages `openshift-install` subprocess; streams stderr to Socket.io |
| `lib/stateStore.js` | All SQLite operations: installs, log lines, cluster status snapshots |
| `lib/credentialStore.js` | In-memory GCP credential vault, session-scoped with 4h TTL |
| `lib/installConfigBuilder.js` | Builds `install-config.yaml` YAML from validated form data |
| `lib/gcpValidator.js` | Live GCP API calls: credential verification, DNS zone check, region list |
| `lib/logScrubber.js` | Strips SA private keys, OAuth tokens, pull secrets from log lines |
| `lib/clusterStatusPoller.js` | Post-install k8s polling: nodes + ClusterOperators |
| `sockets/installSocket.js` | Socket.io event handlers (join room, replay, status) |
| `config/defaults.js` | GCP region/machine type lists, INSTALL_STAGES regex patterns |
| `routes/` | Express route handlers (auth, config, install, status, download) |
| `views/` | EJS templates (layout + 4 pages). Tailwind CSS via CDN. |
| `public/js/` | Per-page client JS: auth form, config form, Socket.io log client, status dashboard |

### SQLite schema

Three tables: `installs` (one row per install run), `install_logs` (all log lines for replay), `cluster_status` (periodic k8s health snapshots). DB lives at `data/db/state.sqlite`.

### Security constraints

- Never use `exec()` with string interpolation for the installer — `spawn()` with array args only (prevents shell injection from form fields)
- The SA key JSON is only written to disk as a `0600` file inside the install temp dir, deleted immediately on process exit
- Pull secret and SSH key are never stored to SQLite — only held in `req.session.installConfig` (session store)
- Each install gets an isolated `tmp/install-<uuid>/` directory with `0700` permissions
- `/download/kubeconfig` verifies `install.session_id === req.session.id` before serving

### openshift-install binary

Must be placed at `data/installer/openshift-install` (or path set via `INSTALLER_PATH` env var).
Download from: https://console.redhat.com/openshift/install/gcp/installer-provisioned

The binary requires a Cloud DNS managed zone in the GCP project matching `baseDomain`. The install directory contains `install-config.yaml` which the installer copies and modifies — the original copy is consumed on first run.

### Ask questions

If you have any questions about the code, architecture, or how to extend it, please ask!
Every time if you are unsure about something, ask for clarification before proceeding.