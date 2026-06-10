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

## After Publish

- Verify npm has the new version:

  ```bash
  npm view samocall version
  ```

- Smoke-test the registry package from a clean prefix:

  ```bash
  tmp="$(mktemp -d)"
  npm_config_prefix="$tmp" npm install -g samocall
  PATH="$tmp/bin:$PATH" samocall --version
  rm -rf "$tmp"
  ```

- Confirm the package page shows Apache-2.0 license, homepage, README, and provenance.
- Confirm GitHub Pages is healthy at `https://samoagent.dev/`.

## Secret Hygiene

- Keep `NPM_TOKEN` only in GitHub Actions secrets.
- Rotate `NPM_TOKEN` immediately if it is pasted into chat, logs, issues, PRs, or local shell history.
