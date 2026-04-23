FROM node:20-alpine

RUN apk add --no-cache git python3 make g++ && \
    sed -i 's/@SECLEVEL=2/@SECLEVEL=1/g' /etc/ssl/openssl.cnf 2>/dev/null || true

WORKDIR /app

COPY backend/package*.json ./
RUN npm install --production

COPY backend/ .

EXPOSE 3000

CMD ["node", "src/index.js"]
