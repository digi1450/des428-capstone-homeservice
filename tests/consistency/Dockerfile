FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /repo
COPY bangkok-homeservice/package.json bangkok-homeservice/package-lock.json ./bangkok-homeservice/
COPY services/payments-wallet/package.json services/payments-wallet/package-lock.json ./services/payments-wallet/
RUN npm ci --prefix bangkok-homeservice --omit=dev && npm ci --prefix services/payments-wallet --omit=dev
COPY bangkok-homeservice/lib ./bangkok-homeservice/lib
COPY services/payments-wallet/src ./services/payments-wallet/src
COPY services/payments-wallet/migrations ./services/payments-wallet/migrations
COPY tools/consistency ./tools/consistency
COPY tests/integration/c-consistency-check.test.mjs ./tests/integration/c-consistency-check.test.mjs
CMD ["node", "--test", "tests/integration/c-consistency-check.test.mjs"]
