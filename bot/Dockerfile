FROM node:22-slim

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY config.json ./
COPY sql ./sql
COPY src ./src

# Runs as the unprivileged "node" user that ships with the image.
USER node
EXPOSE 8080
CMD ["node", "src/cli.js", "serve"]
