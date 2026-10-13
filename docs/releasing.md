# Publishing dsh-yaml-include

The supported host remains `@deepseek-ai/dsh@0.2.0-rc.2` only. Official versions are published through GitHub Actions with provenance.

## Publisher configuration

The npm namespace was initially registered as `0.0.0-stage`. Do not repeat bootstrap registration, overwrite that version, or unpublish it.

The GitHub deployment environment `npm` is restricted to `v*` release tags and requires maintainer approval. The npm Trusted Publisher matches repository `yuu1111/dsh-yaml-include`, workflow `release.yml`, and environment `npm`.

Inspect the current relationship with npm CLI 11.15 or later:

```sh
npm trust list dsh-yaml-include --json
```

If the repository, workflow, or environment changes, update the Trusted Publisher after reviewing the new publication boundary:

```sh
npm trust github dsh-yaml-include --file release.yml --repository yuu1111/dsh-yaml-include --environment npm --allow-publish --yes
```

Do not add an `NPM_TOKEN` or another long-lived publishing token. Authentication and two-factor prompts must be completed by the maintainer in a trusted interactive terminal, never by sharing codes in chat.

## Release a verified version

1. Update the package version and release notes. Keep the DSH version restriction and the restart requirement visible to users.
2. Run `pnpm install --frozen-lockfile --ignore-scripts`, `pnpm run check`, `pnpm run check:quality`, and `pnpm run smoke`.
3. Commit and push the intended changes, then wait for both Windows and Ubuntu CI to succeed on that exact commit. Do not release a dirty working tree, an unpushed commit, or a failing CI result.
4. Create a GitHub Release with the exact tag `v<package-version>`, such as `v0.1.0`. The current workflow accepts stable versions only, not GitHub prereleases or semver prerelease versions.
5. The release workflow builds and checks without caches or publishing permissions, packs one tarball with packing lifecycle scripts disabled, and uploads an immutable artifact. A separate job in environment `npm` publishes that same tarball with OIDC and `--provenance`; it does not check out sources or install project dependencies.
6. Check that the workflow succeeded and verify the registry version, `latest` dist-tag, published files, and provenance. Install the registry package into an isolated environment and repeat the CLI installation and byte-exact restoration checks against the supported DSH version.

Development and packing use pnpm 12.3.4. Only registry inspection, bootstrap, and the OIDC publish operation use the npm CLI. The release workflow runs `npm pack --dry-run --ignore-scripts` against the already-built package as an additional registry-format check.

## Failed or repeated releases

Do not overwrite or unpublish an existing version. If a workflow fails before publishing, resolve the failure and rerun the workflow after confirming that the version is still unused. If the package is already published, inspect its provenance and contents before deciding whether a new version is needed. Concurrency prevents overlapping runs for the same tag, but rerunning a successful publish will fail because npm versions are immutable.
