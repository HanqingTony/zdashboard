FROM node:22-bookworm-slim AS deps

WORKDIR /app
COPY package.json package-lock.json ./
# better-sqlite3 提供 Node 22 / linux-x64 预编译包；若目标平台无预编译，再补 python3 make g++
RUN npm ci --omit=dev

FROM node:22-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY server.js ./
COPY src/ ./src/
COPY public/ ./public/

EXPOSE 3100
USER node

CMD ["node", "server.js"]
