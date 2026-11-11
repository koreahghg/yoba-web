FROM node:24-slim

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server ./server
COPY public ./public
COPY tools ./tools

# 통계 DB는 볼륨(/app/data)에 둔다 → 컨테이너를 다시 만들어도 남음
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node

ENV PORT=8080 DB_PATH=/app/data/yoba-web.db
EXPOSE 8080
CMD ["node", "server/index.js"]
