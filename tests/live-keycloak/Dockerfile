FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /repo
ADD source.tar /repo/
RUN npm ci --prefix bangkok-homeservice && npm ci --prefix services/payments-wallet && npm ci --prefix services/notifications
RUN npm run build --prefix bangkok-homeservice
WORKDIR /repo/bangkok-homeservice
CMD ["node", "../tests/live-keycloak/verify.mjs"]
