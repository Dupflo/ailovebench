# Project cost

`ailovebench project [folder]` adds up what a project cost in tokens, Claude Code and Codex
together, from its transcripts on your machine.

```
ailovebench project [folder] [--since <date|ISO>] [--until <date|ISO>] [--json] [--write [file.md]]
```

| Option | |
|---|---|
| `folder` | The project folder (default: the current folder). Its subfolders are included. |
| `--since`, `--until` | Period. A bare date (`2026-10-01`) is the whole local day; any ISO date works (`2026-10-01T09:00:00`). Default: from the first session to the last. |
| `--write [file.md]` | Also writes a Markdown report, replacing the previous one. Default: `docs/couts.md` in the measured folder (`docs/` is created if needed). A relative path is relative to where you run the command. |
| `--json` | Machine-readable output (with the written path, if any). |

Output: number of sessions and model requests; tokens (input, output, cache write, cache read,
reasoning); **API-equivalent cost** in total, by tool (Claude / Codex) and by model; period covered;
active time (breaks longer than 15 minutes are left out). A model missing from the price table is
"not priced", never 0 $. The interface follows the system language (French or English,
`AILOVEBENCH_LANG=en|fr` to force).

## What is counted

| Tool | Where | Matched on |
|---|---|---|
| Claude Code — Claude Desktop (Claude Code mode), CLI, subagents | `~/.claude/projects/*/*.jsonl` and `<session>/subagents/*.jsonl` (`CLAUDE_CONFIG_DIR` if set) | the `cwd` written in the transcript |
| Codex — ChatGPT app (Codex mode), `codex` TUI, `codex exec` | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` and `~/.codex/archived_sessions/` (`CODEX_HOME` if set) | `session_meta.payload.cwd` |

A session belongs to the project when its working directory is the folder or one of its
subfolders (`/work/site-old` is not inside `/work/site`). On Windows the comparison ignores case
and `/` vs `\`. Claude's folder names (slugs) are never rebuilt: the `cwd` is read from each
transcript.

A request copied into another transcript — a resumed Claude session, a forked Codex session — is
counted once. Prices come from the dated table `data/prices.json`, never fetched at run time.

Privacy: prompts and answers are read by the parsers but never printed or written; the report
holds numbers and model names only. `~/.claude` and `~/.codex` are only read.

## For your agent

The command is non-interactive, needs no terminal UI, and exits with code 0, so the agent can run it.

**CLAUDE.md / AGENTS.md (français)**

> Coûts du projet : quand je demande « le bilan des coûts », ou à la fin de chaque grande étape
> (PRD, maquette, génération du site, livraison), lance `npx ailovebench project . --write docs/couts.md`,
> puis résume-moi le total et la part Claude / Codex.

**CLAUDE.md / AGENTS.md (English)**

> Project cost: when I ask for "the cost report", or at the end of each major step (PRD, mockup,
> site generation, delivery), run `npx ailovebench project . --write docs/couts.md`, then give me
> the total and the Claude / Codex split.

### Optional: refresh the report when a Claude Code session ends

Not installed by default. In the project's `.claude/settings.json`:

```json
{
  "hooks": {
    "SessionEnd": [
      { "hooks": [{ "type": "command", "command": "npx -y ailovebench project . --write docs/couts.md" }] }
    ]
  }
}
```

Hooks run in the project folder, so `.` is the project. Codex sessions are picked up the next time
the report is written.

## Known limits

- A session is attributed by the folder it **started** in: a session started elsewhere that later
  worked in the project is not counted (and one started in the project counts in full).
- Codex rollouts carry `cache_write_input_tokens` (seen from 0.132 to 0.159), but it has always been 0 so far: Codex
  cache writes show as 0 (cached reads are counted). If it fills in, it is billed as a cache write.
- Usage of other tools (Cursor, the claude.ai or chatgpt.com chats, API calls made by your own code)
  is not in these transcripts and is not counted.
- The cost is an API-equivalent estimate, not what a subscription actually costs you.
