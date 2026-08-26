FROM node:20-slim
WORKDIR /app

# Bot deps (discord.js v14, isolated)
COPY bot/package*.json ./bot/
RUN cd bot && npm install --omit=dev

# Selfbot deps (discord.js-selfbot-v13, isolated)
COPY selfbot/package*.json ./selfbot/
RUN cd selfbot && npm install --omit=dev

# App code
COPY . .

CMD ["sh", "start.sh"]
