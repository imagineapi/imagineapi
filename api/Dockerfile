# Build stage
FROM node:18.15.0 AS build

WORKDIR /app/image

# Install dependencies and build the extension
COPY image/package*.json ./
RUN npm ci
COPY image .
RUN npm run build

WORKDIR /app/four-images

COPY four-images/package*.json ./
RUN npm ci
COPY four-images .
RUN npm run build


# Final stage
FROM directus/directus:9.23.1


COPY ./build_files/*.png /directus/initial_uploads/

# needed to keep the stucture of the extensions folder
COPY ./extensions /directus/custom-extensions
# had to use a custom path for custom-extensions because /directus/extensions is a volume and it was overriding files copied to it..somehow
COPY --from=build /app/image/dist/index.js /directus/custom-extensions/hooks/image/
COPY --from=build /app/four-images/dist/index.js /directus/custom-extensions/interfaces/four-images/

COPY ./build_files/snapshot.json /directus/
COPY ./build_files/docker-entrypoint.sh /directus/
COPY ./build_files/create-users.sh /directus/

# copy custom run script
COPY ./build_files/user-token.js /directus/

# Switch to root user, change permissions and switch back to node user. Otherwise
# we get the following error: chmod: /directus/docker-entrypoint.sh: Operation not permitted
USER root
# without this we get /bin/sh: ./docker-entrypoint.sh: Permission denied
RUN chmod +x /directus/docker-entrypoint.sh
RUN chmod +x /directus/create-users.sh

# allow us to move custom-migrations/* to migrations/
RUN chown -R node:node /directus/custom-extensions

USER node

# temp volume to debug service/items.js # ODO: comment out
# VOLUME /directus/node_modules/directus/dist/services


EXPOSE 8055


CMD ./docker-entrypoint.sh
