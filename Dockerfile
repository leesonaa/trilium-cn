FROM node:18.18.2-alpine

COPY Virgil.ttf trilium-linux-x64-server /app

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
    && npm prune --omit=dev \
    && cp ./Virgil.ttf ./node_modules/@excalidraw/excalidraw/dist/excalidraw-assets/

EXPOSE 8080
CMD node /app/src/www
