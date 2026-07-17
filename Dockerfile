FROM node:22-alpine
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY server.js ./
COPY public ./public

ENV PORT=5173
ENV DEDEM_PUBLIC=1
EXPOSE 5173

CMD ["node", "server.js"]
