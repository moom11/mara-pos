FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    TZ=Asia/Riyadh

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server ./server
COPY public ./public

EXPOSE 3000
CMD ["node", "server/index.js"]
