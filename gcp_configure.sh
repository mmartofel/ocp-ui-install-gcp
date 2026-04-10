#!/bin/bash

gcloud init

# Copy service account file where openshift-install expects it 
cp ./gcp_service_account.json ${HOME}/.gcp/osServiceAccount.json

# Required API services

gcloud services enable compute.googleapis.com
gcloud services enable cloudresourcemanager.googleapis.com
gcloud services enable dns.googleapis.com
gcloud services enable iamcredentials.googleapis.com
gcloud services enable iam.googleapis.com
gcloud services enable serviceusage.googleapis.com

# Optional API services

gcloud services enable cloudapis.googleapis.com
gcloud services enable servicemanagement.googleapis.com
gcloud services enable storage.googleapis.com
gcloud services enable storage-api.googleapis.com
gcloud services enable storage-component.googleapis.com
gcloud services enable file.googleapis.com

# Enable assets listing

gcloud services enable cloudasset.googleapis.com

# Enable compute instances listing
gcloud services enable deploymentmanager.googleapis.com


# Required IAM roles

# roles/compute.admin
# roles/iam.serviceAccountUser
# roles/dns.admin
# roles/storage.admin
# roles/resourcemanager.projectIamAdmin
# roles/serviceusage.serviceUsageAdmin

