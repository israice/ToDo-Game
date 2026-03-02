FROM node:18.20-alpine

RUN apk add --no-cache curl unzip jq \
    && curl -fsSL "https://github.com/bitwarden/sdk-sm/releases/download/bws-v2.0.0/bws-x86_64-unknown-linux-musl-2.0.0.zip" \
    -o /tmp/bws.zip && unzip /tmp/bws.zip -d /usr/local/bin/ && chmod +x /usr/local/bin/bws && rm /tmp/bws.zip \
    && apk del unzip

WORKDIR /app

COPY package*.json ./

RUN npm install --production

COPY . .

CMD ["node", "run.js"]
