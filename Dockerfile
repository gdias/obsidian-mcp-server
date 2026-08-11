FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production && npm install typescript @types/node @types/express

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

RUN npm prune --production

# Surfaced on /health so the running build can be identified from outside.
ARG BUILD_REF=unknown
ENV BUILD_REF=$BUILD_REF

ENV NODE_ENV=production
ENV PORT=3000
ENV VAULT_PATH=/vault

VOLUME ["/vault"]

EXPOSE 3000

CMD ["node", "dist/index.js"]
