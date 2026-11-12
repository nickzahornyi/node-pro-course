# syntax=docker/dockerfile:1.7
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
# The public registry needs no token; the bait exercises exactly the same secret mount.
# The token exists only in the npm process environment, never in an image layer.
RUN --mount=type=secret,id=npm_token,required=true \
    NPM_TOKEN="$(cat /run/secrets/npm_token)" npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev && rm -rf /root/.npm

FROM gcr.io/distroless/nodejs22-debian12:nonroot AS production
WORKDIR /app
COPY --from=build --chown=65532:65532 /app/node_modules ./node_modules
COPY --from=build --chown=65532:65532 /app/dist ./dist
COPY --chown=65532:65532 package.json ./
COPY --chown=65532:65532 openapi ./openapi
USER 65532:65532
ENV NODE_ENV=production
EXPOSE 3000
CMD ["dist/main.js"]
