FROM node:24-slim

WORKDIR /app

# Install deps first for cache
COPY package.json package-lock.json ./
COPY scripts ./scripts
RUN npm ci --omit=dev

COPY src ./src

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

CMD ["node", "src/index.js"]
