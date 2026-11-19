# Contributing

## Setup

```sh
npm install
npm test
```

Development needs Node.js 22 or newer. The published package supports Node 18+ and all modern browsers.

## Workflow

`main` is protected: every change goes through a pull request, and a PR can only be merged when the **CI ok** check is green.

1. Create a branch: `git switch -c my-change`.
2. Make your change with tests. Before pushing, run:
   ```sh
   npm run typecheck && npm run test:coverage && npm run build && npm run check:browser
   ```
3. Push and open a PR: `gh pr create --fill`.
4. CI runs on the PR:
   - **Test (Node 22/24/26)**: type-check, tests with the 90% coverage floor, build, browser-bundle check, and an ESM/CJS smoke test.
   - **Runtime smoke (Node 18/20)**: the built package against all fixtures, on the oldest supported Node versions.
   - **Demo and API docs build**: `npm run site` must succeed.
   - **CI ok**: passes only when all of the above pass. This is the required check.
5. Squash-merge once it's green. Merging to `main` redeploys the demo and API docs to GitHub Pages.

Coverage is enforced in `vitest.config.ts`: lines, statements, functions and branches must each stay at 90% or more. The HTML report is in `coverage/index.html` locally, and is attached to each CI run as an artifact.

If you change hot paths in `src/reader.ts`, `src/writer.ts`, `src/zlib.ts` or `src/binary.ts`, run `npm run bench` before and after and include the numbers in the PR.

## Releasing

Releases are automatic: merging a PR that changes `version` in `package.json` publishes it.

1. On a branch, bump the version without tagging, and move the "Unreleased" entries in `CHANGELOG.md` under the new version:
   ```sh
   git switch -c release/next
   npm version minor --no-git-tag-version   # or patch / major / prerelease --preid=beta
   ```
2. Open a PR (`gh pr create --fill`) and merge it once **CI ok** is green.
3. On `main`, the **Release** workflow sees that `v<version>` does not exist yet. It runs the full CI again, publishes to npm with provenance (`latest`, or `next` for prerelease versions like `1.2.0-beta.0`), and then creates the `v<version>` tag and a GitHub Release with generated notes.

Merges that don't change the version don't publish anything. To retry a failed release, re-run the workflow, or start it manually from the Actions tab (`workflow_dispatch`).

### One-time npm setup

Use one of these:

- **Trusted publishing (recommended, no secrets):** after the first publish, open the package's settings on npmjs.com, add a trusted publisher for GitHub Actions, and set repository `aljopro/aseprite-io`, workflow `release.yml`, environment `npm`.
- **Token:** create an npm automation (granular) token with publish rights and add it as the `NPM_TOKEN` repository secret. The first publish of a new package must use a token or be done manually with `npm publish`.

The `npm` GitHub environment used by the release job can also require a manual approval before publishing (Settings → Environments → npm → Required reviewers).
