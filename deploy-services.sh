#!/bin/bash
set -e

# Function to check if a command succeeded
check_success() {
  if [ $? -ne 0 ]; then
    echo " Error: $1 failed. Exiting deployment sequence."
    exit 1
  else
    echo " $1 completed successfully."
  fi
}

echo "Setting up permissions for Cloud Build service account..."
gcloud projects add-iam-policy-binding crawl-websites \
  --member="serviceAccount:475988465347@cloudbuild.gserviceaccount.com" \
  --role="roles/redis.viewer"
check_success "Cloud Build service account permission setup"

# Create build artifacts bucket if it doesn't exist
echo " Checking/creating build artifacts bucket..."
if ! gsutil ls gs://crawl-websites-build-artifacts &>/dev/null; then
  gsutil mb -l us-west2 gs://crawl-websites-build-artifacts
  check_success "Build artifacts bucket creation"
else
  echo " Build artifacts bucket already exists."
fi

# Trigger IDs
PUPPETEER_TRIGGER_ID="63ba6907-af7a-42b1-8b70-70cabf051dfe"
API_TRIGGER_ID="ca5fbfd4-64ea-408a-8c24-e30d4e2620a7"
WORKER_TRIGGER_ID="509d8ac7-dc2d-469b-bec4-d792bab09df0"

# Step 1: Deploy Puppeteer service
echo -e "\n Step 1/3: Deploying Puppeteer service..."
gcloud builds triggers run $PUPPETEER_TRIGGER_ID --branch=main
check_success "Puppeteer service deployment"

# Wait for the build to finish and check its status
echo " Waiting for Puppeteer build to complete..."
BUILD_ID=$(gcloud builds list --limit=1 --format="value(id)")
gcloud builds log $BUILD_ID --stream
BUILD_STATUS=$(gcloud builds describe $BUILD_ID --format="value(status)")
if [[ "$BUILD_STATUS" != "SUCCESS" ]]; then
  echo " Error: Puppeteer build failed with status: $BUILD_STATUS"
  exit 1
fi

# Step 2: Deploy API service
echo -e "\n Step 2/3: Deploying API service..."
gcloud builds triggers run $API_TRIGGER_ID --branch=main
check_success "API service deployment"

# Wait for the build to finish and check its status
echo " Waiting for API build to complete..."
BUILD_ID=$(gcloud builds list --limit=1 --format="value(id)")
gcloud builds log $BUILD_ID --stream
BUILD_STATUS=$(gcloud builds describe $BUILD_ID --format="value(status)")
if [[ "$BUILD_STATUS" != "SUCCESS" ]]; then
  echo " Error: API build failed with status: $BUILD_STATUS"
  exit 1
fi

# Step 3: Deploy Worker service
echo -e "\n Step 3/3: Deploying Worker service..."
gcloud builds triggers run $WORKER_TRIGGER_ID --branch=main
check_success "Worker service deployment"

# Wait for the build to finish and check its status
echo " Waiting for Worker build to complete..."
BUILD_ID=$(gcloud builds list --limit=1 --format="value(id)")
gcloud builds log $BUILD_ID --stream
BUILD_STATUS=$(gcloud builds describe $BUILD_ID --format="value(status)")
if [[ "$BUILD_STATUS" != "SUCCESS" ]]; then
  echo " Error: Worker build failed with status: $BUILD_STATUS"
  exit 1
fi

echo -e "\n All services deployed successfully!"
