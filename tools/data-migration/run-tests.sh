#!/bin/sh
set -eu
cd "$(dirname "$0")/../.."
export PYTHONDONTWRITEBYTECODE=1
migration_fixture_root=$(mktemp -d "${TMPDIR:-/tmp}/homeservice-migration.XXXXXX")
export SNAPSHOT_FIXTURE_DIR="$migration_fixture_root/snapshot"
compose() { docker compose -p homeservice-migration-test -f tools/data-migration/compose.test.yml "$@"; }
cleanup() { compose down --remove-orphans; rm -rf "$migration_fixture_root"; }
trap cleanup EXIT
python3 -m unittest discover -s tools/data-migration -p test_export.py -v
python3 - "$migration_fixture_root" <<'PY'
import importlib.util
from pathlib import Path
import sys
root=Path('tools/data-migration')
spec=importlib.util.spec_from_file_location('fixtures',root/'test_export.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
directory=Path(sys.argv[1]);m.make_source(directory/'source.sqlite')
m.module.export_snapshot(directory/'source.sqlite',directory/'snapshot',writers_stopped=True)
PY
compose up -d --wait notifications-db payments-db
compose run --rm test
