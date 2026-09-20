# syntax=docker/dockerfile:1.7
ARG VIRON_SERVER_BASE=server-runtime
ARG VIRON_BUILD_BASE=dependencies
ARG VIRON_PRODUCTION_BASE=production-dependencies
ARG VIRON_FULL_BASE=full-runtime
ARG VIRON_RUNNER_BASE=script-runner-runtime
ARG VIRON_MONITOR_BASE=monitor-artifacts
ARG APT_MIRROR=https://deb.debian.org/debian
ARG APT_SECURITY_MIRROR=https://deb.debian.org/debian-security

FROM --platform=$BUILDPLATFORM golang:1.26-bookworm AS monitor-build
ENV GOPROXY=https://proxy.golang.org|https://goproxy.cn|direct
WORKDIR /app
COPY package.json ./
COPY monitor ./monitor
COPY scripts/build-viron-monitor.sh ./scripts/build-viron-monitor.sh
RUN --mount=type=cache,id=viron-go-mod,target=/go/pkg/mod,sharing=locked \
    --mount=type=cache,id=viron-go-build,target=/root/.cache/go-build,sharing=locked \
    bash scripts/build-viron-monitor.sh

FROM scratch AS monitor-artifacts
COPY --from=monitor-build /app/dist/monitor /app/dist/monitor

FROM node:22-bookworm-slim AS dependency-manifests
WORKDIR /app
COPY package.json package-lock.json ./
COPY scripts/dependency-manifest.mjs /normalize.mjs
RUN node /normalize.mjs

FROM node:22-bookworm-slim AS dependencies
WORKDIR /app
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
COPY --from=dependency-manifests /app/package.json /app/package-lock.json ./
RUN --mount=type=cache,id=viron-npm,target=/root/.npm,sharing=locked \
    npm ci --prefer-offline --no-audit --no-fund

FROM ${VIRON_BUILD_BASE} AS production-dependencies
RUN npm prune --omit=dev --ignore-scripts --offline --no-audit --no-fund

FROM ${VIRON_BUILD_BASE} AS build
COPY package.json package-lock.json ./
COPY tsconfig.json tsconfig.server.json vite.config.ts index.html tokens.css ./
COPY src ./src
COPY design/logo/viron-logo.svg ./design/logo/viron-logo.svg
RUN npm run build

FROM ${VIRON_PRODUCTION_BASE} AS production-base
FROM --platform=$BUILDPLATFORM ${VIRON_MONITOR_BASE} AS monitor-base

FROM node:22-bookworm-slim AS server-runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    DATA_DIR=/data

RUN groupadd --gid 10001 viron \
    && useradd --uid 10001 --gid viron --home-dir /app --shell /usr/sbin/nologin viron \
    && mkdir -p /app /data \
    && chown -R viron:viron /app /data

WORKDIR /app
USER viron
EXPOSE 8080
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||'8080')+'/readyz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]

CMD ["node", "dist/server/index.js"]

FROM ${VIRON_SERVER_BASE} AS server-base
COPY --from=build --chown=viron:viron /app/package.json /app/package-lock.json ./
COPY --from=production-base --chown=viron:viron /app/node_modules ./node_modules
COPY --from=build --chown=viron:viron /app/dist/*.js* ./dist/
COPY --from=build --chown=viron:viron /app/dist/server ./dist/server
COPY --from=build --chown=viron:viron /app/dist/shared ./dist/shared
COPY --from=monitor-base --chown=viron:viron /app/dist/monitor ./monitor

FROM server-base AS lite
COPY --chown=viron:viron docker/server-edition-lite ./dist/server/server-edition

FROM ${VIRON_SERVER_BASE} AS full-runtime
USER root
ARG APT_MIRROR
ARG APT_SECURITY_MIRROR
ARG TARGETARCH
RUN --mount=type=cache,id=viron-apt-lists-${TARGETARCH},target=/var/lib/apt/lists,sharing=locked \
    --mount=type=cache,id=viron-apt-archives-${TARGETARCH},target=/var/cache/apt,sharing=locked \
    node -e 'const fs=require("node:fs");fs.mkdirSync("/etc/ssl/certs",{recursive:true});fs.writeFileSync("/etc/ssl/certs/ca-certificates.crt",require("node:tls").rootCertificates.join("\n"))' \
    && rm -f /etc/apt/apt.conf.d/docker-clean \
    && sed -i "s|http://deb.debian.org/debian-security|${APT_SECURITY_MIRROR}|g; s|http://deb.debian.org/debian|${APT_MIRROR}|g" /etc/apt/sources.list.d/debian.sources \
    && apt-get -o Acquire::Retries=3 -o Acquire::http::Timeout=30 update \
    && apt-get -o Acquire::Retries=3 -o Acquire::http::Timeout=30 install -y --no-install-recommends ca-certificates chromium fonts-liberation fonts-noto-cjk
ENV WEB_BROWSER_EXECUTABLE=/usr/bin/chromium
USER viron

FROM ${VIRON_FULL_BASE} AS full
COPY --from=server-base --chown=viron:viron /app/ /app/
COPY --from=build --chown=viron:viron /app/dist/client ./dist/client
COPY --chown=viron:viron docker/server-edition-full ./dist/server/server-edition

FROM node:22-bookworm-slim AS script-runner-runtime
ARG APT_MIRROR
ARG APT_SECURITY_MIRROR
ARG TARGETARCH
RUN --mount=type=cache,id=viron-apt-lists-${TARGETARCH},target=/var/lib/apt/lists,sharing=locked \
    --mount=type=cache,id=viron-apt-archives-${TARGETARCH},target=/var/cache/apt,sharing=locked \
    node -e 'const fs=require("node:fs");fs.mkdirSync("/etc/ssl/certs",{recursive:true});fs.writeFileSync("/etc/ssl/certs/ca-certificates.crt",require("node:tls").rootCertificates.join("\n"))' \
    && rm -f /etc/apt/apt.conf.d/docker-clean \
    && sed -i "s|http://deb.debian.org/debian-security|${APT_SECURITY_MIRROR}|g; s|http://deb.debian.org/debian|${APT_MIRROR}|g" /etc/apt/sources.list.d/debian.sources \
    && apt-get -o Acquire::Retries=3 -o Acquire::http::Timeout=30 update \
    && apt-get -o Acquire::Retries=3 -o Acquire::http::Timeout=30 install -y --no-install-recommends ca-certificates curl jq openssh-client rsync sshpass util-linux \
    && groupadd --gid 10002 sandbox \
    && useradd --uid 10002 --gid sandbox --home-dir /tmp --shell /usr/sbin/nologin sandbox \
    && mkdir -p /runner /run/viron-script-runner
ENV NODE_ENV=production \
    SCRIPT_RUNNER_SOCKET=/run/viron-script-runner/runner.sock \
    SCRIPT_RUNNER_SOCKET_GID=10001 \
    SCRIPT_SANDBOX_UID=10002 \
    SCRIPT_SANDBOX_GID=10002
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD ["node", "-e", "const http=require('node:http');const r=http.request({socketPath:process.env.SCRIPT_RUNNER_SOCKET,path:'/healthz'},x=>process.exit(x.statusCode===200?0:1));r.on('error',()=>process.exit(1));r.end()"]
CMD ["node", "/runner/script-runner.mjs"]

FROM ${VIRON_RUNNER_BASE} AS script-runner
COPY scripts/script-runner.mjs /runner/script-runner.mjs
