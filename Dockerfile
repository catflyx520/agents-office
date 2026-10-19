FROM node:24-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates git python3 ripgrep bash curl \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g @anthropic-ai/claude-code@2.1.303 @openai/codex@0.163.0

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --chown=root:root server ./server
COPY --chown=root:root client ./client
COPY docker-entrypoint.sh /usr/local/bin/office-entrypoint
RUN chmod 755 /usr/local/bin/office-entrypoint

ENV NODE_ENV=production PORT=3000 HOME=/home/node
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=6 \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["office-entrypoint"]
CMD ["node", "server/index.js"]
