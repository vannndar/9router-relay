FROM node:24-alpine@sha256:8a32c8cf649a49915a66e81e7a609223c708d0adabf288ee3f4077d765542f85
WORKDIR /app
COPY package.json store.mjs server.mjs ./
RUN mkdir /data && chown node:node /data
USER node
ENV NODE_ENV=production PORT=3020 PASTE_DB_PATH=/data/paste.sqlite
EXPOSE 3020
CMD ["node", "server.mjs"]
