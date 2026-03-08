FROM node:22-slim
WORKDIR /app

# Install Prisma dependencies
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev

COPY prisma ./prisma
COPY src ./src
COPY tsconfig.json ./
COPY prisma.config.ts ./

RUN npx prisma generate
RUN npx tsc --skipLibCheck || true

EXPOSE 8080
CMD ["node", "--loader", "ts-node/esm", "src/index.ts"]
