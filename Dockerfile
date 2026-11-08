# Production image for the CallingKaro API.  docker build -t callkaro-api . && docker run --env-file .env -p 5000:5000 callkaro-api
FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY scripts ./scripts
# SQL migrations run at boot (tables are created on the first start)
COPY migrations ./migrations
USER node
EXPOSE 5000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -qO- http://127.0.0.1:5000/health || exit 1
CMD ["node", "src/server.js"]
