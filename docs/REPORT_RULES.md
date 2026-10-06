# Report rules

Every ailovebench report uses one fixed layout and must contain what follows. These rules are
checked automatically (`src/report/rules.ts`): a missing item fails the tests and is printed as a
warning when the report is built.

A bench result without its conditions cannot be interpreted: same model, another machine or
another day → other results.

The report is written in the language of the computer that builds it (French or English); the
mandatory sentences below exist in both.

## 1. Cover

| Item | Why |
|---|---|
| Date of the run | models and their prices change |
| Number of tests, projects, models | size of the sample |
| "N tests, one machine, one date: an indication, not a ranking." | mandatory, word for word |

## 2. Bench conditions (own slide, right after the cover)

| Item | Source |
|---|---|
| OS and version, architecture | `run.json` → `machine` |
| CPU and number of cores | `machine.cpu`, `machine.cores` |
| Memory (GB) | `machine.ramGb` |
| GPU (and VRAM when known) | `machine.gpus` |
| Versions: Node, herdr, Claude Code, Codex, Cursor (those present) | `machine`, `versions` |
| Models, reasoning effort, modes (bare / with harness) | `plan` |
| QA: independent tester or checks only; max fix rounds | `plan.tester`, `plan.maxFixRounds` |
| Execution: in waves (parallel) or sequential | `plan.sequential` |
| Agent isolation (sandbox, contamination found) | `job.isolation`, transcripts |
| Date of the price table | `pricesUpdatedAt` |

## 3. Results

- Per project: the products (one screenshot per model) and the comparison bars (cost, time,
  tokens; first attempt and rework).
- One slide per job; one "fixes" slide per job that went through fix rounds.
- Costs are always **API-equivalent costs**, never "price paid".
- A model without a price is "not priced": never estimated, never "0 $". Unknown usage stays unknown.
- A duration of 60 s or more is written in minutes ("12 min 36 s", never "755.7 s").
- Amounts are rounded to the cent ("0.12 $", never "0.11911640000000001 USD").
- Models are written by their readable name ("Grok 4.7 medium · Cursor"), not their id.
- A contaminated job (it read other jobs or the bench's checks) is flagged and never ranked.

## 4. Appendix

- Price table used, with its date.
- "API-equivalent cost estimated from tokens and a dated price table. This is not an invoice." —
  mandatory.

## 5. What a report never does

- Name a universal winner, or compare two different projects with each other.
- Show a number that is not in the run data.
- Load an external resource (font, script, image): the report works offline.
