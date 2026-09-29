# Pi subagent 2.0.0 verification

Verified 2026-09-29 with Pi 0.83.0 and Node 24.13.0.

## Release scope

All child agents use one in-process SDK execution path. There is no CLI runner,
sidecar, or backend selector. Declared extensions are loaded from installed
sources with fresh module state per child. Scoped MCP clients receive explicit
configuration; command-based model credentials are bound to the child's cwd.
Abort is cooperative, not an OS sandbox or hard process kill.

The release includes the already-present model-policy/frontmatter persistence
and prompt-isolation fixes required by the integrated checkout. Team/output
names are validated before filesystem access to reject traversal paths.

## Installed-agent operational checks

The owner's 23 discovered agents were invoked using their actual definitions,
configured models, tool allowlists, extensions, and freeform/parameterized
contracts. Tests used a disposable workspace; intentionally defective review
fixtures were not real project changes. No fixtures were saved as authentic
Cortex records. Required connected retrieval backends were enabled before calls.

| Agent | Bounded check | Result |
|---|---|---|
| advisor | Independent assessment with fixture source evidence | PASS |
| ci-diagnoser | Live failed-build job and log diagnosis, no fixes | PASS |
| context-miner | Local source compression plus live Vault retrieval | PASS |
| executor | Exact scratch-file copy and read-back | PASS |
| experiment-operator | Exact-scope live experiment snapshot | PASS |
| planner | Source-grounded plan without edits | PASS |
| review-architecture | Fixture API/boundary review | PASS |
| review-correctness | Explicit acceptance-criteria violations | PASS |
| review-coverage-gaps | Meaningful missing fixture test; extension discovery | PASS |
| review-critic | Supported/unsupported finding discrimination | PASS |
| review-impact | Verified base/candidate caller propagation | PASS |
| review-nullsafety | Nullable source-to-dereference trace | PASS |
| review-operations | Fixture rollout/rollback assessment | PASS |
| review-performance | Bounded resource/complexity assessment | PASS |
| review-scope | Paired-file comparison; expected diff exit code handled | PASS |
| review-security | Concrete fixture traversal input-to-write path | PASS |
| review-shopify | Applicable fixture guidance, no foreign framework policy | PASS |
| review-silent-failures | Loud exception versus silent wrong-result distinction | PASS |
| review-testing | Triggering regression scenario and assertion | PASS |
| reviewer | Write handoff byte comparison and supported source finding | PASS |
| scout | Caller map and live extension discovery | PASS |
| slack-scanner | Identity verification and exact-channel/day live read | PASS |
| transcript-processor | Date-scoped Calendar retrieval and honest coverage gap | PASS |

Every final invocation recorded backend `sdk`, a successful completion signal,
exit code zero, and no terminal model error. The executor artifact was also
compared byte-for-byte by the orchestrator. Reports and recorded tool calls were
inspected, not merely model return text.

The two Fireworks-configured agents initially failed with model-not-found 404s;
the same IDs failed in the pre-existing Pi CLI. With explicit owner permission,
only those two personal model defaults were changed to `openai/gpt-6-luna:high`
and their exact tasks were rerun successfully. Personal agent definitions are
not part of this package commit.

## Automated checks

- TypeScript typecheck: pass.
- Unit/integration suite: 586 passed; 14 opt-in checks skipped by the default run.
- Host SDK compatibility: 5 passed.
- Opt-in installed-host prompt contract: 11 passed.
- Real Tool Gateway and Buildkite code against local fixtures: 2 passed.
- Diff whitespace check: pass.

Obsolete CLI-routing source assertions were replaced by SDK behavior tests.
Historical CLI argument fixtures remain test-only comparison evidence, not an
execution backend. Tests cover role/resource isolation, models and input schemas,
parallel/chained/background runs, question/resume, retries, interruption, stop,
shutdown, fresh extension state, HTTP/stdio MCP, and setup cancellation.

## Limits

These are operational smoke/integration checks, not exhaustive validation of
all agent reasoning or every downstream feature. Calendar returned an ambiguous
empty response: retrieval worked, but event/notes absence was not asserted and
notes saving/indexing was not exercised. Interactive MCP OAuth requires parent
login first. Legacy SSE and all provider/platform combinations were not tested.
No messages, reactions, experiment mutations, real Cortex writes, push,
publication, or deployment were performed as part of the suite.
