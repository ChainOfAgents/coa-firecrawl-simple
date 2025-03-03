#!/bin/bash
set -e

# This script modifies the applications to correctly use the PORT environment variable
# while still respecting their intended port numbers via APPLICATION_PORT

# Modify API service
echo "Modifying API service..."
cat > /tmp/api_port_patch.js << 'EOL'
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'apps/api/src/index.ts');
const content = fs.readFileSync(filePath, 'utf8');

// Replace the port definition
const updatedContent = content.replace(
  "const DEFAULT_PORT = process.env.PORT ?? 3002;",
  "const DEFAULT_PORT = process.env.PORT ?? process.env.APPLICATION_PORT ?? 3002;"
);

fs.writeFileSync(filePath, updatedContent, 'utf8');
console.log("✅ Updated API service port handling");
EOL

# Modify Puppeteer service
echo "Modifying Puppeteer service..."
cat > /tmp/puppeteer_port_patch.js << 'EOL'
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'apps/puppeteer-service-ts/api.ts');
const content = fs.readFileSync(filePath, 'utf8');

// Replace the port definition
const updatedContent = content.replace(
  "const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3003;",
  "const port = process.env.PORT ? parseInt(process.env.PORT, 10) : (process.env.APPLICATION_PORT ? parseInt(process.env.APPLICATION_PORT, 10) : 3003);"
);

fs.writeFileSync(filePath, updatedContent, 'utf8');
console.log("✅ Updated Puppeteer service port handling");
EOL

# Execute the patch scripts
node /tmp/api_port_patch.js
node /tmp/puppeteer_port_patch.js

echo "✅ All services updated to properly handle PORT environment variables"
echo "Now you can rebuild and redeploy your services"
