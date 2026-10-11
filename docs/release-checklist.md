# Release Checklist

Use this checklist for each npm release.

## Before Release

- Confirm `main` is clean and up to date.
- Run `bun test`.
- Run `bun run build`.
- Smoke-test the built CLI:

  ```bash
  ./dist/cli.js --version
  ./dist/cli.js --help
  ```

- Check package metadata:

  ```bash
  npm pack --dry-run
  ```

- Confirm `package.json` has the intended version, description, homepage, license, files, and keywords.
- Confirm `README.md` installation and usage examples match the current CLI.

## Publish

- Bump `package.json` version.
- Commit and push the version bump.
- Create and publish a GitHub release tag matching the package version, for example `v0.4.1`.
- Wait for the `Publish to npm` GitHub Actions workflow to pass.
- Publish one release at a time and record the workflow run ID for its exact tag.
  The shared `npm-publish` concurrency group serializes registry dist-tag writes,
  but GitHub retains only one running and one pending run: a newer queued run
  cancels the older pending run even with `cancel-in-progress: false`.
  A published GitHub release therefore does **not** prove npm publication.
  Check every requested tag's run outcome. If runs overlapped, let the active
  and pending runs finish, inspect registry versions/dist-tags, then explicitly
  re-dispatch any cancelled publication that is still intended. Do not retry an
  older release blindly and move a dist-tag back from a newer version.

## Release candidates (manual testing before final)

- Use a SemVer RC package version, for example `0.9.0-rc.1`, and a matching
  `v0.9.0-rc.1` tag. Check both npm versions and GitHub tags for collisions first.
- Merge the reviewed preparation PR and all intended changes, then confirm CI is
  green on the exact final `main` SHA. Run the pre-release checks above.
- Create a GitHub **prerelease**, targeting that verified SHA (not the moving
  branch):

  ```bash
  gh release create v0.9.0-rc.1 --target <verified-sha> \
    --prerelease --latest=false --generate-notes
  ```
- The npm workflow requires the tag to match `package.json` and GitHub's
  prerelease flag to agree with the version. RCs publish with **`--tag rc`**;
  stable releases use `--tag latest`. Production dated tags never publish npm.
- A manual workflow retry requires an **existing release tag** and an explicit
  matching `rc` or `latest` channel. Missing or inconsistent inputs fail closed.
- Verify `npm view samograph dist-tags --json`: `rc` must name the candidate and
  `latest` must remain on the previous stable release. Install the exact RC
  version into a clean prefix for smoke/manual testing.
- Stop for owner manual testing. Do not publish a stable version or cut a dated
  production deploy tag until separately authorized.

## After Publish

- Verify npm has the new version:

  ```bash
  npm view samograph version
  ```

- Smoke-test the registry package from a clean prefix:

  ```bash
  tmp="$(mktemp -d)"
  npm_config_prefix="$tmp" npm install -g samograph
  PATH="$tmp/bin:$PATH" samograph --version
  rm -rf "$tmp"
  ```

- Confirm the package page shows Apache-2.0 license, homepage, README, and provenance.
- Confirm GitHub Pages is healthy at `https://samoagent.dev/` (domain intentionally kept as-is during rename transition).

## Secret Hygiene

- Keep `NPM_TOKEN` only in GitHub Actions secrets.
- Rotate `NPM_TOKEN` immediately if it is pasted into chat, logs, issues, PRs, or local shell history.
