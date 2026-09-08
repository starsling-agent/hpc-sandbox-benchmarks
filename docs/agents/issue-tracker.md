# Issue tracker: GitHub

Issues and specs live in starslingdev/hpc-sandbox-benchmarks.
Use the `gh` CLI from this clone, or pass
`--repo starslingdev/hpc-sandbox-benchmarks` explicitly.

## Operations

- Create: `gh issue create --title "..." --body-file <file>`
- Read: `gh issue view <number> --comments`
- Inspect labels: `gh issue view <number> --json labels`
- List: `gh issue list --state open --json number,title,body,labels`
- Comment: `gh issue comment <number> --body-file <file>`
- Label: `gh issue edit <number> --add-label "..."`
- Remove label: `gh issue edit <number> --remove-label "..."`
- Close: `gh issue close <number>`

Write multiline bodies to a file and pass `--body-file`.

When a skill says "publish to the issue tracker", create a GitHub
issue. When it says "fetch the relevant ticket", read the issue
and its comments.

## Pull requests as a triage surface

**PRs as a request surface: no.**

GitHub issues and PRs share a number space. When the type is
unclear, resolve it with `gh pr view <number>`, falling back to
`gh issue view <number>`.
