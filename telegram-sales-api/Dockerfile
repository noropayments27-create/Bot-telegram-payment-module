FROM node:22-bookworm-slim

# Playwright runtime deps for Chromium (headless)
RUN apt-get update && apt-get install -y --no-install-recommends \
    libnss3 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libx11-xcb1 \
    libxshmfence1 \
    libxss1 \
    libxext6 \
    libx11-6 \
    libgbm1 \
    libasound2 \
    libpangocairo-1.0-0 \
    libpango-1.0-0 \
    libcairo2 \
    libgtk-3-0 \
    fonts-liberation \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY telegram-sales-api/package*.json ./
RUN npm ci

# Download browser binaries into the image
ENV PLAYWRIGHT_BROWSERS_PATH=0
RUN npx playwright install chromium

COPY telegram-sales-api/ ./

EXPOSE 3001
CMD ["npm", "start"]
