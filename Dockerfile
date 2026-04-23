FROM node:18-alpine

RUN apk add --no-cache git python3 make g++

WORKDIR /app

COPY backend/package*.json ./
RUN npm install --production

COPY backend/ .

EXPOSE 3000

CMD ["node", "src/index.js"]
