FROM node:22-slim
WORKDIR /app

RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

# Install ALL deps (including dev for build)
COPY package*.json ./
RUN npm ci

COPY prisma ./prisma
COPY src ./src
COPY tsconfig.json ./
COPY prisma.config.ts ./

# Generate Prisma client
RUN npx prisma generate

# Compile TypeScript to JS
RUN npx tsc --skipLibCheck --noEmitOnError false

EXPOSE 8080

# Run compiled JS
CMD ["node", "dist/index.js"]
