# Area E — six agreed tracking tasks

These titles follow the six-task checklist used with the lead, not a claim to
replace the course rubric. Scope is the fresh authenticated deployment with
synthetic data; historical identity/data eligibility and cutover remain separate.

| Task | Current evidence |
|---|---|
|1. Logging & Monitoring|Actual correlated JSON logs, both Prometheus targets and all three provisioned Grafana expressions: [PR58](https://github.com/digi1450/des428-capstone-homeservice/pull/58)|
|2. Distributed Tracing|Three real business graphs plus durable retry/recovery parents: [PR58](https://github.com/digi1450/des428-capstone-homeservice/pull/58), [PR61](https://github.com/digi1450/des428-capstone-homeservice/pull/61)|
|3. Pact & CI|Ordered consumer/provider Pact, schema/service/boundary/tracing checks and local act: [PR55](https://github.com/digi1450/des428-capstone-homeservice/pull/55)|
|4. Docker & Readiness|Actual16-service authenticated mode and persistent whole-stack restart: [PR57](https://github.com/digi1450/des428-capstone-homeservice/pull/57)|
|5. Reliability & Integration|Real confirm/pre-commit/pre-ack crashes, no duplicate effects, lease/retry and standalone recovery: [PR61](https://github.com/digi1450/des428-capstone-homeservice/pull/61)|
|6.8GB Resource Budget|[Method and thresholds](e-task6-resource-budget-handoff.md), [passing local measured workload](validation/e-task6-resource-budget-2026-11-10.md); PR/hosted CI records final delivery state|

Task6 is specifically load testing and RAM measurement/budget, not a renamed
general final-delivery bucket. Browser acceptance on current main, offline
packaging/clean clone, four final demos, dossier/contribution/AI disclosure and
recording are additional submission work. Whole8GB physical-host qualification,
large-history/long-soak capacity and every Area D race are not implied by this
bounded workload's resource result.
