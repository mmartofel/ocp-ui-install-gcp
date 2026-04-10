'use strict';

const GCP_REGIONS = [
  { value: 'us-central1',    label: 'us-central1 (Iowa)' },
  { value: 'us-east1',       label: 'us-east1 (South Carolina)' },
  { value: 'us-east4',       label: 'us-east4 (Northern Virginia)' },
  { value: 'us-west1',       label: 'us-west1 (Oregon)' },
  { value: 'us-west2',       label: 'us-west2 (Los Angeles)' },
  { value: 'europe-west1',   label: 'europe-west1 (Belgia)' },
  { value: 'europe-west2',   label: 'europe-west2 (Londyn)' },
  { value: 'europe-west3',   label: 'europe-west3 (Frankfurt)' },
  { value: 'europe-west4',   label: 'europe-west4 (Holandia)' },
  { value: 'europe-central2',label: 'europe-central2 (Warszawa)' },
  { value: 'asia-east1',     label: 'asia-east1 (Tajwan)' },
  { value: 'asia-northeast1',label: 'asia-northeast1 (Tokio)' },
  { value: 'asia-southeast1',label: 'asia-southeast1 (Singapur)' },
];

// Maszyny spełniające minimalne wymagania OpenShift (4 vCPU, 15 GB RAM)
const MACHINE_TYPES = [
  { value: 'n1-standard-4',  label: 'n1-standard-4  (4 vCPU, 15 GB)' },
  { value: 'n1-standard-8',  label: 'n1-standard-8  (8 vCPU, 30 GB)' },
  { value: 'n1-standard-16', label: 'n1-standard-16 (16 vCPU, 60 GB)' },
  { value: 'n2-standard-4',  label: 'n2-standard-4  (4 vCPU, 16 GB)' },
  { value: 'n2-standard-8',  label: 'n2-standard-8  (8 vCPU, 32 GB)' },
  { value: 'n2-standard-16', label: 'n2-standard-16 (16 vCPU, 64 GB)' },
  { value: 'n2-standard-32', label: 'n2-standard-32 (32 vCPU, 128 GB)' },
  { value: 'n2d-standard-4', label: 'n2d-standard-4 (4 vCPU, 16 GB, AMD)' },
  { value: 'n2d-standard-8', label: 'n2d-standard-8 (8 vCPU, 32 GB, AMD)' },
];

// Etapy instalacji do wykrywania z logów openshift-install
const INSTALL_STAGES = [
  { pattern: /Creating infrastructure resources/,                     stage: 'infrastructure',        pct: 5,  label: 'Tworzenie zasobów GCP' },
  { pattern: /Waiting up to \S+ for the Kubernetes API/,              stage: 'bootstrap',             pct: 20, label: 'Uruchamianie bootstrapa' },
  { pattern: /Waiting up to \S+ for bootstrapping to complete/,       stage: 'bootstrapping',         pct: 40, label: 'Bootstrap w toku' },
  { pattern: /Destroying the bootstrap resources/,                    stage: 'removing-bootstrap',    pct: 60, label: 'Usuwanie bootstrapa' },
  { pattern: /Waiting up to \S+ for the cluster at/,                  stage: 'cluster-operators',     pct: 75, label: 'Operatory klastra' },
  { pattern: /Waiting up to \S+ for the openshift-console route/,     stage: 'console',               pct: 90, label: 'Konsola OpenShift' },
  { pattern: /Install complete!/,                                      stage: 'complete',              pct: 100, label: 'Instalacja zakończona' },
];

// Wymagane role GCP dla konta serwisowego
const REQUIRED_GCP_ROLES = [
  'roles/compute.admin',
  'roles/dns.admin',
  'roles/iam.securityAdmin',
  'roles/iam.serviceAccountAdmin',
  'roles/iam.serviceAccountUser',
  'roles/storage.admin',
  'roles/deploymentmanager.editor',
];

const MARKETPLACE_SKUS = [
  { value: 'redhat-coreos-oke-413-x86-64-202305021736', label: 'OKE – OpenShift Kubernetes Engine' },
  { value: 'redhat-coreos-ocp-413-x86-64-202305021736', label: 'OCP – OpenShift Container Platform' },
  { value: 'redhat-coreos-opp-413-x86-64-202305021736', label: 'OPP – OpenShift Platform Plus' },
];

const NETWORK_TYPES = [
  { value: 'OVNKubernetes', label: 'OVN-Kubernetes (zalecane)' },
  { value: 'OpenShiftSDN',  label: 'OpenShift SDN (legacy)' },
];

// Dostępne kanały OCP (allowlist — rozszerzyć przy nowych wydaniach)
const OCP_CHANNELS = [
  // Stable
  { value: 'stable-4.21', label: 'stable-4.21' },
  { value: 'stable-4.20', label: 'stable-4.20' },
  { value: 'stable-4.19', label: 'stable-4.19' },
  // EUS (Extended Update Support — tylko parzyste wersje minor)
  { value: 'eus-4.20', label: 'eus-4.20' },
  { value: 'eus-4.18', label: 'eus-4.18' },
  // Candidate (pre-release)
  { value: 'candidate-4.22', label: 'candidate-4.22 ⚠ pre-release' },
  { value: 'candidate-4.21', label: 'candidate-4.21 ⚠ pre-release' },
];

// Kanał domyślny — aktualny stable. Zmień przy kolejnym wydaniu.
const OCP_DEFAULT_CHANNEL = 'stable-4.21';

module.exports = { GCP_REGIONS, MACHINE_TYPES, INSTALL_STAGES, REQUIRED_GCP_ROLES, NETWORK_TYPES, OCP_CHANNELS, OCP_DEFAULT_CHANNEL, MARKETPLACE_SKUS };
