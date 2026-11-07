FROM mcr.microsoft.com/devcontainers/javascript-node:1-22-bookworm

# Install Chromium and runtime dependencies for headless Puppeteer gates & software WebGL (SwiftShader / Mesa)
RUN apt-get update && export DEBIAN_FRONTEND=noninteractive \
    && apt-get install -y --no-install-recommends \
       chromium \
       fonts-liberation \
       libasound2 \
       libatk-bridge2.0-0 \
       libatk1.0-0 \
       libcairo2 \
       libcups2 \
       libdrm2 \
       libgbm1 \
       libgl1 \
       libgl1-mesa-dri \
       libglib2.0-0 \
       libgtk-3-0 \
       libnspr4 \
       libnss3 \
       libpango-1.0-0 \
       libx11-6 \
       libxcb1 \
       libxcomposite1 \
       libxdamage1 \
       libxext6 \
       libxfixes3 \
       libxkbcommon0 \
       libxrandr2 \
       mesa-utils \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*
