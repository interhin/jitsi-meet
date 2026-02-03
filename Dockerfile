ARG JITSI_WEB_TAG=stable
FROM node:22-bookworm-slim AS builder

ENV NODE_OPTIONS="--max-old-space-size=8192"
ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends make python3 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY . .

RUN npm ci --legacy-peer-deps && make

ARG JITSI_WEB_TAG=stable
FROM jitsi/web:${JITSI_WEB_TAG}

COPY --from=builder /app/libs /usr/share/jitsi-meet/libs
COPY --from=builder /app/css /usr/share/jitsi-meet/css
