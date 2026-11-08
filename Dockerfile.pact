
FROM node:22-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && update-ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace

# Install Pact dependencies.
COPY contracts/package.json contracts/package-lock.json ./contracts/
RUN cd contracts && npm ci

# Copy real Monolith consumer clients.
COPY bangkok-homeservice/lib/modules/notifications/client.js ./bangkok-homeservice/lib/modules/notifications/client.js
COPY bangkok-homeservice/lib/modules/payments/client.js ./bangkok-homeservice/lib/modules/payments/client.js
COPY bangkok-homeservice/lib/errors.js ./bangkok-homeservice/lib/errors.js

# Install Zod for Monolith consumer clients without building SQLite.
RUN cd bangkok-homeservice \
    && npm init -y \
    && npm install --no-save zod

# Install the actual Notifications provider dependencies.
COPY services/notifications/package.json services/notifications/package-lock.json ./services/notifications/
RUN cd services/notifications && npm ci

# Copy Notifications provider source and migrations.
COPY services/notifications/src ./services/notifications/src
COPY services/notifications/migrations ./services/notifications/migrations

# Install the actual Payments Wallet provider dependencies.
COPY services/payments-wallet/package.json services/payments-wallet/package-lock.json ./services/payments-wallet/
RUN cd services/payments-wallet && npm ci

# Copy Payments Wallet provider source and migrations.
COPY services/payments-wallet/src ./services/payments-wallet/src
COPY services/payments-wallet/migrations ./services/payments-wallet/migrations

# Copy Pact consumer and provider tests.
COPY contracts/pact ./contracts/pact

WORKDIR /workspace

CMD ["node", "--test", "contracts/pact/*.consumer.test.js"]
