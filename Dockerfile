# --- build stage: install production deps ---
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund \
    && npm cache clean --force

# --- runtime stage: minimal alpine image ---
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

# wget is already part of busybox in alpine -> healthcheck works out of the box
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY server.js ./
COPY public ./public

# Drop privileges
USER node

EXPOSE 8080
CMD ["node", "server.js"]
