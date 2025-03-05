FROM node:20-slim

# Install system dependencies for Ulixee Hero
RUN apt-get update && \
    apt-get install -y wget gnupg && \
    if [ "$(uname -m)" = "aarch64" ] || [ "$(uname -m)" = "arm64" ]; then \
        apt-get install -y chromium && \
        echo "Installing Chromium for ARM architecture" && \
        ls -la /usr/bin/chromium*; \
    else \
        wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | apt-key add - && \
        echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" >> /etc/apt/sources.list.d/google.list && \
        apt-get update && \
        apt-get install -y google-chrome-stable && \
        echo "Installing Chrome for x86 architecture" && \
        ls -la /usr/bin/google-chrome*; \
    fi && \
    apt-get install -y \
    fonts-ipafont-gothic \
    fonts-wqy-zenhei \
    fonts-thai-tlwg \
    fonts-kacst \
    fonts-symbola \
    fonts-noto \
    fonts-freefont-ttf \
    --no-install-recommends && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install pnpm globally
RUN npm install -g pnpm

# Copy package files
COPY package.json pnpm-lock.yaml ./

# Install dependencies
RUN pnpm install --frozen-lockfile

# Copy the rest of the application
COPY . .

# Build the application
RUN pnpm run build

# Set environment variables
ENV NODE_ENV=production \
    ULIXEE_BROWSERS_PATH=/app/browsers \
    ULIXEE_SKIP_BROWSER_DOWNLOAD=1 \
    HERO_MAX_CONCURRENT_BROWSERS=10 \
    ULIXEE_DATABOX_SIZE_MB=100 \
    NODE_OPTIONS="--max-old-space-size=2048" \
    CHROME_SANDBOX=false

# Create a script to determine the right configuration at runtime
RUN echo '#!/bin/bash\n\
# Detect architecture\n\
ARCH=$(uname -m)\n\
echo "Detected architecture: $ARCH"\n\
\n\
if [ "$RUNNING_IN_CLOUD" = "true" ]; then\n\
  # Cloud environment (GCP) - use x86 settings\n\
  export CHROME_PATH=/usr/bin/google-chrome\n\
else\n\
  # Local environment - use architecture-specific settings\n\
  if [ "$ARCH" = "aarch64" ] || [ "$ARCH" = "arm64" ]; then\n\
    export CHROME_PATH=/usr/bin/chromium\n\
  else\n\
    export CHROME_PATH=/usr/bin/google-chrome\n\
  fi\n\
fi\n\
\n\
# Verify Chrome exists\n\
if [ -f "$CHROME_PATH" ]; then\n\
  echo "Chrome found at: $CHROME_PATH"\n\
else\n\
  echo "WARNING: Chrome not found at $CHROME_PATH"\n\
  echo "Available browsers:"\n\
  ls -la /usr/bin/chromium* /usr/bin/google-chrome* 2>/dev/null || echo "No browsers found"\n\
fi\n\
\n\
# Always disable sandbox in Docker\n\
export CHROME_SANDBOX=false\n\
\n\
echo "===== ENVIRONMENT VARIABLES FOR DEBUGGING ====="\n\
echo "- Chrome path: $CHROME_PATH"\n\
echo "- Chrome sandbox: $CHROME_SANDBOX"\n\
echo "- Running in cloud: $RUNNING_IN_CLOUD"\n\
echo "- PORT: $PORT"\n\
echo "- NODE_ENV: $NODE_ENV"\n\
echo "- HOST: $HOST"\n\
\n\
echo "===== ALL ENVIRONMENT VARIABLES ====="\n\
printenv | sort\n\
echo "========================================"\n\
\n\
exec "$@"\n' > /app/docker-entrypoint.sh && \
chmod +x /app/docker-entrypoint.sh

# Cloud Run will set the PORT environment variable
EXPOSE 8080

ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["node", "dist/api.js"]
