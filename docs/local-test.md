# Local Testing Guide for Firecrawl

This guide provides step-by-step instructions for setting up and testing the Firecrawl application locally.

## Prerequisites

- Docker and Docker Compose installed
- curl or a similar HTTP client for testing the API

## Setup Steps

### 1. Configure Environment Variables

Create a `.env` file in the project root with the following variables:

```bash
# Number of worker processes per queue
NUM_WORKERS_PER_QUEUE=2

# Authentication key for Bull queue dashboard
# WARNING: Change this to a secure random string in production
BULL_AUTH_KEY=firecrawl_dev_key_123

# API key for testing purposes
# WARNING: Change this to a secure random string in production
TEST_API_KEY=test_api_key_123

# Logging level (debug, info, warn, error)
LOGGING_LEVEL=info

# Proxy configuration (optional)
# WARNING: These are placeholder values. Configure with real proxy details if needed
PROXY_SERVER=
PROXY_USERNAME=
PROXY_PASSWORD=

# 2Captcha token for solving CAPTCHAs (optional)
# WARNING: You'll need a real token from 2captcha.com for production use
TWOCAPTCHA_TOKEN=

# Maximum number of concurrent browser instances
MAX_CONCURRENCY=5

# Redis configuration (already has defaults in docker-compose.yaml)
REDIS_URL=redis://redis:6379

# Port configuration (already has defaults in docker-compose.yaml)
PORT=3002

# Host configuration (already has defaults in docker-compose.yaml)
HOST=0.0.0.0

# Resource limits (already have defaults in docker-compose.yaml)
MAX_RAM=0.95
MAX_CPU=0.95
```

### 2. Start the Services

```bash
# Start all services
docker compose up -d
```

### 3. Verify Services are Running

```bash
# Check that all containers are running
docker ps
```

You should see the following containers:
- firecrawl-api-1
- firecrawl-worker-1
- firecrawl-puppeteer-service-1
- firecrawl-redis-1

## Testing the API

### 1. Start a Web Crawl

```bash
curl -X POST http://localhost:3002/v1/crawl \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer test_api_key_123' \
  -d '{
    "url": "https://docs.firecrawl.dev",
    "limit": 100,
    "scrapeOptions": {
      "formats": ["markdown", "rawHtml"]
    }
  }' | jq
```

Note: The valid format options are "markdown", "rawHtml", and "screenshot".

The response should look like:

```json
{
  "success": true,
  "id": "77bef340-94e2-4c80-98fe-5acdcc41d4ff",
  "url": "https://localhost:3002/v1/crawl/77bef340-94e2-4c80-98fe-5acdcc41d4ff"
}
```

### 2. Check Crawl Status

Use the ID from the previous response to check the status:

```bash
curl -X GET http://localhost:3002/v1/crawl/YOUR_JOB_ID \
  -H 'Authorization: Bearer test_api_key_123' | jq
```

Example response:

```json
{
  "success": true,
  "status": "scraping",
  "completed": 26,
  "total": 37,
  "expiresAt": "2025-04-19T21:16:49.000Z",
  "next": "https://localhost:3002/v1/crawl/77bef340-94e2-4c80-98fe-5acdcc41d4ff?skip=26",
  "data": [...]
}
```

Continue checking until the status changes from "scraping" to "completed".

## Troubleshooting

### Connection Issues

If you can't connect to the API:
1. Ensure all containers are running with `docker ps`
2. Check the logs with `docker compose logs api`
3. Verify you're using HTTP, not HTTPS in your requests
4. Confirm you're using the correct API key in the Authorization header
