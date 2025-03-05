#!/bin/bash

# Exit on any error
set -e

# Default values
PROJECT_ID=""
REGION="us-west2"
TAG="v1"

# Parse command line arguments
while [[ $# -gt 0 ]]; do
  key="$1"
  case $key in
    --project)
      PROJECT_ID="$2"
      shift
      shift
      ;;
    --region)
      REGION="$2"
      shift
      shift
      ;;
    --tag)
      TAG="$2"
      shift
      shift
      ;;
    *)
      echo "Unknown option: $1"
      exit 1
      ;;
  esac
done

# Check if project ID is provided
if [ -z "$PROJECT_ID" ]; then
  echo "Error: --project flag is required"
  echo "Usage: $0 --project PROJECT_ID [--region REGION] [--tag TAG]"
  exit 1
fi

echo "Deploying Ulixee service to Cloud Build in project $PROJECT_ID, region $REGION with tag $TAG"

# Submit the build to Cloud Build
gcloud builds submit --config cloudbuild-ulixee.yaml \
  --substitutions=_REGION=$REGION,_TAG=$TAG \
  --project $PROJECT_ID

echo "Build submitted to Cloud Build!"
echo "You can check the status of your build in the Cloud Build console:"
echo "https://console.cloud.google.com/cloud-build/builds?project=$PROJECT_ID"
