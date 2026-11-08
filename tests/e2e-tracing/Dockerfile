FROM node:22-bookworm-slim

WORKDIR /workspace

COPY services/payments-wallet/package*.json ./services/payments-wallet/
RUN cd services/payments-wallet && npm ci

COPY services/notifications/package*.json ./services/notifications/
RUN cd services/notifications && npm ci

COPY services/payments-wallet/src ./services/payments-wallet/src
COPY services/payments-wallet/migrations ./services/payments-wallet/migrations
COPY services/notifications/src ./services/notifications/src
COPY services/notifications/migrations ./services/notifications/migrations

COPY tests/e2e-tracing ./tests/e2e-tracing

CMD ["node", "--test", "tests/e2e-tracing/full-trace.test.mjs"]
