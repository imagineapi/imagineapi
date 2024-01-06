# Stage 1: Build stage
FROM node:18.15.0 AS build

WORKDIR /usr/src/app

# Copy package files and install dependencies first to leverage Docker cache
COPY package*.json ./
RUN npm install

# Copy the rest of the source code
COPY . .

RUN npm run build

# Stage 2: Runtime stage
FROM mcr.microsoft.com/playwright:v1.31.2-jammy AS runtime

WORKDIR /usr/src/app

COPY --from=build /usr/src/app/dist ./dist
COPY --from=build /usr/src/app/package*.json ./
COPY --from=build /usr/src/app/docker-entrypoint.sh ./
COPY --from=build /usr/src/app/.env.example .env.example

# without this we get /bin/sh: ./docker-entrypoint.sh: Permission denied
RUN chmod +x ./docker-entrypoint.sh

RUN npm clean-install --only=production

CMD ["./docker-entrypoint.sh"]
