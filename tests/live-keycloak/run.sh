#!/usr/bin/env bash
# Disposable, repeatable A/B acceptance. Never uses E's final Compose or existing Keycloak.
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
project="${LIVE_OIDC_PROJECT:-homeservice-live-oidc-$$}"
export LIVE_OIDC_FIXTURES="$(mktemp -d "${TMPDIR:-/tmp}/homeservice-live-oidc.XXXXXX")"
export LIVE_OIDC_RUNNER_IMAGE="${LIVE_OIDC_RUNNER_IMAGE:-$project-acceptance}"
compose=(docker compose -p "$project" -f "$root/tests/live-keycloak/compose.yml")
cleanup(){
  status=$?
  "${compose[@]}" logs --no-color > "$LIVE_OIDC_FIXTURES/infrastructure.log" 2>&1 || true
  "${compose[@]}" down --volumes --remove-orphans > "$LIVE_OIDC_FIXTURES/cleanup.log" 2>&1 || true
  echo "Disposable acceptance logs: $LIVE_OIDC_FIXTURES"
  exit "$status"
}
trap cleanup EXIT
python3 "$root/tests/live-keycloak/prepare.py" "$LIVE_OIDC_FIXTURES"
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$LIVE_OIDC_FIXTURES/key.pem" \
  -out "$LIVE_OIDC_FIXTURES/cert.pem" -days 1 -subj /CN=keycloak \
  -addext 'subjectAltName=DNS:keycloak,DNS:localhost,IP:127.0.0.1' > "$LIVE_OIDC_FIXTURES/certificate.log" 2>&1
# Disposable test key, readable by Keycloak's non-root UID; never a deployment key.
chmod 644 "$LIVE_OIDC_FIXTURES/key.pem"
mkdir "$LIVE_OIDC_FIXTURES/context"
python3 - "$root" "$LIVE_OIDC_FIXTURES/context/source.tar" <<'PY'
import pathlib,subprocess,sys,tarfile
root=pathlib.Path(sys.argv[1])
files=subprocess.check_output(['git','ls-files','-z','--cached','--others','--exclude-standard','--','bangkok-homeservice','services','contracts','infra/keycloak','tests/live-keycloak'],cwd=root).split(b'\0')
with tarfile.open(sys.argv[2],'w') as archive:
 for raw in files:
  if not raw:continue
  name=raw.decode();p=root/name
  if p.is_file():archive.add(p,arcname=name,recursive=False)
PY
cp "$root/tests/live-keycloak/Dockerfile" "$LIVE_OIDC_FIXTURES/context/Dockerfile"
docker build -t "$LIVE_OIDC_RUNNER_IMAGE" "$LIVE_OIDC_FIXTURES/context" > "$LIVE_OIDC_FIXTURES/build.log" 2>&1
"${compose[@]}" up -d --wait --wait-timeout 180 keycloak payments-db notifications-db rabbitmq
"${compose[@]}" run --rm --no-deps acceptance | tee "$LIVE_OIDC_FIXTURES/acceptance.log"
# Re-import from empty ephemeral stores with NEW realm signing keys. Reuse the compiled Next
# image/cache to prove JWKS is not pinned by Next's persistent fetch cache.
"${compose[@]}" up -d --force-recreate --wait --wait-timeout 180 keycloak payments-db notifications-db rabbitmq
"${compose[@]}" run --rm --no-deps acceptance | tee "$LIVE_OIDC_FIXTURES/reimport-acceptance.log"
