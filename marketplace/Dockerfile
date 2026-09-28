FROM node:22-alpine AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine3.22 AS runtime
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY openapi ./openapi
COPY .env.example ./
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]

FROM runtime AS ops
USER root
RUN apk add --no-cache postgresql17-client
COPY scripts/ops ./scripts/ops
USER node
