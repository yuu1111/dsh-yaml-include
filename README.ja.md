# dsh-yaml-include

[English](README.md)

DeepSeek Harness の YAML 設定で、ローカルファイルを `!include` タグで読み込めるようにします. JavaScript の設定式や、複数の設定を結合した生成ファイルは不要です.

**対応バージョンは @deepseek-ai/dsh 0.2.1-rc.2 のみです.** プロファイルを読み込む前の起動処理を修正するアダプターで、通常のバンドルプラグインとして有効にする必要はありません. インストール済み DSH の起動用パーサー、Cordis Include、ConfigEditor を直接拡張します. グローバルな YAML スキーマは変更しません. 別の DSH バージョンや想定外のパーサー構造を検出した場合は、対象ファイルに書き込む前に処理を中止します.

## インストール

次の手順で npm パッケージをインストールし、配布 CLI を実行します.

```sh
pnpm add --global dsh-yaml-include
dsh-yaml-include --dsh-dir /exact/dsh/package --dry-run
dsh-yaml-include --dsh-dir /exact/dsh/package
```

`/exact/dsh/package` は、実際にインストールした `@deepseek-ai/dsh` のパッケージディレクトリに置き換えてください. DSH の実行ファイルや、このアダプターのディレクトリは指定しません. まず `--dry-run` で変更予定を確認し、その後に適用します.

npm と pnpm ではインストール先が異なることがあるため、必ず `--dsh-dir` を明示してください. グローバルインストール先を探すには `npm root -g` や `pnpm root -g` を使えますが、実行している DSH に対応するパッケージか確認が必要です. pnpm のグローバル実行ファイルディレクトリが PATH にない場合は、先に `pnpm setup` を実行してシェルを開き直してください. Node のモジュール解決に対応しており、npm/pnpm の入れ子になった依存関係や、ローカルで巻き上げ（hoist）された依存関係も扱えます.

### ソースからインストールする

