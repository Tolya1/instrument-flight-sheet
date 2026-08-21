FROM node:24-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-fund --no-audit

COPY server.js ./
COPY lib ./lib
COPY public ./public

# data/ holds the OurAirports + NASR caches, archive/ the personal-mode sheet
# archive. Create and chown BEFORE declaring volumes: a fresh named volume
# inherits the image dir's ownership, and USER node must be able to write.
RUN mkdir -p /app/data /app/archive && chown node:node /app/data /app/archive
VOLUME ["/app/data", "/app/archive"]

ENV PUBLIC_MODE=1 \
    HOST=0.0.0.0 \
    PORT=8420

EXPOSE 8420

# /healthz is a readiness check: 503 until airport data is indexed. First-ever
# start downloads ~20 MB from three sources, so give it a generous start period.
HEALTHCHECK --interval=60s --timeout=5s --start-period=300s \
  CMD wget -qO- http://127.0.0.1:8420/healthz || exit 1

USER node
CMD ["node", "server.js"]
