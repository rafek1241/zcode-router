# AGENTS.md — zcode-router

Repo: local model router for ZCode (zero runtime deps, Node ≥ 22).
Checks: `npm test` (unit) + `npm run selftest` (mock-provider end-to-end, no keys).
Secrets: never commit keys — upstream keys live in `~/.zcode-router/config.json` only.

## Commit style

- `feat:` / `fix:` / `chore:` / `docs:` / `refactor:` / `test:` + short imperative subject.
- Work on a `feat/...` or `fix/...` branch, open a PR to `master`, wait for CI
  (`.github/workflows/ci.yml`: tests on ubuntu/windows/macos × node 22/24),
  then merge. Direct pushes to `master` only for `chore: bump version` commits.

## Cutting a new package version (release runbook for agents)

Releases are tag-driven (`.github/workflows/release.yml`):
pushing tag `vX.Y.Z` runs matrix tests, verifies the tag matches
`package.json` (`tag != package.json` fails the release), publishes to npm
with provenance, and creates the GitHub release.

1. Land the feature/fix on `master` via PR first; `git status` must be clean.
2. Verify: `npm test` and `npm run selftest` green locally.
3. Bump **only** `package.json` `version` (semver; fixes → patch, new models /
   protocols → minor):
   `git add package.json && git commit -m "chore: bump version to X.Y.Z"`
4. Tag the bump commit (annotated, must equal the version):
   `git tag -a vX.Y.Z -m "zcode-router X.Y.Z"`
5. Push both: `git push origin master && git push origin vX.Y.Z`
6. Watch Actions: the `Release` workflow tests → publishes → `gh release create`.
   If it fails on `tag != package.json`, the tag was cut on the wrong commit —
   delete it (`git tag -d` + `git push origin :refs/tags/vX.Y.Z`), fix, re-tag.

Never force-push, never commit `~/.zcode-router/` state, never publish from a
feature branch.
