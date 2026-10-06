# How it works

```
src/
├── cli.ts, wizard.ts      commands and the interactive wizard
├── agents/                one adapter per agent CLI: Claude Code, Codex, Cursor
├── runner/                waves, jobs, agent sessions (herdr), sandbox, live board, showcase
├── checks/                automatic QA: build, browser, Lighthouse, WebGL, video, scenarios, tests
├── qa/                    bugs, black-box tester, fix prompts, planted bugs, contamination
├── measure/               transcripts → tokens → API-equivalent cost; quota readings
└── report/                HTML slides + PDF, report rules
catalog/                   the tasks (brief, delivery contract, hidden checks)
data/                      dated price table, subscription plans
```

## A run

A run is a plan — projects × models × modes — executed in **waves**: one project at a time, every
selected model in parallel, each in its own job folder. Everything lands in
`~/.ailovebench/runs/<run-id>/`:

```
<run-id>/
├── run.json                     machine, versions, plan, waves
├── <task>__<model>__<mode>/     one job
│   ├── work/                    the agent's sandbox (a fresh git repo, starter files if any)
│   ├── qa/round-N/              evidence: screenshots, Lighthouse, video contact sheet…
│   ├── phases/                  Cursor streams (script mode)
│   ├── sandbox.sb               macOS sandbox profile
│   └── job.json                 status, phases, QA rounds, bugs, measure, verdict
└── report/                      index.html, assets/, PDF
```

## A job

1. **Prepare** — copy the starter into a fresh folder. In *bare* mode the agent gets nothing of the
   user's setup: Claude Code runs with `--safe-mode`, Codex with its own throwaway `CODEX_HOME`,
   Cursor with a throwaway `HOME`. With *harness*, the user's own configuration is used.
2. **Isolate** — on macOS the agent's shell runs under `sandbox-exec`: `~/.ailovebench` and the
   installed package (hidden tests, checks' source) are unreadable, except the job's own folder.
   The bench proves it before starting the agent.
3. **Build** — the agent is driven through herdr panes (interactive agents) or its script mode
   (Cursor), with the task brief and the same autonomy rules for everyone.
4. **QA** — the task's checks run on the delivered product (`catalog/<task>/task.yaml`). Repair
   tasks also run every check on the untouched starter first, so planted bugs are on record.
   Optionally, a tester from another provider explores the product in a browser and writes a
   Playwright script per bug; a bug counts only if its assertion fails twice.
5. **Fix rounds** — confirmed bugs go back to the same agent, in the same session, up to 3 rounds,
   each followed by the checks again. Bugs are tracked as fixed, remaining or regressions.
6. **Measure** — usage comes from the agent's own transcript (Claude Code JSONL, Codex rollout,
   Cursor stream), split by phase: first attempt vs. rework. Cost uses `data/prices.json`, dated
   and never fetched at run time. Quota is read from the agent's usage screen before and after.

## Fair play

- Same prompt, same autonomy rules, same reasoning effort, same machine load (models of a wave run
  together).
- Transcripts are searched for other jobs, other runs and the bench's own files; any hit marks the
  job *contaminated*, and it is left out of every comparison.
- Servers an agent leaves running are stopped at the end of its job, so ports stay free for the next.

## The report

`ailovebench report <run>` builds one fixed layout from the `job.json` files: cover, bench
conditions, method, then per project the products, the comparison bars and the planted bugs,
then one slide per case. It must follow [`REPORT_RULES.md`](REPORT_RULES.md). `ailovebench serve`
also serves every product on its own port, so the report's demo links open the real thing.

## Adding a task

```
catalog/<id>/
├── task.yaml     title, category, timeout, deliverable (install, build, static dir), checks
├── prompt.md     the brief sent to every agent
├── starter/      optional: files the agent starts from (repair tasks)
└── hidden/       scenarios.mjs, hidden tests — never shown to the agent
```

Available checks: `build`, `console`, `external_requests`, `responsive`, `lighthouse`, `webgl`,
`scenario`, `visible_tests`, `hidden_tests`, `untouched`, `video`. A repair task can list
`known_bugs` (title, where, symptom, evidence) so the report explains every planted bug.
