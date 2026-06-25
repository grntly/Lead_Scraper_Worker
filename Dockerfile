FROM node:22-slim

WORKDIR /app
COPY package.json ./
COPY src ./src

ENV NODE_ENV=production
ENV PORT=8080

CMD ["node", "src/server.mjs"]

