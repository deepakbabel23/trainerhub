# Only needed if your host wants a container. Render/Railway do not.
FROM node:22-alpine
WORKDIR /app
COPY . .
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
EXPOSE 3000
USER node
CMD ["node", "server.js"]
