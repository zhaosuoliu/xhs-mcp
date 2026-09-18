FROM mcr.microsoft.com/playwright:v1.57.0-noble

# 代码所有 chromium.launch 均使用 channel:'chrome'，需要真实 Google Chrome；
# xvfb 提供虚拟显示器以运行有头模式（headless UA 是明显的自动化特征）
RUN apt-get update \
    && apt-get install -y --no-install-recommends wget xvfb \
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

ENV XHS_MCP_HEADLESS=false
ENV XHS_MCP_DATA_DIR=/root/.xhs-mcp
# @google/genai 在模块加载时校验 key，缺失会直接崩溃；不使用 AI 功能时占位即可
ENV GEMINI_API_KEY=unused

EXPOSE 18060
# xvfb-run 在容器内会静默卡住不执行命令，改为显式启动 Xvfb 后 exec node
CMD ["sh", "-c", "Xvfb :99 -screen 0 1920x1080x24 -nolisten tcp & export DISPLAY=:99 && exec node dist/index.js --http"]
