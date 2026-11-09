#!/usr/bin/env bash
# Run after realm import using an authenticated Keycloak kcadm.sh session.
# Example: KCADM=/opt/keycloak/bin/kcadm.sh bash infra/keycloak/assign-service-roles.sh
set -euo pipefail
KCADM="${KCADM:-kcadm.sh}"
REALM="${KEYCLOAK_REALM:-homeservice}"
PAYMENTS_CLIENT="$("$KCADM" get clients -r "$REALM" -q clientId=payments-wallet-service --fields id --format csv --noquotes | tail -n 1)"
[[ -n "$PAYMENTS_CLIENT" ]] || { echo "Missing payments-wallet-service" >&2; exit 1; }
grant() {
  local client="$1"; shift
  local service_client_id user_id
  service_client_id="$("$KCADM" get clients -r "$REALM" -q "clientId=$client" --fields id --format csv --noquotes | tail -n 1)"
  [[ -n "$service_client_id" ]] || { echo "Missing client $client" >&2; exit 1; }
  user_id="$("$KCADM" get "clients/$service_client_id/service-account-user" -r "$REALM" --fields id --format csv --noquotes | tail -n 1)"
  [[ -n "$user_id" ]] || { echo "Missing service account $client" >&2; exit 1; }
  "$KCADM" add-roles -r "$REALM" --uusername "service-account-$client" --cclientid payments-wallet-service --rolename "$1"
  shift
  for role in "$@"; do
    "$KCADM" add-roles -r "$REALM" --uusername "service-account-$client" --cclientid payments-wallet-service --rolename "$role"
  done
}
grant booking-service booking:create booking:query booking:cancel booking:activate booking:complete_financial booking:cancel_financial booking:query_financial
grant mock-gateway-service mock-gateway:settle_webhook
echo "Service-account roles assigned. Verify tokens and ensure no unrelated roles are granted."
