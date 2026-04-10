'use strict';

const yaml = require('js-yaml');

/**
 * Builds the install-config.yaml content string from validated form data.
 *
 * @param {object} params
 * @param {string} params.clusterName
 * @param {string} params.baseDomain
 * @param {string} params.gcpProject
 * @param {string} params.region
 * @param {string} params.masterType
 * @param {string} params.workerType
 * @param {number} params.workerCount
 * @param {string} params.pullSecret  - full pull secret JSON string
 * @param {string} params.sshKey      - SSH public key string
 * @param {string} params.networkType - OVNKubernetes or OpenShiftSDN
 * @param {string} params.podCidr     - default 10.128.0.0/14
 * @param {string} params.serviceCidr - default 172.30.0.0/16
 * @param {string} params.machineCidr - default 10.0.0.0/16
 * @param {boolean} params.fips
 * @param {string} params.offerType   - 'bring-your-own-subscription' or 'marketplace'
 * @param {string} params.ocpSku      - marketplace image name (required when offerType is 'marketplace')
 * @returns {string} YAML string
 */
function build(params) {
  const {
    clusterName,
    baseDomain,
    gcpProject,
    region,
    masterType = 'n2-standard-4',
    workerType  = 'n2-standard-4',
    workerCount = 3,
    pullSecret,
    sshKey,
    networkType  = 'OVNKubernetes',
    podCidr      = '10.128.0.0/14',
    serviceCidr  = '172.30.0.0/16',
    machineCidr  = '10.0.0.0/16',
    fips         = false,
    offerType    = 'bring-your-own-subscription',
    ocpSku       = '',
  } = params;

  const config = {
    apiVersion: 'v1',
    baseDomain,
    metadata: { name: clusterName },
    platform: {
      gcp: {
        projectID: gcpProject,
        region,
      },
    },
    pullSecret,
    sshKey,
    controlPlane: {
      hyperthreading: 'Enabled',
      name: 'master',
      platform: {
        gcp: { type: masterType },
      },
      replicas: 3,
    },
    compute: [
      {
        hyperthreading: 'Enabled',
        name: 'worker',
        platform: {
          gcp: { type: workerType },
        },
        replicas: Number(workerCount),
      },
    ],
  };

  if (offerType === 'marketplace' && ocpSku) {
    config.compute[0].platform.gcp.osImage = {
      project: 'redhat-marketplace-public',
      name: ocpSku,
    };
  }

  config.networking = {
    networkType,
    clusterNetwork: [{ cidr: podCidr, hostPrefix: 23 }],
    serviceNetwork: [serviceCidr],
    machineNetwork: [{ cidr: machineCidr }],
  };

  if (fips) {
    config.fips = true;
  }

  return yaml.dump(config, { lineWidth: -1, noRefs: true });
}

module.exports = { build };
