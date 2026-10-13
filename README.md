# dsh-yaml-include

[日本語](README.ja.md)

Native local-file `!include` support for DeepSeek Harness YAML configuration, without JavaScript configuration expressions or generated combined files.

**Compatibility: @deepseek-ai/dsh 0.2.0-rc.2 only.** This adapter patches boot-time configuration loading before profiles are read; it does not need to be enabled as an ordinary bundle plugin. It explicitly extends the installed boot parser, Cordis Include and ConfigEditor. No global YAML schema is modified. Other DSH versions and unexpected parser shapes are refused before any target is written.

## Install

The first npm release of `dsh-yaml-include@0.1.0` is still pending. After publication, install the public package and run its packaged CLI:

```sh
pnpm add --global dsh-yaml-include
dsh-yaml-include --dsh-dir /exact/dsh/package --dry-run
dsh-yaml-include --dsh-dir /exact/dsh/package
```

Replace `/exact/dsh/package` with the actual installed `@deepseek-ai/dsh` package directory, not its executable or the adapter directory. Always pass `--dsh-dir`; npm and pnpm installations can live in different locations. For a global installation, `npm root -g` or `pnpm root -g` can help locate the package, but verify that it belongs to the DSH command being used. If pnpm's global bin directory is not on PATH, run `pnpm setup` and reopen the shell. Node module resolution supports nested npm/pnpm dependencies and hoisted local dependencies.

### Install from source before publication

The public source is [yuu1111/dsh-yaml-include](https://github.com/yuu1111/dsh-yaml-include). With pnpm 12.3.4 and Node.js available:

```sh
git clone https://github.com/yuu1111/dsh-yaml-include.git
cd dsh-yaml-include
pnpm install --frozen-lockfile --ignore-scripts
pnpm run check
node dist/src/install.js --dsh-dir /exact/dsh/package --dry-run
node dist/src/install.js --dsh-dir /exact/dsh/package
```

Installation does not start or restart a server. **Restart DSH after applying the adapter**, and after editing included files.

## Native configuration

Write tags directly in an ordinary bundle patch:

```yaml
- id: llm-pi-ai
  name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers: !include ../providers/models.yml
- id: llm-deepseek
  name: '@deepseek-ai/dsh-llm-deepseek-api-key'
  config: !include ../providers/deepseek.yml
```

Provider index:

```yaml
primary: !include primary.yml
secondary: !include secondary.yml
local: !include local.yml
```

Each reference is relative to its containing file. Includes replace a scalar with one parsed YAML value; lists are not spliced or deep-merged. Anchors work inside their document, not across files. Relative plugin module names in included entries retain DSH's original root-patch anchoring rules.

The containment root is the nearest containing package directory, or the document directory when no package exists. Keep shared provider files within the same bundle package.

## Settings UI

Bundle-owned includes are inherited normally. GUI edits write the existing profile override; reset restores the inherited settings. Bundle and provider source files are never rewritten.

If a **profile patch itself** includes data in the edited row, GUI editing and reset are rejected with a source-edit instruction. This prevents silent inline expansion. Other rows remain editable while preserving include tags, paths and comments. Aliases and duplicate target IDs are checked too. Cordis Include full-file writes likewise reject include-containing sources.

## Safety

- Local YAML files only; no HTTP, globs, absolute references or root escapes
- Canonical-path checks reject symlink escapes
- Reject circular includes, circular aliases and non-finite numbers
- Per read: 1 MiB input, 128 files, depth 32
- Expanded graph: depth 32, 100,000 node visits, 1 MiB of strings
- Errors omit YAML contents and include scalar values
- Existing expression tags remain parseable for backward compatibility, but this adapter never evaluates them
- Standalone reader defaults to data-only JSON_SCHEMA and rejects executable tags

A trusted local filesystem is required. This is not an OS sandbox against another process replacing files during a read. Included-file watching is not implemented; restart to guarantee reevaluation.

## Updates and restoration

Original backups are stored outside the npm package under `~/.dsh-yaml-include/native-backups`; `--backup-dir` can relocate them. SHA-256 validation checks installed targets and original backups. The installer plans all targets first, prevents concurrent operations and rolls back completed writes on a handled failure. Re-running is idempotent and can update helpers while retaining original backups. Unexpected local changes are refused rather than overwritten.

```sh
dsh-yaml-include --dsh-dir /exact/dsh/package --uninstall
```

For a source installation, use `node dist/src/install.js` in place of `dsh-yaml-include` in the uninstall command. Remove native tags before uninstalling or updating DSH. A DSH update may replace the adapter; do not activate include-dependent configuration until a supported adapter is reapplied. A changed DSH version needs a compatible adapter release, not a forced installation. Keep backups until restoration is no longer needed.

## npm releases

Release automation is prepared, but the first bootstrap publication and npm Trusted Publisher setup have not been completed. The release workflow runs when a GitHub Release is published: tag `v0.1.0` must match package version `0.1.0`. It builds with pnpm, runs strict checks and smoke tests, and passes the packed tarball as an artifact to a separate job for OIDC-authenticated npm publication with provenance. Development remains on pnpm; only registry publication uses the npm CLI, not `pnpm publish`. See the [release guide](docs/releasing.md) for bootstrap and Trusted Publisher setup before publishing a Release.

## Development

Development uses pnpm 12.3.4, pinned in `packageManager`. Quality checks require Bun 1.4.3 in addition to Node.js. The installed CLI does not require Bun.

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm run check
pnpm run check:quality
pnpm pack --dry-run
```

Source, tests and scripts are written in TypeScript. `pnpm run build` compiles them into `dist`; the package exports and CLI use the generated JavaScript in `dist/src` and include type declarations. Run the build before using the CLI; the TypeScript source is not executed directly.

`pnpm run check` runs strict type checking, builds and tests the compiled code. `check:quality` runs Biome, TypeScript, Knip and the built-in style checks using the shared `@yuu1111` configurations. Findings are reported without a baseline; `pnpm run format` applies formatting.

The default suite checks confinement, graph limits, source preservation, relocation, planning, idempotence and restoration. Set `DSH_TEST_HOST_ENTRY` to a native-patched DSH package.json to run real ConfigEditor integration tests; these use temporary profiles and never start a server or access the real user profile.

```powershell
$env:DSH_TEST_HOST_ENTRY = Join-Path $dshDir 'package.json'
pnpm run check
```
