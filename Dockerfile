FROM mcr.microsoft.com/playwright:v1.57.0-noble

# 代码所有 chromium.launch 均使用 channel:'chrome'，需要真实 Google Chrome
RUN apt-get update \
    && apt-get install -y --no-install-recommends wget \
    && wget -q -O /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb \
    && apt-get install -y --no-install-recommends /tmp/chrome.deb \
    && rm /tmp/chrome.deb \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 完整安装以执行原生模块（better-sqlite3/sharp/canvas）的二进制获取脚本
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

ENV XHS_MCP_HEADLESS=true
ENV XHS_MCP_DATA_DIR=/root/.xhs-mcp

EXPOSE 18060
CMD ["node", "dist/index.js", "--http"]
