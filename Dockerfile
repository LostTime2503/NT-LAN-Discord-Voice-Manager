# --- Build stage: compiles TypeScript to JavaScript ---
FROM node:20-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# --- Runtime stage: only production dependencies and compiled output ---
FROM node:20-alpine AS runtime

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist

# Run as the non-root user already present in the official Node image.
USER node

CMD ["node", "dist/index.js"]
