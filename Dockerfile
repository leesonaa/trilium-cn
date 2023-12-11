FROM node:18.18.2-alpine

ADD trilium-linux-x64-server /app

WORKDIR /app

RUN set -x \
    && apk add --no-cache --virtual .build-dependencies \
        autoconf \
        automake \
        g++ \
        gcc \
        libtool \
        make \
        nasm \
        libpng-dev \
        python3 \
    && npm install \
    && apk del .build-dependencies \
    && npm prune --omit=dev 

EXPOSE 8080
CMD node /app/src/www