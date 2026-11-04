# Homeservice baseline — 4 November 2026

Source: `bangkok-homeservice/` relative to the repository root. The run occurred before the outer folder was renamed to `des428-capstone-homeservice`.

## Verified in this run

- Original project files are present: README, app/lib sources, tests, lockfile, Dockerfile and Compose.
- Downloaded directory size: approximately 346 MiB as reported by `du -sh`; node_modules approximately 256 MiB and .next approximately 88 MiB. These are allocated-size readings, not ZIP sizes.
- `docker compose config --quiet`: exit 0.
- Started Docker Desktop; checked existing containers before starting this project's service.
- `docker compose run --rm test`: exit 0, 61 tests passed, 0 failed, 0 skipped. The original README describes 59 tests; use the observed 61-test result for this run.
- `docker compose up -d --wait edemand`: exit 0; `edemand-edemand-1` healthy, host port 3000.
- HTTP checks: /, /login, /provider/login, /admin/login, /api/health, /api/ready, /api/categories and /api/services all returned 200. Categories and services each returned four items for the requests made.
- Seeded customer login returned 200 and issued a token. /api/me with that token returned 200. No token is stored in this evidence.

## Evidence files

- `source-sha256.json`: SHA-256 of 135 source/config/test/documentation files, excluding downloaded node_modules, .next, data and Git directories.
- `test-output.txt`: captured final test command output, including TAP results and summary; earlier dependency-build output is not included. Trailing whitespace was removed in this repository copy; the local capture under output/ was preserved.
- `http-smoke.json`: observed HTTP statuses and bounded response details.

## Scope and limitations

- No application source/config files were edited. Downloaded dependencies, build artifacts and data were preserved. Docker builds install dependencies and build inside images.
- Tests use isolated in-memory databases. This is an initial monolith baseline, not proof that the capstone migration or live defence requirements are complete.
- Web page responses were checked over HTTP; no visual browser QA or manual full booking/payment journey was performed in this run.
- This run was not a clean-clone rehearsal: it preceded Git initialization. Repository scaffolding is prepared separately; no GitHub remote was created during the baseline run.
- npm install reported six dependency advisories during the image build (one moderate, four high, one critical). No security triage, dependency upgrade or audit fix was performed; the source baseline was preserved.
- At the end of the baseline run the service was running at http://localhost:3000; this is not a current uptime assertion. The provided Compose file publishes port 3000 on all interfaces; its configuration was preserved for this baseline.

## Reproduce

Run inside the source directory:

```sh
docker compose config --quiet
docker compose run --rm test
docker compose up -d --wait edemand
docker compose ps
```

The initial build requires internet access. The original bootstrap reseeds the container database when the process starts; preserve any future data before restarting if it matters.

Repository setup subsequently adds ignore rules and team documentation. This evidence still describes only the original monolith run. Do not infer that migration requirements are complete.
