# =============================================================================
# HYDRA-UMC OPCUA SERVER - Container Build: Dockerfile
# Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
# GPL-3.0-or-later - see LICENSE
# =============================================================================
# Same two-stage shape used by every Node/TypeScript project in this batch
# (see HYDRA-UMC-GATEWAY-INDUSTRIAL, HYDRA-UMC-MQTT-BROKER and
# HYDRA-UMC-MTCONNECT-ADAPTER for the identical pattern) - build stage runs
# the same `npm run build` a developer would run locally, runtime stage
# ships only the bundle plus package.json. Consumed by
# HYDRA-UMC-GATEWAY-INDUSTRIAL's own docker-compose.yml as the "opcua-server"
# service.

FROM node:24-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY scripts ./scripts
COPY src ./src
RUN npm run build

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# The certificate stores live on a volume (see docker-compose.yml): a recreated container keeps its identity.
ENV OPCUA_PKI_DIR=/data/pki
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json /app/package-lock.json ./
# Real bug found live on this image's first real run: `npm run build`
# bundles with esbuild's own `--packages=external` (see package.json's
# own build script), which deliberately does NOT inline npm dependencies
# into dist/server.cjs - they stay real require() calls expecting
# node_modules to exist at runtime. This stage never installed them,
# so every real run crashed immediately with MODULE_NOT_FOUND. Same
# `npm ci --omit=dev` pattern HYDRA-UMC-OS's own install_server.sh
# already uses for HYDRA-UMC-SERVER (also esbuild + --packages=external).
RUN npm ci --omit=dev && mkdir -p /data/pki && chown -R node:node /data
USER node
EXPOSE 4840
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "require('node:net').connect(process.env.HYDRA_UMC_OPCUA_PORT||process.env.PORT||4840,'127.0.0.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))"
CMD ["node", "dist/server.cjs"]