ソースは [yuu1111/dsh-yaml-include](https://github.com/yuu1111/dsh-yaml-include) で公開しています. pnpm 12.3.4 と Node.js を用意して、次のコマンドを実行してください.

```sh
git clone https://github.com/yuu1111/dsh-yaml-include.git
cd dsh-yaml-include
pnpm install --frozen-lockfile --ignore-scripts
pnpm run check
node dist/src/install.js --dsh-dir /exact/dsh/package --dry-run
node dist/src/install.js --dsh-dir /exact/dsh/package
```

インストーラーはサーバーを起動・再起動しません. **アダプターの適用後と、読み込み先のファイルを編集した後は、DSH を再起動してください.**

## YAML 設定での使い方

通常のバンドルパッチに、直接タグを書きます.

```yaml
- id: llm-pi-ai
  name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers: !include ../providers/models.yml
- id: llm-deepseek
  name: '@deepseek-ai/dsh-llm-deepseek-api-key'
  config: !include ../providers/deepseek.yml
```

プロバイダーをまとめるファイルでも、個別の設定を読み込めます.

```yaml
primary: !include primary.yml
secondary: !include secondary.yml
local: !include local.yml
```

各参照は、そのタグを書いたファイルからの相対パスです. `!include` はスカラーを、読み込み先の YAML を解析して得た1つの値で置き換えます. リストへの要素の挿入や、深い階層までのマージは行いません. アンカーは同じ YAML 文書内で使えますが、ファイルをまたいでは使えません. 読み込んだ項目に相対指定のプラグインモジュール名がある場合は、DSH 本来のルールどおり、元のルートパッチを基準に解決します.

読み込み可能な範囲のルートは、そのファイルを含む最も近いパッケージディレクトリです. パッケージがない場合は、その YAML 文書のディレクトリを使います. 共有するプロバイダー設定は、同じバンドルパッケージ内に置いてください.

## 設定 GUI での編集

バンドル側の `!include` で読み込んだ設定は、通常どおり継承されます. GUI で編集すると既存のプロファイルの上書き設定に保存され、リセットすると継承した設定に戻ります. バンドルやプロバイダーの元ファイルは書き換えません.

ただし、プロファイルパッチ自体が編集対象の行で `!include` を使っている場合は、GUI での編集とリセットを拒否し、元ファイルを編集するよう案内します. 読み込んだ内容を、通知せずにその場へ展開して保存することを防ぐためです. 他の行は、タグ・パス・コメントを保ったまま編集できます. エイリアスと対象 ID の重複も確認します. Cordis Include によるファイル全体の書き込みでも、`!include` を含む元ファイルへの書き込みを拒否します.

## 安全性と制限

- 読み込めるのはローカルの YAML ファイルのみです. HTTP、glob、絶対パスの参照、許可されたルートの外への参照は使えません.
- 正規化した実体パスを確認し、シンボリックリンクを通じたルート外への参照を拒否します.
- 循環する include、循環するエイリアス、非有限の数値を拒否します.
- 1回の読み込みの上限は、入力 1 MiB、128ファイル、深さ32です.
- 展開後のグラフの上限は、深さ32、ノードへの訪問100,000回、文字列の合計 1 MiB です.
- エラーメッセージに YAML の内容や include タグのスカラー値を含めません.
- 後方互換性のため既存の式タグは解析できますが、このアダプターが式を評価することはありません.
- 単体の読み込み API は、既定でデータ専用の `JSON_SCHEMA` を使い、実行可能なタグを拒否します.

信頼できるローカルファイルシステムを前提としています. 読み込み中に別のプロセスがファイルを差し替える操作を防ぐ OS サンドボックスではありません. 読み込み先ファイルの変更監視は未実装のため、確実に再評価するには DSH を再起動してください.

## 更新と元の状態への復元

元ファイルのバックアップは、npm パッケージの外にある `~/.dsh-yaml-include/native-backups` に保存します. `--backup-dir` で保存先を変更できます. インストール先の対象ファイルと元のバックアップは、SHA-256 で検証します.

インストーラーは、すべての対象への変更を先に計画し、同時実行を防ぎます. 処理中に捕捉できるエラーが発生した場合は、完了済みの書き込みを元に戻します. 繰り返し実行しても同じ状態になり、元のバックアップを保持したまま補助ファイルを更新できます. 想定外のローカル変更を検出した場合は、上書きせずに処理を中止します.

```sh
dsh-yaml-include --dsh-dir /exact/dsh/package --uninstall
```

ソースからインストールした場合は、復元コマンドの `dsh-yaml-include` を `node dist/src/install.js` に置き換えてください. アンインストールや DSH の更新前に、設定から `!include` タグを取り除いてください. DSH の更新でアダプターが置き換えられることがあります. 対応するアダプターを再適用するまでは、include に依存する設定を有効にしないでください. DSH のバージョンが変わった場合は、強制インストールではなく、そのバージョンに対応したアダプターのリリースが必要です. 復元が不要になるまではバックアップを残してください.

## npm への公開

npm のパッケージ名は登録済みで、GitHub Actions からの公開には設定済みの npm Trusted Publisher を使います. 公開ワークフローは GitHub Release の公開時に実行され、タグ `v0.1.0` とパッケージのバージョン `0.1.0` の一致を確認します. pnpm でのビルド、strict チェック、smoke テスト後に、pack した tarball を artifact として別ジョブに渡し、OIDC 認証と provenance 付きで npm に公開する構成です. 開発は引き続き pnpm を使い、registry への公開にだけ npm CLI を使います. `pnpm publish` は使いません. Release を公開する前に、[公開手順](docs/releasing.md) で Trusted Publisher の設定とリリース手順を確認してください.

## 開発と検証

開発には `packageManager` で固定した pnpm 12.3.4 を使います. `pnpm run check:quality` には Bun 1.4.3 が必要です. 配布インストーラーの実行に Bun は不要です.

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm run build
pnpm run check
pnpm run check:quality
pnpm pack --dry-run
```

ソースは `src/*.ts` です. `pnpm run build` で JavaScript にビルドし、実行には `node dist/src/install.js` を使います. 配布パッケージの `exports` と `bin` も `dist/src/*.js` を参照します. TypeScript ソースを直接実行する構成ではありません.

`pnpm run check` は、ビルド、strict モードの型チェック、テストを実行します. `check:quality` は、共有の `@yuu1111` 設定を使って Biome、TypeScript、Knip、組み込みのスタイル検査を全ソースに対して実行します. 既存の整形・スタイルの指摘も、ベースラインで除外せずに報告します. `pnpm run format` で整形を適用できます.

通常のテストでは、読み込み範囲の制限、グラフの上限、元ファイルの保持、配置先の変更、変更計画、繰り返し実行、復元を検証します. 実際の ConfigEditor との統合テストを実行するには、アダプターを適用済みの DSH の `package.json` のパスを、環境変数 `DSH_TEST_HOST_ENTRY` に設定してください. このテストは一時プロファイルを使い、サーバーを起動せず、実際のユーザープロファイルにもアクセスしません.

```powershell
$env:DSH_TEST_HOST_ENTRY = Join-Path $dshDir 'package.json'
pnpm run check
```
