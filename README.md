# dsh-yaml-include

Native local-file `!include` support for DeepSeek Harness YAML configuration, without JavaScript configuration expressions or generated combined files.

**Compatibility: @deepseek-ai/dsh 0.2.0-rc.2 only.** This is a bootstrap adapter, not an ordinary runtime plugin. It explicitly extends the installed boot parser, Cordis Include and ConfigEditor. No global YAML schema is modified. Other DSH versions and unexpected parser shapes are refused before any target is written.

## Install

The npm package is not published yet. Public source: [yuu1111/dsh-yaml-include](https://github.com/yuu1111/dsh-yaml-include).

```sh
git clone https://github.com/yuu1111/dsh-yaml-include.git
cd dsh-yaml-include
npm ci --ignore-scripts
npm run check
```

Select the exact DSH installation to modify. For a global installation:

```powershell
$dshDir = Join-Path (npm root -g) '@deepseek-ai/dsh'
node src/install.js --dsh-dir $dshDir --dry-run
node src/install.js --dsh-dir $dshDir
```

```sh
node src/install.js --dsh-dir "$(npm root -g)/@deepseek-ai/dsh" --dry-run
node src/install.js --dsh-dir "$(npm root -g)/@deepseek-ai/dsh"
```

The same CLI is packaged as `dsh-yaml-include`. Explicit `--dsh-dir` avoids patching a different DSH installation. Node module resolution supports nested npm/pnpm dependencies and hoisted local dependencies.

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
opencode-go: !include opencode-go.yml
command-code: !include command-code.yml
llama-t4: !include llama-t4.yml
llama-local: !include llama-local.yml
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
node src/install.js --dsh-dir /exact/dsh/package --uninstall
```

Remove native tags before uninstalling or updating DSH. A DSH update may replace the adapter; do not activate include-dependent configuration until a supported adapter is reapplied. A changed DSH version needs a compatible adapter release, not a forced installation. Keep backups until restoration is no longer needed.

## Development

```sh
npm ci --ignore-scripts
npm run check
npm pack --dry-run
```

The default suite checks confinement, graph limits, source preservation, relocation, planning, idempotence and restoration. Set `DSH_TEST_HOST_ENTRY` to a native-patched DSH package.json to run real ConfigEditor integration tests; these use temporary profiles and never start a server or access the real user profile.

```powershell
$env:DSH_TEST_HOST_ENTRY = Join-Path $dshDir 'package.json'
npm run check
```
