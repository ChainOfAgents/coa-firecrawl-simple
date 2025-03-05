#!/bin/bash

# Exit on any error
set -e

# Default values
PROJECT_ID=""
REGION="us-central1"
SERVICE_NAME="ulixee-service"

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
    --service-name)
      SERVICE_NAME="$2"
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
  echo "Usage: $0 --project PROJECT_ID [--region REGION] [--service-name SERVICE_NAME]"
  exit 1
fi

echo "Deploying $SERVICE_NAME to Cloud Run in project $PROJECT_ID, region $REGION"

# Build the container
echo "Building container image..."
docker build -t "gcr.io/$PROJECT_ID/$SERVICE_NAME" .

# Configure Docker to use gcloud as a credential helper
echo "Configuring Docker authentication..."
gcloud auth configure-docker

# Push the image to Google Container Registry
echo "Pushing image to Container Registry..."
docker push "gcr.io/$PROJECT_ID/$SERVICE_NAME"

# Deploy to Cloud Run
echo "Deploying to Cloud Run..."
gcloud run deploy "$SERVICE_NAME" \
  --image "gcr.io/$PROJECT_ID/$SERVICE_NAME" \
  --platform managed \
  --region "$REGION" \
  --memory 2Gi \
  --cpu 1 \
  --timeout 300s \
  --concurrency 80 \
  --set-env-vars "RUNNING_IN_CLOUD=true,CHROME_SANDBOX=false,HERO_MAX_CONCURRENT_BROWSERS=10,ULIXEE_DATABOX_SIZE_MB=100,NODE_OPTIONS=--max-old-space-size=2048" \
  --allow-unauthenticated \
  --project "$PROJECT_ID"

echo "Deployment complete!"
echo "Your service is available at: $(gcloud run services describe $SERVICE_NAME --region $REGION --project $PROJECT_ID --format 'value(status.url)')"
