FROM node:20-bullseye

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

RUN mkdir -p /app/data/whatsapp-session

ENV WHATSAPP_SESSION_DIR=/app/data/whatsapp-session

CMD ["npm", "start"]
