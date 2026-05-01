# syntax=docker/dockerfile:1.7

ARG BUN_VERSION=1.3.13

FROM oven/bun:${BUN_VERSION}-slim AS base
WORKDIR /app

FROM base AS deps
COPY package.json bun.lock ./
RUN --mount=type=cache,target=/root/.bun/install/cache \
	bun install --frozen-lockfile

FROM deps AS check
COPY .gitignore ./
COPY biome.json tsconfig.json ./
COPY src ./src
COPY tests ./tests
RUN bun run ci

FROM base AS runtime
ENV NODE_ENV=production

COPY package.json bun.lock ./
RUN --mount=type=cache,target=/root/.bun/install/cache \
	bun install --frozen-lockfile --production

COPY --chown=bun:bun src ./src
RUN chown -R bun:bun /app

USER bun

CMD ["bun", "run", "start"]
