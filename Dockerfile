# =============================================================================
# HYDRA-UMC OPCUA SERVER - Container Build: Dockerfile
# Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
# GPL-3.0 - see LICENSE
# =============================================================================
# Same two-stage shape used by every Node/TypeScript project in this batch
# (see HYDRA-UMC-GATEWAY-INDUSTRIAL, HYDRA-UMC-MQTT-BROKER and
# HYDRA-UMC-MTCONNECT-ADAPTER for the identical pattern) - build stage runs
# the same `npm run build` a developer would run locally, runtime stage
# ships only the bundle plus package.json. Consumed by
# HYDRA-UMC-GATEWAY-INDUSTRIAL's own docker-compose.yml as the "opcua-server"
# service.

FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY tsconfig.json ./
COPY scripts ./scripts
COPY src ./src
RUN npm run build

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
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
RUN npm ci --omit=dev
EXPOSE 4840
CMD ["node", "dist/server.cjs"]
