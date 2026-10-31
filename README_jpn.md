<!-- =============================================================================
HYDRA-UMC-OPCUA-SERVER - OPC-UA address space of the robot roster
Copyright (C) JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
GPL-3.0-or-later - see LICENSE
============================================================================= -->

<p align="center">
  <img src="images/HYDRA_UMC_BANNER.svg" alt="HYDRA-UMC-OPCUA-SERVER banner" width="100%">
</p>

# 🏭 HYDRA-UMC-OPCUA-SERVER

<p align="center"><a href="README.md">🇺🇸 English</a> | <a href="README_spa.md">🇪🇸 Español</a> | <a href="README_fra.md">🇫🇷 Français</a> | <a href="README_ita.md">🇮🇹 Italiano</a> | <a href="README_deu.md">🇩🇪 Deutsch</a> | <a href="README_zho.md">🇨🇳 简体中文</a> | 🇯🇵 <b>日本語</b> | <a href="README_por.md">🇵🇹 Português</a></p>

### 🛠️ HydraState オブジェクトを標準化された OPC-UA アドレス空間へマッピング

<p align="center">
  <img src="https://img.shields.io/badge/License-GPL%203.0--or--later-blue.svg" alt="GPL 3.0 or later">
  <img src="https://img.shields.io/badge/Standard-OPC--UA-orange.svg" alt="Standard">
  <img src="https://img.shields.io/badge/Feature-Address%20Space%20Modeling-blue.svg" alt="Feature">
  <img src="https://img.shields.io/badge/Tests-136%20passing-2ea44f.svg" alt="Tests">
  <img src="https://img.shields.io/badge/Version-0.2.1-0f6cbd.svg" alt="Version">
  <img src="https://img.shields.io/badge/Maturity-functional-0F6CBD.svg" alt="Maturity">
</p>

---

**正直な現状確認 - 今日実際に動くもの:** OPC-UA サーバーとアドレス空間のマッピング(`src/server.ts`)は本物であり、テスト済みである(`tests/server.test.ts`、`tests/security.test.ts`、`tests/security-policy.test.ts`, `tests/robotSource.test.ts`, `tests/robotSource.integration.test.ts` 全体で 136 件のテストが成功)。しかもこれらは本物のプロトコルレベルのテストである: `tests/server.test.ts` は本物の `OPCUAClient`(node-opcua 自身のクライアントであり、UAExpert/Ignition が使うのと同じライブラリ)を、本物のバイナリプロトコルで本物の TCP ポートに接続しており、`tests/security-policy.test.ts` は暗号化されていない `SecurityPolicy.None` セッションがデフォルトで実際に拒否されることを証明している(明示的な `OPCUA_ALLOW_INSECURE=1` という抜け道を使った場合のみ受け入れられる)。以下は偶然見つかったギャップではなく、意図的に先送りされているものである: ロボットごとのツリー（`Robot_<id>`）は HYDRA-UMC-SERVER が報告する一覧に追従する（トークンまたはアカウントで取得。`.env.example` を参照）が、アドレス空間のそれ以外の部分は起動時に一度だけ構築される。今のところエンドツーエンドでテストされているのは読み書きのみであり、OPC-UA のサブスクリプションはテストされていない。そして Pub/Sub(ロードマップのフェーズ 1)はまだ実装されていない、依存するクライアントがまだ存在しないためである。何が先送りされ、なぜそうなのかの完全なリストは `mejoras_futuras.txt` を、これまでに何が実際に出荷されたかは `CHANGELOG.md` を参照。

---

