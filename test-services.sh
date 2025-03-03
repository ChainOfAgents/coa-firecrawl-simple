#!/bin/bash
set -e

# Color codes
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Service URLs
API_URL="https://api-service-firecrawl-simple-475988465347.us-west2.run.app"
PUPPETEER_URL="https://puppeteer-service-firecrawl-simple-475988465347.us-west2.run.app"
WORKER_URL="https://worker-service-firecrawl-simple-475988465347.us-west2.run.app"

echo -e "\n${YELLOW}============== Testing Firecrawl Services ==============${NC}\n"

# Test API health endpoint without authentication
echo -e "${YELLOW}Testing API service health...${NC}"
API_HEALTH=$(curl -s -o /dev/null -w "%{http_code}" "${API_URL}/health")
if [ "$API_HEALTH" == "200" ]; then
  echo -e "${GREEN}✓ API service is healthy (HTTP $API_HEALTH)${NC}"
else
  echo -e "${RED}✗ API service health check failed (HTTP $API_HEALTH)${NC}"
fi

# Test Puppeteer health endpoint without authentication
echo -e "\n${YELLOW}Testing Puppeteer service health...${NC}"
PUPPETEER_HEALTH=$(curl -s -o /dev/null -w "%{http_code}" "${PUPPETEER_URL}/health")
if [ "$PUPPETEER_HEALTH" == "200" ]; then
  echo -e "${GREEN}✓ Puppeteer service is healthy (HTTP $PUPPETEER_HEALTH)${NC}"
else
  echo -e "${RED}✗ Puppeteer service health check failed (HTTP $PUPPETEER_HEALTH)${NC}"
fi

# For testing a crawl, we'll need auth. Get a token if available, or just test the endpoint availability
echo -e "\n${YELLOW}Testing crawl API endpoint availability...${NC}"
CRAWL_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST -H "Content-Type: application/json" \
  -d '{"url": "https://en.wikipedia.org/wiki/Artificial_intelligence", "depth": 0}' \
  "${API_URL}/crawl")

# 401 is expected without auth token, which means endpoint exists but requires auth
if [ "$CRAWL_STATUS" == "401" ] || [ "$CRAWL_STATUS" == "403" ]; then
  echo -e "${GREEN}✓ Crawl API endpoint is available (requires authentication)${NC}"
else
  if [ "$CRAWL_STATUS" == "200" ]; then
    echo -e "${GREEN}✓ Crawl API endpoint is functioning!${NC}"
  else
    echo -e "${RED}✗ Crawl API endpoint check failed (HTTP $CRAWL_STATUS)${NC}"
  fi
fi

echo -e "\n${YELLOW}============== Test Summary ==============${NC}"
echo -e "API Service: $([[ "$API_HEALTH" == "200" ]] && echo "${GREEN}PASSED${NC}" || echo "${RED}FAILED${NC}")"
echo -e "Puppeteer Service: $([[ "$PUPPETEER_HEALTH" == "200" ]] && echo "${GREEN}PASSED${NC}" || echo "${RED}FAILED${NC}")"
echo -e "Crawl Endpoint: $([[ "$CRAWL_STATUS" == "401" || "$CRAWL_STATUS" == "403" || "$CRAWL_STATUS" == "200" ]] && echo "${GREEN}AVAILABLE${NC}" || echo "${RED}UNAVAILABLE${NC}")"

echo -e "\n${YELLOW}============== Next Steps ==============${NC}"
echo "For full testing with authentication, you can:"
echo "1. Create a service account key:"
echo "   gcloud iam service-accounts keys create key.json --iam-account=crawlweb-sa@crawl-websites.iam.gserviceaccount.com"
echo ""
echo "2. Authenticate and test with the key:"
echo "   TOKEN=\$(gcloud auth print-identity-token --service-account-file=key.json)"
echo "   curl -H \"Authorization: Bearer \$TOKEN\" ${API_URL}/health"
echo ""
echo "3. Or make the services publicly accessible for testing (not recommended for production):"
echo "   gcloud run services set-iam-policy api-service-firecrawl-simple --region=us-west2 policy.yaml"
echo "   Where policy.yaml contains a binding for allUsers with the roles/run.invoker role"
