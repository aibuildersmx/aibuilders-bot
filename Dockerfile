FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json ./

ENV NODE_OPTIONS="--max-old-space-size=512 --no-deprecation"
RUN npm ci --no-audit --no-fund

COPY . .

ENTRYPOINT ["bash", "-c", "bash init-volume.sh && npx tsx src/index.ts"]
