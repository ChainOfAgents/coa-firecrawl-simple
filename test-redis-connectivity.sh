#!/bin/bash

# Get the Redis IP from GCP
REDIS_IP=$(gcloud redis instances describe crawlweb-redis --region=us-west2 --format='get(host)')

echo "Redis IP: $REDIS_IP"

# Create a temporary Cloud Run service to test Redis connectivity
cat <<EOL > Dockerfile.test
FROM node:18-alpine

WORKDIR /app

COPY package.json .
COPY redis-test.js .

RUN npm install ioredis bullmq

CMD ["node", "redis-test.js"]
EOL

cat <<EOL > package.json
{
  "name": "redis-test",
  "version": "1.0.0",
  "description": "Test Redis connectivity",
  "dependencies": {
    "ioredis": "^5.0.0",
    "bullmq": "^4.0.0"
  }
}
EOL

echo "Building test image..."
docker build -t redis-test -f Dockerfile.test .

echo "Running test locally..."
docker run --rm -e REDIS_URL="redis://$REDIS_IP:6379" redis-test

echo "Test completed!"
