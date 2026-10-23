# syntax=docker/dockerfile:1
ARG BUN_VERSION=1.4.3
ARG NODE_VERSION=26.12.1
FROM oven/bun:${BUN_VERSION}-debian AS bun-runtime
FROM node:${NODE_VERSION}-trixie-slim
COPY --from=bun-runtime /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
ENV CI=true NEXT_TELEMETRY_DISABLED=1
CMD ["bash", "scripts/ci/check.sh"]
