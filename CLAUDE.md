# farol

CLI that classifies PRs of React + TypeScript frontends, TypeScript backends (GraphQL/REST), Go backends, Python backends and C#/.NET backends as `global`, `unknown`, `touches-existing` or `isolated`, and reports diff coverage / lint signals. Shadow mode only: it informs, never blocks.

`docs/SPEC.md` is the source of truth. Progress lives in `docs/PROGRESS.md`, every decision not in the spec goes to `docs/DECISIONS.md` (dated entry), reason codes are documented in `docs/reasons.md`.

## Commands

- `npm run build` — tsup bundle to `dist/cli.js` (dist/ is committed; rebuild before committing source changes)
- `npm run typecheck` / `npm run lint` / `npm test`
- `UPDATE_GOLDEN=1 npm test` rewrites `test/fixtures/*/expected.json` — review every diff by hand

Run typecheck, lint and test before every commit. Never commit with failing or skipped tests.

## Layout

`src/{cli,config,git,project,routes,backend,decls,golang,python,dotnet,classify,signals,output,report,github}`; `go-helper/` (Go) and `py-helper/` (Python), both stdlib only, and `cs-helper/` (C#, Roslyn from the .NET SDK, no NuGet package) read Go, Python and C# projects for `language: "go"`/`"python"`/`"csharp"`; languages are listed in `src/config/languages.ts`; `src/decls/` turns their JSON into impacts; tests in `test/` (unit, `test/scenarios/` golden tests on real temp git repos built by `test/helpers/`, fixtures in `test/fixtures/<scenario>/{base,head,deleted.txt,expected.json}`).

## Rules

- English everywhere: code, comments, README, commits and every output (JSON, PR comment, HTML). User-facing text only in `src/report/strings*.ts` (`strings.ts` re-exports the others).
- Pipeline stages are pure functions. Only `cli/`, `git/`, `github/` and `output/write` touch disk, processes or network.
- Git via `child_process.execFile` only. GitHub via native `fetch`. No regex/Babel/tree-sitter to understand imports or routes: use the TypeScript API.
- Never execute code of the analyzed repo. No network except `comment`.
- Fail closed: when in doubt, `unknown` or `touches-existing`, never `isolated`. Never swallow exceptions.
- Output must be deterministic (sorted arrays, `/` paths, injected clock).
- Max 400 lines per source file. The route adapter interface is the only extension point (it may read other modules to follow split route trees).
- New runtime dependency or new top-level module → entry in `docs/DECISIONS.md` first.
