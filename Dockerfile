# 0G Flow — one image, three services.
#
# The agent server, the explorer and the indexer all come from the same
# workspace and share most of their dependency tree, so building three images
# would mean building the same thing three times and then keeping three
# Dockerfiles honest with each other. `SERVICE` picks which one runs.
#
# Node 22 to match the toolchain the tests run on. `slim` rather than `alpine`:
# the 0G storage SDK pulls native modules, and musl builds of those are a
# category of problem worth not having.
FROM node:22-slim

# git is needed by some transitive installs; ca-certificates for HTTPS to the
# 0G RPC and indexer endpoints.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
RUN corepack enable

# Manifests first, so a change to source does not invalidate the install layer.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json                packages/core/
COPY packages/config/package.json              packages/config/
COPY packages/adapter-sdk/package.json         packages/adapter-sdk/
COPY packages/conform/package.json             packages/conform/
COPY packages/storage/package.json             packages/storage/
COPY packages/executor/package.json            packages/executor/
COPY packages/indexer/package.json             packages/indexer/
COPY packages/explorer-api/package.json        packages/explorer-api/
COPY packages/verify/package.json              packages/verify/
COPY packages/publish/package.json             packages/publish/
COPY apps/explorer/package.json                apps/explorer/
COPY tools/reference-agents/package.json       tools/reference-agents/
COPY tools/live-run/package.json               tools/live-run/
COPY tools/run-flow/package.json               tools/run-flow/
COPY tools/tee-agent/package.json              tools/tee-agent/

# --no-frozen-lockfile: the lockfile is committed, but a mismatch here should
# not take the deploy down when the fix is a re-resolve.
RUN pnpm install --no-frozen-lockfile

COPY . .

# Compile the workspace, then the explorer UI. The UI is built here rather
# than in a separate service because the API serves it from the same origin —
# which is what its relative `/api/...` fetches were written for.
RUN pnpm exec tsc -b \
    && pnpm --filter @0gflow/explorer build

ENV NODE_ENV=production
ENV EXPLORER_UI_DIR=/app/apps/explorer/dist

COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENTRYPOINT ["docker-entrypoint.sh"]
