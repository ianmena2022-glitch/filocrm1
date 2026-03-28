FROM node:20-alpine

WORKDIR /app

# Copiar dependencias primero (cache de Docker)
COPY backend/package*.json ./
RUN npm ci --only=production

# Copiar el resto del código
COPY backend/ .

# El frontend va en src/public
COPY backend/src/public/ ./src/public/

EXPOSE 3000

CMD ["node", "src/index.js"]
