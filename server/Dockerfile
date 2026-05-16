FROM node:20-alpine
WORKDIR /app
COPY server/package.json ./
RUN npm install --production
COPY server/server.js ./server.js
COPY public/ ./public/
EXPOSE 3004
CMD ["node", "server.js"]