> **安全性とセキュリティの現状:** このエコシステムは認証された安全システムではありません。ハードウェアの E-STOP 経路、ファームウェアが強制する制限やインターロック、検証済みの動作コマンドはまだありません。ファームウェアイメージは CRC-32 と Ed25519 署名で検査し、リリースビルドは公開済みの開発用鍵を拒否します(リレーの先のツールヘッドと拡張ボードは引き続き URTC のブートローダーを使い、署名ではなく共有鍵の HMAC-SHA256 を使います)。TLS と相互 TLS は任意で、既定では無効です。独自基板はまだ実装も試験もされていません。ここに書かれた内容を人の安全のために頼る前に、[セキュリティベースライン](https://github.com/JuanenRac/HYDRA-UMC-DOCS/blob/main/docs/SECURITY_BASELINE.md)と[脅威モデル](https://github.com/JuanenRac/HYDRA-UMC-DOCS/blob/main/docs/THREAT_MODEL.md)をお読みください。

---

## 📋 ひと目で

| | |
|---|---|
| バージョン | `0.2.1` |
| 成熟度 | 機能する |
| テスト | 136 (`npm test`) |
| 技術 | Node.js / node-opcua / OPC-UA address space |
| 対象 | HYDRA-UMC セルの Raspberry Pi CM5 |
| 実機での確認 | まだです：このバージョンについて実機での動作記録はありません |

**移動：** [概要](#-概要) · [アーキテクチャ](#-アーキテクチャ) · [設定](#-設定) · [クイックスタート](#-クイックスタート) · [テスト](#-テスト) · [リポジトリの構成](#-リポジトリの構成) · [関連プロジェクト](#-関連プロジェクト)

## 🚦 プロジェクトの状況

各行はこのリポジトリの一部分で、信号は今日どこまで進んでいるかを示します。計画ではなく、リポジトリが示せるもの（テスト、ビルド、実行）に基づいて書かれています。

🟢 完了・検証済み · 🟡 動作する（既知の制限あり） · 🟠 一部のみ、または未検証 · 🔴 未実装または動作しない

| 領域 | 状態 | ここでの意味 |
|---|---|---|
| ソフトウェア | 🟡 | 主な目的では動作します。足りない点は上の正直さの確認に書かれています |
| テスト | 🟢 | 自動テスト 136 件。変更のたびに実行されます |
| 実機 | 🔴 | まだです：このバージョンについて実機での動作記録はありません |
| ドキュメント | 🟢 | 8 言語の README。変更のたびにマニフェストと照合されます |

## 🎯 概要

**HYDRA-UMC-OPCUA-SERVER** は、ゲートウェイの中核となる産業モデリング
モジュールです。内部の動的な HydraState（JSON）を、構造化された発見
可能な OPC-UA アドレス空間へと変換します。

Ignition、Siemens TIA Portal、Rockwell FactoryTalk のような産業用
自動化ソフトウェアが、標準の PLC タグであるかのようにロボット変数を
参照、読み取り、書き込みできるようにします。

### 主な機能：
* 🛠️ **動的な情報モデリング：** アクティブなロボットと工具に基づいて OPC-UA ツリーを自動生成します。
* 🔄 **ロボット一覧と 2 つのフラグ：** ロボット一覧（`Name` と `Online` を持つ `Robot_<id>` オブジェクト）は読み取り専用です。`SwarmOnline` と `MaintenanceMode` も読み取り専用です（書き込みはシステムの他の部分に効果がないため拒否されます）。`SwarmOnline` は、一覧の取得が一度完了するまで `BadWaitingForInitialData` です。関節やエフェクターを制御するノードはありません。
* 🧭 **型付きモデル、ロール、ライブ信号:** セルは `HydraCellType`、各ロボットは `Objects/Robots` フォルダー下の `HydraRobotType` です(名前空間 1 の NodeId は変わりません。モデルはファイル `nodeset/HydraUmc.NodeSet2.xml` で、テストがコードと同一に保ちます)。`Online` はオペレーター画面のスイッチにすぎません。`Live` はロボットが `HYDRA_UMC_OPCUA_LIVE_WINDOW_MS` 以内に HYDRA-UMC-SERVER へパッチを送ったかどうか、`LastUpdate` はその時刻を示し、`HYDRA_UMC_OPCUA_SOURCE=stream`(ポーリングの代わりに WebSocket)が必要で、それ以外は `BadWaitingForInitialData` です。セッションは OPC UA のロールを持ちます。匿名は `Anonymous`、閲覧者は `Observer`、管理者はさらに `ConfigureAdmin` で、書き込めるロールはありません。*(node-opcua のクライアントで試験済み、SCADA では未検証)*
* 🔖 **バージョン管理された名前空間と安定した NodeId：** 実際の明示的な名前空間 URI と、明示的な文字列 NodeId——アドレス空間の更新によって、クライアントが依存するパスが密かに変わることはありません。*(実装済み)*
* 🔐 **セッションごとの書き込み認可：** 匿名セッションと認証済みセッションを区別する、実際の動的なチェック——すべてのクライアントがデフォルトで書き込みアクセス権を得られるわけではありません。*(実装済み)*
* 📡 **サブスクリプションサポート：** OPC-UA のパブリッシュ・サブスクライブ機構を用いた高効率なデータ更新。*（エンドツーエンドでテスト済み：実際のサブスクリプションがデータ変更通知を届ける）*
* 🩺 **運用(すべて任意):** `OPCUA_HEALTH_PORT` は別のリスナーを起動します(`OPCUA_HEALTH_HOST` で変えない限りループバックのみ)。`GET /health` と `GET /metrics`(セッション、サブスクリプション、ログイン失敗、ロボット、一覧を読めるか)を提供します。一覧を読めない間、ロボットの `Online` 変数は単なる `false` ではなく Uncertain 品質の `false` になります。`OPCUA_VIEWER_USERNAME`/`OPCUA_VIEWER_PASSWORD` は読み取り専用アカウントを追加し、`OPCUA_ALLOW_ANONYMOUS=0` は匿名セッションを拒否します。一覧の設定はエコシステム共通の `HYDRA_UMC_SERVER_*` の名前も受け付けます。すべて既定では無効または変更なしです。 *(実装済み)*
* 🛡️ **暗号化：** すべての実際のセッションで Signed または Signed+Encrypted（Basic256Sha256、Aes128_Sha256_RsaOaep、または Aes256_Sha256_RsaPss）が必須です - 暗号化されていない `SecurityPolicy.None` 接続は単に非推奨なのではなく、実際に拒否されます。

## 🧩 HYDRA-UMC での役割

**HYDRA-UMC-OPCUA-SERVER** は `HYDRA-UMC-SERVER` のロボット一覧を、SCADA やオートメーションのソフトウェアが閲覧できる OPC-UA アドレス空間として公開します。セッションは OPC UA のロールを持ち、書き込みできるロールはありません。関節やエンドエフェクターを制御するノードはありません。

## 🏛️ アーキテクチャ

<p align="center">
  <img src="images/architecture.svg" alt="HYDRA-UMC-OPCUA-SERVER architecture" width="100%">
</p>

<details>
<summary>図のテキスト版（Mermaid）</summary>

```mermaid
flowchart LR
    API["Hydra Internal API"] --> MAP["OPC-UA Mapper"]
    MAP --> SPACE["Address Space Tree"]
    SPACE --> TAGS["Standardized PLC Tags"]
    TAGS --> CLIENT["External PLC / SCADA"]
```

</details>

### アーキテクチャと設計上の決定

* **HYDRA-UMC-GATEWAY-INDUSTRIAL のサブモジュールではなく兄弟プロジェクトである理由。** 各プロトコルアダプターは個別にデプロイ/再起動可能なプロセスです——OPC-UA クライアントライブラリの問題が、それと並行して動作する MQTT や MTConnect アダプターをダウンさせることは決してありません。
* **フラットな REST パススルーではなく OPC-UA アドレス空間である理由。** OPC-UA クライアント（SCADA/ヒストリアン）は、型付けされたノードを持つ実際の参照可能なアドレス空間を期待します——フラットな REST パススルーは技術的にはデータを公開できますが、そもそも OPC-UA を話す意味を失わせます。
* **エントリポイントが今日は身元/バージョンのみを表示し、ヘルスチェックリスナーが起動した後で終了する理由。** 足場（アンダミアヘ、スキャフォールディング）段階にあり、親プロジェクト自身の README と同じ理由です——実際のゲートウェイはその性質上長時間稼働するため、プロセスが稼働し続けることを証明することが実際の最初のマイルストーンです。
* **エコシステムの他の部分との関係。** HYDRA-UMC-GATEWAY-INDUSTRIAL の下の兄弟サービスです——HYDRA-UMC-SERVER 自身の状態を実際の OPC-UA アドレス空間へと変換します。
* **コンパイルチェックだけでなく、プロトコルレベルの実際のテスト。** `tests/server.test.ts` は実際の `OPCUAClient`（node-opcua 自身のクライアントで、UAExpert/Ignition が使うのと同じライブラリ）を、実際のバイナリプロトコルを介して実際の TCP ポート上の実際の `OPCUAServer` に接続します——セッションを開き、`SwarmOnline`/`ActiveRobotCount` をパスでブラウズ/読み取りし、クライアントが発行した書き込みが読み戻した値とサーバー側の状態の両方に反映されることを確認します。
* **node-opcua が自動割り当てする数値ではなく、明示的な文字列 NodeId を使う理由。** 数値 NodeId は作成順に割り当てられます——コード内で既存の DataItem の前に新しい DataItem を挿入すると、既存のものが黙って番号を振り直され、古い番号をハードコードしていた産業用クライアントが壊れてしまいます。`s=HydraNode_1.SwarmOnline` のような明示的な NodeId は、アドレス空間のコードの形が変わったというだけの理由でクライアントの足元で変化することは決してありません。
* **`SpindleTemp` が、他の変数が使うよりシンプルな `get()` ではなく `timestamped_get` を使う理由。** `get()` は読み取りのたびに自動的に現在時刻を付与します——ライブな値には適していますが、ゆっくりと変化する値（主軸はポーリングの間に再加熱されたりしません）には不正確です。`timestamped_get` は、値が実際に最後に変化した時刻を追跡する明示的な `sourceTimestamp` を持つ、本物の `DataValue` を返します。これは OPC-UA のヒストリアンが依存する本来のセマンティクスです。
* **`SpindleTemp` の実際のソースが切断されたときに起こること。** 最後の実際の値は引き続き提供され続けます——隠されることも、リセットされることもありません——しかしその `statusCode` は `Good` から node-opcua 自身の本物の標準 OPC-UA ステータスコードである `UncertainLastUsableValue`(「この値を更新していたものが更新を停止した」)に低下し、`sourceTimestamp` は「今」ではなく実際に最後に観測された瞬間を指し続けます。正しく認証・暗号化されたセッションであっても、これは変わりません——それが認証するのはクライアントであって、データの鮮度ではありません。
* **書き込み認可が静的なアクセスレベルフラグではなく、セッションごと（`isUserWritable`）である理由。** 静的な `userAccessLevel` は、あるクライアントのセッションを別のクライアントのセッションと区別できません——どの接続に対しても同じ値だからです。変数ノード上で `isUserWritable(context)` をオーバーライドすることは、実際にセッションごとに変化するチェックのための node-opcua 自身が文書化した仕組みであり、2 つの異なる実際のクライアント ID でテストできるほど本物です。

意図的に後回しにしたものとその理由:ロボットごとの動的なアドレス空間ツリー(現状は起動時に一度だけ構築される静的なツリーで、後から追加したロボットを表示するには再起動が必要)、ロードマップの Pub/Sub 項目(まだ未実装 - 依存するクライアントはまだない)。

## ⚙️ 設定

待ち受けポートは、まず `HYDRA_UMC_OPCUA_PORT` から読み取ります（既定は 4840）。共有の `PORT` は最後の手段として引き続き使え、警告を表示します。そのため、複数のサービスで共有する環境ファイルがサーバーを他のサービスのポートへうっかり移すことはありません。設定されていても有効なポートでない値は起動を止め、コンテナのヘルスチェックも同じ順序に従います。 履歴アクセスは既定で無効です。`HYDRA_UMC_OPCUA_HISTORY=1` で有効になり、`HYDRA_UMC_OPCUA_HISTORY_URL` で HYDRA-UMC-DATALAKE を指定し（読み取りトークンがある場合は `HYDRA_UMC_OPCUA_HISTORY_TOKEN`）、`HYDRA_UMC_OPCUA_HISTORY_MAP` は変数と系列を対応づける JSON ファイルです。対応づけた変数だけが HistoryRead に応答し、匿名セッションは `HYDRA_UMC_OPCUA_HISTORY_ANONYMOUS=1` でない限り拒否され、1 回の読み出しは最大 `HYDRA_UMC_OPCUA_HISTORY_MAX_POINTS` 点（既定 10000）までです。書き込み可能になるものはありません。 加工済み履歴も既定で無効です。`HYDRA_UMC_OPCUA_HISTORY_AGGREGATES=1` で Average、Minimum、Maximum、Count、Interpolative に応答し（1 回の読み出しは最大 `HYDRA_UMC_OPCUA_HISTORY_MAX_INTERVALS` 区間、既定 1000）、`HYDRA_UMC_OPCUA_HISTORY_EVENTS=1` と `HYDRA_UMC_OPCUA_HISTORY_EVENTS_MAP`（オブジェクトごとの限界値ルールの JSON ファイル）で、保存された系列から導いたイベント履歴に応答します。

## 🚀 クイックスタート

Node.js 20 以上と npm が必要です。

```bash
npm install
npm test
npm run build
npm start
```

## 🧪 テスト

`npm test` で自動テスト 136 件を実行します。 ハードウェアも、このマシンの外にあるものも必要ありません。

CI は `HYDRA_UMC_CI=1 python tools/ci_validate.py` を実行し、マニフェスト、文書、8 つの README、図を検査します。

## 🏗️ ビルドとリリース

### 必要条件
- [Node.js](https://nodejs.org/)（v20 以上を推奨）
- npm

### インストール
```bash
npm install
```

### 開発モード
`tsx` を使用して OPC-UA サーバーを直接実行します（バンドラーなし）：
- **Windows：** `dev.bat` をダブルクリックするか、`npm run dev` を実行
- **Linux/Mac：** `./dev.sh` または `npm run dev` を実行

### プロダクションビルド
esbuild を使用してサーバーを単一のデプロイ可能なファイルにバンドル
します：
- **Windows：** `build.bat` をダブルクリックするか、`npm run build` を実行
- **Linux/Mac：** `./build.sh` または `npm run build` を実行

その後、次のコマンドで起動します：
```bash
npm start
```

サーバーは `0.0.0.0:4840`（IANA に登録されたデフォルトの OPC-UA
ポート）でリッスンし、エンドポイントは
`opc.tcp://<host>:4840/HYDRA-UMC-OPCUA-SERVER` です——任意の OPC-UA
クライアント（UAExpert、Ignition、Siemens TIA Portal など）をこの
エンドポイントに向けることで、アドレス空間を参照できます。

### バージョン管理
`npm run build` はサーバーをバンドルするだけです。バージョンを上げるのは `python tools/hydra_project_tool.py bump`（`bump_manifest_version.py` 経由）だけで、ビルドは変更しません。

## 📂 リポジトリの構成

<p align="center">
  <img src="images/repository-structure.svg" alt="Repository structure of HYDRA-UMC-OPCUA-SERVER" width="100%">
</p>

<details>
<summary>ツリーのテキスト版</summary>

```text
HYDRA-UMC-OPCUA-SERVER/
├── src/                       ソースコード（Node/TypeScript —— モデル、サーバー、マッパー）
├── tests/                     Vitest スイート —— サーバーとセキュリティの動作
├── docs/                      OPERATIONS.md: インテグレーターがこのサーバーを動かし、接続し、安全に公開するために必要なこと
├── nodeset/                   HydraUmc.NodeSet2.xml: 名前空間の情報モデルを NodeSet2 ファイルにしたもの (scripts/export_nodeset.ts が書き出して検査)
├── images/                    メディアと図表
├── scripts/                   補助スクリプト (bump-version.mjs、export_nodeset.ts)
├── tools/                     build_test.py (バージョンを変えないビルド確認)、ci_validate.py (CI が使うマニフェスト/CHANGELOG/ドキュメントの検証)、hydra_project_tool.py、共有の _doc_policy.py と _readme_parity.py
├── .github/                   CI ワークフローと Issue テンプレート
├── mejoras_futuras.txt        意図的に後回しにした内容とその理由を完全にまとめた正直なリスト
├── CHANGELOG.md               各バージョンの変更点
├── Dockerfile                 コンテナイメージ
├── build-test.sh              変更を伴わないビルド確認
├── build.sh                   ビルドと検査。バージョンは変更しない
├── bump_manifest_version.py   マニフェストのバージョンを同期
├── dev.sh                     開発モード
├── hydra-umc.project.json     マニフェスト：バージョン、成熟度、ファミリー
├── package.json               パッケージのメタデータとスクリプト
└── test.sh                    テストを実行
```

</details>

## 🗺️ ロードマップと既知の制限

**現時点の既知の制限**

* **フェーズ 1：** 高速データ交換とレガシープロトコルブリッジングのための OPC-UA パブリッシュ/サブスクライブ実装。
* **フェーズ 2：** MQTT Broker はすでに独立したリポジトリとして存在します（[HYDRA-UMC-MQTT-BROKER](https://github.com/JuanenRac/HYDRA-UMC-MQTT-BROKER)）。大量の IoT デバイス管理と高い並行性のためのクラスターは引き続き計画中です。
* **フェーズ 3：** MTConnect アダプターはすでに独立したリポジトリとして存在します（[HYDRA-UMC-MTCONNECT-ADAPTER](https://github.com/JuanenRac/HYDRA-UMC-MTCONNECT-ADAPTER)）。それを超える複数ベンダーの CNC・PLC 機器との統合は引き続き計画中です。
* **フェーズ 4：** OPC UA Robotics コンパニオン仕様への完全準拠と産業用ゲートウェイの同期。

## 🌍 言語

この README とリポジトリの文書は、英語・スペイン語・ドイツ語・フランス語・イタリア語・日本語・中国語・ポルトガル語（ポルトガル）の 8 言語で提供されています。8 つのファイルは同時に書かれ、同じ節と同じリンクを持つことを CI が確認します。 このリポジトリには独自の画面もメッセージカタログもないため、翻訳すべきインターフェース文字列はありません。

## 🔗 関連プロジェクト

本プロジェクトは、同じ作者(JuanenRac / Electro Hobby 3D)による HYDRA-UMC ロボティクスエコシステムの一部です。リクエストが実はこの中のどれかについてのものである可能性があるため、知っておく価値があります。

**親プロジェクト**
- **[HYDRA-UMC-GATEWAY-INDUSTRIAL](https://github.com/JuanenRac/HYDRA-UMC-GATEWAY-INDUSTRIAL)** — 実際のコマンド許可リスト/バックプレッシャー層を持つ、産業用プロトコルへ中継する統合ハブ。本リポジトリは、その自身の産業用ゲートウェイ内における特定のプロトコルアダプターとして、この親の一部を成す。

**兄弟プロジェクト** —— HYDRA-UMC-GATEWAY-INDUSTRIAL 自身の産業用ゲートウェイにおける他のプロトコルアダプター
- **[HYDRA-UMC-MQTT-BROKER](https://github.com/JuanenRac/HYDRA-UMC-MQTT-BROKER)** — クライアント単位のオプション認証とトピック ACL を備えた、実際の MQTT ブローカー。
- **[HYDRA-UMC-MTCONNECT-ADAPTER](https://github.com/JuanenRac/HYDRA-UMC-MTCONNECT-ADAPTER)** — 縮退モード出力を備えた、実際の MTConnect `/probe` および `/current` XML エンドポイント。

**直接関連**
- **[HYDRA-UMC-SERVER](https://github.com/JuanenRac/HYDRA-UMC-SERVER)** — すべての制御クライアントが実際に通信する、本物のヘッドレスバックエンド(REST/WebSocket) ——本アダプターが公開する状態の情報源。

**エコシステムの他のプロジェクト**

*コアハードウェア&プラットフォーム*
- **[HYDRA-UMC](https://github.com/JuanenRac/HYDRA-UMC)** — ロボットアームのマザーボードの設計——CM5 ホスト + デュアルコア STM32H745、CAN-OTA/SPI-OTA 経由で最大 8 本のツールアームを統括することを目指す(ファームウェアは初期段階で、実装済みの基板はまだない)。
- **[HYDRA-UMC-OS](https://github.com/JuanenRac/HYDRA-UMC-OS)** — CM5 向けの再現可能な Raspberry Pi OS プロダクト層——読み取り専用エージェント、検証済み設定/プロファイル、WiFi 初回接続プロビジョニング。
- **[HYDRA-UMC-SDK](https://github.com/JuanenRac/HYDRA-UMC-SDK)** — すべてのブリッジが自身のコマンドを検証する共有 JSON-Schema 契約とソフトウェアのジョブゲート境界(認証済みの安全機能ではない)。
- **[HYDRA-UMC-CONNECTOR-HUB](https://github.com/JuanenRac/HYDRA-UMC-CONNECTOR-HUB)** — 外部マシン用コネクタのための宣言的アダプターマニフェストのレジストリとバリデーター。SDK 自身の契約という発想を外部マシンにまで拡張し、産業用ゲートウェイ系のプロジェクトを置き換えることはありません。

*コアバックエンド&クライアント*
- **[HYDRA-UMC-STUDIO](https://github.com/JuanenRac/HYDRA-UMC-STUDIO)** — リアルタイムのマルチロボット 3D 可視化を備えたウェブ制御ダッシュボード。
- **[HYDRA-UMC-SUITE](https://github.com/JuanenRac/HYDRA-UMC-SUITE)** — 複数のサーバーを同時に扱えるデスクトップ(PySide6)スウォームコマンドセンター、スタンドアロン実行ファイルとしてパッケージ化。
- **[HYDRA-UMC-ANDROID-CONTROL](https://github.com/JuanenRac/HYDRA-UMC-ANDROID-CONTROL)** — 生体認証ログインとペアリングされた Wear OS コンパニオンを備えたネイティブ Android 制御アプリ。
- **[HYDRA-UMC-IOS-CONTROL](https://github.com/JuanenRac/HYDRA-UMC-IOS-CONTROL)** — リアルタイム WebSocket 同期を備えた iOS/iPadOS 制御アプリ(Flutter)。
- **[HYDRA-UMC-DSI](https://github.com/JuanenRac/HYDRA-UMC-DSI)** — 本体搭載の 7 インチ DSI タッチスクリーン向けネイティブタッチ UI、CM5 自体に組み込み。
- **[HYDRA-UMC-EDITOR-URDF](https://github.com/JuanenRac/HYDRA-UMC-EDITOR-URDF)** — 完成したモデルを STUDIO 自身のカタログへ送信するデスクトップ用グラフィカル URDF 作成/編集ツール。
- **[HYDRA-UMC-EDITOR-STL](https://github.com/JuanenRac/HYDRA-UMC-EDITOR-STL)** — HYDRA-UMC-EDITOR-URDF も編集する同じモデルカタログ内で、実在するパーツを変換/置換/削除/追加するデスクトップ STL モデルエディタ。
- **[HYDRA-UMC-BRIDGE-AMR](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-AMR)** — VDA 5050 MQTT パブリッシャーによる AGV/AMR フリートの調整境界(エミュレートしたフリートに対してのみテスト済み)。
- **[HYDRA-UMC-BRIDGE-CNC](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-CNC)** — GRBL ステータス/制御バイトへのアクセスを持つ、CNC セルの高レベルコーディネーター(エミュレーターに対してのみテスト済み)。
- **[HYDRA-UMC-BRIDGE-DROIDS](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-DROIDS)** — Boston Dynamics Spot コマンド送信機能を持つ、脚型/ヒューマノイドドロイドの調整境界(エミュレーターに対してのみテスト済み)。
- **[HYDRA-UMC-BRIDGE-LASER](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-LASER)** — キー/筐体/インターロックの GPIO 信号 3 系統を読み取るレーザーセルのコーディネーター(模擬チップに対してのみテスト済み。レーザーの武装や発射はできない)。
- **[HYDRA-UMC-BRIDGE-OPENPNP](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-OPENPNP)** — OpenPnP ピックアンドプレースの基板フローを安全に統括する高レベルコーディネーター。
- **[HYDRA-UMC-BRIDGE-PRINTER3D](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-PRINTER3D)** — 実際にゲート制御されたジョブコマンドを持つ、Moonraker/Klipper 3D プリンター向けの安全な調整境界。
- **[HYDRA-UMC-BRIDGE-ROS2](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-ROS2)** — 遅延インポートの rclpy ROS 2 トランスポートを持つコーディネーター(ROS 2 環境ではまだ実行していない)。
- **[HYDRA-UMC-BRIDGE-UAV](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-UAV)** — MAVLink コマンド送信機能を持つ、カメラ搭載 UAV の調整境界(エミュレーターに対してのみテスト済み)。

*URTC ツールプラットフォーム*
- **[URTC](https://github.com/JuanenRac/URTC)** — 物理的な Universal Robot Tool Controller 基板向けファームウェア、CAN バス経由の 25 以上のツールプロファイル。
- **[URTC-FLASHER](https://github.com/JuanenRac/URTC-FLASHER)** — URTC 基板用のデスクトップ GUI 書き込みツール、CAN-OTA およびフルチップ SWD/JTAG。
- **[URTC-TESTER](https://github.com/JuanenRac/URTC-TESTER)** — URTC 基板向けのデスクトップ CAN バスライブ診断ツール、ツールプロファイルごとに 1 パネル。
- **[URTC-WEB-STUDIO](https://github.com/JuanenRac/URTC-WEB-STUDIO)** — Web Serial API を使ったブラウザベースの URTC-TESTER の代替、ローカルインストール不要。
- **[URTC-GATEWAY](https://github.com/JuanenRac/URTC-GATEWAY)** — URTC の CAN バスの前に置くゲートウェイ：許可する識別子のリスト、レート制限、セッション鍵。コンピューター上でテスト済みで、実際のバスではまだ試していません。

*ビジョン AI ノード(Hailo-8)*
- **[HYDRA-UMC-VISION-NODE](https://github.com/JuanenRac/HYDRA-UMC-VISION-NODE)** — Hailo-8 ビジョンパイプラインの統合ハブ、段階ごとの実際のハードウェア準備状況チェック付き。
- **[HYDRA-UMC-DETECTION-HEF](https://github.com/JuanenRac/HYDRA-UMC-DETECTION-HEF)** — Hailo アーキテクチャ/チェックサムによる安全読み込み検証を備えた、実際のコンパイル済みモデルレジストリ。
- **[HYDRA-UMC-VISION-STREAMER](https://github.com/JuanenRac/HYDRA-UMC-VISION-STREAMER)** — 実際の HailoRT 統合境界を持つ、実際の GStreamer パイプライン + MediaMTX 設定生成器。
- **[HYDRA-UMC-VISUAL-SERVOING-API](https://github.com/JuanenRac/HYDRA-UMC-VISUAL-SERVOING-API)** — ゾーン状態を条件に承認する Position-Based Visual Servoing 補正則。カメラによる姿勢推定はまだない。
- **[HYDRA-UMC-SAFETY-ZONES](https://github.com/JuanenRac/HYDRA-UMC-SAFETY-ZONES)** — ファイルから物体位置を受け取る、ゾーン侵入・キャリブレーション鮮度・E-STOP 要求の v0 ロジック。検出器は接続されておらず、物理 E-STOP もまだ配線されていない。

*コグニティブ AI ノード(Hailo-10)*
- **[HYDRA-UMC-COGNITIVE-NODE](https://github.com/JuanenRac/HYDRA-UMC-COGNITIVE-NODE)** — Hailo-10 コグニティブパイプライン(LLM/VLA/音声オーケストレーション)の統合ハブ。
- **[HYDRA-UMC-VLA-ENGINE](https://github.com/JuanenRac/HYDRA-UMC-VLA-ENGINE)** — Vision-Language-Action モデル向けの、実際のアクショントークンのエンコード/デコードと軌道生成。
- **[HYDRA-UMC-VOICE-UI](https://github.com/JuanenRac/HYDRA-UMC-VOICE-UI)** — 確認ゲート付きの限定的な Watch リレーを備えた、実際の音声フロントエンド(VAD + 意図解析)。
- **[HYDRA-UMC-SEMANTIC-PLANNER](https://github.com/JuanenRac/HYDRA-UMC-SEMANTIC-PLANNER)** — MCU エラーコードに対する、実際のルールベースのタスク分解と意味的エラー復旧。
- **[HYDRA-UMC-DOCS-QA](https://github.com/JuanenRac/HYDRA-UMC-DOCS-QA)** — このエコシステム自身の Markdown ドキュメントに対する、標準ライブラリのみの実際の TF-IDF 文書検索。
- **[HYDRA-UMC-LOCAL-TECHNICIAN](https://github.com/JuanenRac/HYDRA-UMC-LOCAL-TECHNICIAN)** — エコシステム自身のための、ローカルでポリシーゲート付きのAIメンテナンス技術者 — 観察、診断し、修正を提案する;最上位の2つのリスクレベルは意図的にまだ実装されていない。

*オーケストレーション&スウォーム*
- **[HYDRA-UMC-ORCHESTRATOR](https://github.com/JuanenRac/HYDRA-UMC-ORCHESTRATOR)** — 実際の gRPC/Protobuf ヘルスレポート契約とミッションステートマシンを持つ統合ハブ。
- **[HYDRA-UMC-JOB-DISPATCHER](https://github.com/JuanenRac/HYDRA-UMC-JOB-DISPATCHER)** — 実際の HTTP API 上に構築された、優先度ベースの実際のジョブキュー(重複排除付き)。
- **[HYDRA-UMC-NODE-HEALING](https://github.com/JuanenRac/HYDRA-UMC-NODE-HEALING)** — リトライ/バックオフとアイデンティティ不一致検出を備えた、実際の gRPC ベースのフリートヘルスウォッチドッグ。
- **[HYDRA-UMC-PATH-PLANNER-3D](https://github.com/JuanenRac/HYDRA-UMC-PATH-PLANNER-3D)** — 実際の障害物/ワークスペース衝突検証を備えた、実際の RRT ベースの 3D 経路プランナー。
- **[HYDRA-UMC-SWARM-SYNC](https://github.com/JuanenRac/HYDRA-UMC-SWARM-SYNC)** — 複数セルの収束についてプロパティテストされた、実際の CRDT LWW-Element-Map 状態同期。

*デジタルツイン&シミュレーション*
- **[HYDRA-UMC-TWIN](https://github.com/JuanenRac/HYDRA-UMC-TWIN)** — 実際のバージョン互換性同期契約を持つ、デジタルツインエンジンの統合ハブ。
- **[HYDRA-UMC-HIL-BRIDGE](https://github.com/JuanenRac/HYDRA-UMC-HIL-BRIDGE)** — シミュレーションと実機の間にソフトウェアの衝突インターロックを備えたハードウェア・イン・ザ・ループのルーター(実機なしでテスト済み)。
- **[HYDRA-UMC-PHYSICS-REPLICA](https://github.com/JuanenRac/HYDRA-UMC-PHYSICS-REPLICA)** — 実際の URDF サブセットに対する、実際の順運動学と関節限界検証。
- **[HYDRA-UMC-SYNTHETIC-DATA-GEN](https://github.com/JuanenRac/HYDRA-UMC-SYNTHETIC-DATA-GEN)** — YOLO/COCO アノテーションのエクスポート機能を持つ、実際のプロシージャル 2D シーンジェネレーター。

*データ&分析*
- **[HYDRA-UMC-DATALAKE](https://github.com/JuanenRac/HYDRA-UMC-DATALAKE)** — 実際の取り込み/クエリ HTTP API を備えた、実際の sqlite3 ベースの時系列ストア。
- **[HYDRA-UMC-ANOMALY-DETECTOR](https://github.com/JuanenRac/HYDRA-UMC-ANOMALY-DETECTOR)** — ドリフト監視を備えた、実際の FFT + 統計ベースラインによる異常検知器。
- **[HYDRA-UMC-PRODUCTION-REPORTS](https://github.com/JuanenRac/HYDRA-UMC-PRODUCTION-REPORTS)** — DATALAKE の履歴に対する実際の OEE/稼働率計算、再現可能な CSV エクスポート付き。
- **[HYDRA-UMC-TELEMETRY-COLLECTOR](https://github.com/JuanenRac/HYDRA-UMC-TELEMETRY-COLLECTOR)** — シーケンス重複排除機能を備えた、DATALAKE への実際の CAN/WebSocket 取り込みパイプライン。

*補完ツール&エコシステム運用*
- **[HYDRA-UMC-DASHBOARD-AI](https://github.com/JuanenRac/HYDRA-UMC-DASHBOARD-AI)** — 誠実な統計フォールバックを備えた、DATALAKE/ANOMALY-DETECTOR 上のスマートサマリーと異常ハイライトパネル。
- **[HYDRA-UMC-TOOL-CLI](https://github.com/JuanenRac/HYDRA-UMC-TOOL-CLI)** — 実際の安定した終了コード契約を持つフリート CLI、HYDRA-UMC-SERVER 自身の API の本物のライブクライアント。
- **[HYDRA-UMC-WATCH](https://github.com/JuanenRac/HYDRA-UMC-WATCH)** — 触覚アラートのパターンとペアリング済みスマートフォンへの音声リレーを備えた WearOS コンパニオンアプリ(物理的なウォッチではまだ実行していない)。
- **[URTC-SMART-RACK](https://github.com/JuanenRac/URTC-SMART-RACK)** — 実際の工具 ID デコードと Smart Idle 予熱ロジックを備えた、基板搭載ラック用ファームウェア。
- **[URTC-VISION-TOOL](https://github.com/JuanenRac/URTC-VISION-TOOL)** — サーマル/RGB 検査ツールヘッド向けの、ファームウェアと実際の Python ビジョンコンパニオン。
- **[HYDRA-UMC-UPDATER](https://github.com/JuanenRac/HYDRA-UMC-UPDATER)** — このエコシステム内のすべてのリポジトリを検出・クローン・更新する、管理用デスクトップツール。
- **[HYDRA-UMC-OS-REBUILDER](https://github.com/JuanenRac/HYDRA-UMC-OS-REBUILDER)** — エコシステムの最新バージョンをプリロードした、書き込み可能なCM5イメージを構築するWindows/Linuxデスクトップツール。Raspberry Pi Imager方式の初回起動Wi-Fi/ユーザー/SSH設定を備える。
- **[HYDRA-UMC-OPS-AGENT](https://github.com/JuanenRac/HYDRA-UMC-OPS-AGENT)** — 保守インシデントコーディネーター: 低権限のエッジ役割がサニタイズされたインベントリ/ヘルスのスナップショットを収集し、コントロールプレーン役割がそれを読み取り専用でレンダリングして AI プロバイダーに診断の提案を依頼します - パッチを適用することも、何かをデプロイすることも決してありません。
- **[HYDRA-UMC-DEV-SERVER](https://github.com/JuanenRac/HYDRA-UMC-DEV-SERVER)** — 再現可能な開発ホスト（Raspberry Pi 5 / CM5）。エコシステムのソースコードを保管し、永続キューのもとで境界の明確なビルド/テストタスクを実行する。運用中の CM5 とは明確に異なる、開発専用の役割。

## 📚 ドキュメント

さらに読むには：

* [エコシステムのセキュリティ基準](https://github.com/JuanenRac/HYDRA-UMC-DOCS/blob/main/docs/SECURITY_BASELINE.md)
* [エコシステムの脅威モデル](https://github.com/JuanenRac/HYDRA-UMC-DOCS/blob/main/docs/THREAT_MODEL.md)
* [このリポジトリの変更履歴](CHANGELOG.md)
* [このリポジトリのライセンス](LICENSE.md)

## 🤝 コントリビュートとコミュニティ

* プルリクエストの前に `HYDRA_UMC_CI=1 py -3 tools/ci_validate.py`（または `HYDRA_UMC_CI=1 python3 tools/ci_validate.py`）を実行してください。`CI_VALIDATION=PASS` と表示される必要があります。この確認に `build.sh` や `build.bat` は使わないでください。ビルドは検査ではありません。
* 8 つの README は HYDRA-UMC-DOCS の 1 つのソースから書かれます。手で編集しないでください。ソースを変更し、`tools/make_readmes.py` で書き直します。
* 実行していないことを README に書かないでください。事実であれば「シミュレーションのみ」「実機では未確認」と書きます。
* [CONTRIBUTING.md](CONTRIBUTING.md)、[行動規範](CODE_OF_CONDUCT.md)、[SECURITY.md](SECURITY.md)、[SUPPORT.md](SUPPORT.md) を参照してください。

## 👤 作者

**JuanenRac (Electro Hobby 3D)** · electrohobby3d@gmail.com

## 📜 ライセンス

GPL-3.0-or-later - [LICENSE](LICENSE).
