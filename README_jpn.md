<p align="center">
  <img src="images/HYDRA_UMC_BANNER.svg" alt="HYDRA-UMC-OPCUA-SERVER banner" width="100%">
</p>

# 🏭 HYDRA-UMC-OPCUA-SERVER

<p align="center"><a href="README.md">🇺🇸 English</a> | <a href="README_spa.md">🇪🇸 Español</a> | <a href="README_fra.md">🇫🇷 Français</a> | <a href="README_ita.md">🇮🇹 Italiano</a> | <a href="README_deu.md">🇩🇪 Deutsch</a> | <a href="README_zho.md">🇨🇳 简体中文</a> | 🇯🇵 <b>日本語</b></p>

### 🛠️ HydraState オブジェクトを標準化された OPC-UA アドレス空間へマッピング

<p align="left">
  <img src="https://img.shields.io/badge/Licencia-GPL%203.0-blue.svg" alt="GPL 3.0">
  <img src="https://img.shields.io/badge/Standard-OPC--UA-orange.svg" alt="OPC-UA">
  <img src="https://img.shields.io/badge/Feature-Address%20Space%20Modeling-blue.svg" alt="Modeling">
</p>

---

## 1. 🛠️ 技術概要

**HYDRA-UMC-OPCUA-SERVER** は、ゲートウェイの中核となる産業モデリング
モジュールです。内部の動的な HydraState（JSON）を、構造化された発見
可能な OPC-UA アドレス空間へと変換します。

Ignition、Siemens TIA Portal、Rockwell FactoryTalk のような産業用
自動化ソフトウェアが、標準の PLC タグであるかのようにロボット変数を
参照、読み取り、書き込みできるようにします。

### 主な機能：
* 🛠️ **動的な情報モデリング：** アクティブなロボットと工具に基づいて OPC-UA ツリーを自動生成します。
* 🔄 **読み書きアクセス：** PLC クライアントからロボットの関節とエフェクターを安全に制御します。
* 🔖 **バージョン管理された名前空間と安定した NodeId：** 実際の明示的な名前空間 URI と、明示的な文字列 NodeId——アドレス空間の更新によって、クライアントが依存するパスが密かに変わることはありません。*(実装済み)*
* 🔐 **セッションごとの書き込み認可：** 匿名セッションと認証済みセッションを区別する、実際の動的なチェック——すべてのクライアントがデフォルトで書き込みアクセス権を得られるわけではありません。*(実装済み)*
* 📡 **サブスクリプションサポート：** OPC-UA のパブリッシュ・サブスクライブ機構を用いた高効率なデータ更新。
* 🛡️ **暗号化：** 署名付きおよび暗号化されたセキュリティポリシー（Basic256Sha256）を完全にサポート。

---

## 2. 🔄 OPC-UA アドレス空間フロー

```mermaid
flowchart LR
    API["Hydra Internal API"] --> MAP["OPC-UA Mapper"]
    MAP --> SPACE["Address Space Tree"]
    SPACE --> TAGS["Standardized PLC Tags"]
    TAGS --> CLIENT["External PLC / SCADA"]
```

---

## 3. 🧱 アーキテクチャと設計上の決定

* **HYDRA-UMC-GATEWAY-INDUSTRIAL のサブモジュールではなく兄弟プロジェクトである理由。** 各プロトコルアダプターは個別にデプロイ/再起動可能なプロセスです——OPC-UA クライアントライブラリの問題が、それと並行して動作する MQTT や MTConnect アダプターをダウンさせることは決してありません。
* **フラットな REST パススルーではなく OPC-UA アドレス空間である理由。** OPC-UA クライアント（SCADA/ヒストリアン）は、型付けされたノードを持つ実際の参照可能なアドレス空間を期待します——フラットな REST パススルーは技術的にはデータを公開できますが、そもそも OPC-UA を話す意味を失わせます。
* **エントリポイントが今日は身元/バージョンのみを表示し、ヘルスチェックリスナーが起動した後で終了する理由。** 足場（アンダミアヘ、スキャフォールディング）段階にあり、親プロジェクト自身の README と同じ理由です——実際のゲートウェイはその性質上長時間稼働するため、プロセスが稼働し続けることを証明することが実際の最初のマイルストーンです。
* **エコシステムの他の部分との関係。** HYDRA-UMC-GATEWAY-INDUSTRIAL の下の兄弟サービスです——HYDRA-UMC-SERVER 自身の状態を実際の OPC-UA アドレス空間へと変換します。
* **コンパイルチェックだけでなく、プロトコルレベルの実際のテスト。** `tests/server.test.ts` は実際の `OPCUAClient`（node-opcua 自身のクライアントで、UAExpert/Ignition が使うのと同じライブラリ）を、実際のバイナリプロトコルを介して実際の TCP ポート上の実際の `OPCUAServer` に接続します——セッションを開き、`SwarmOnline`/`ActiveRobotCount` をパスでブラウズ/読み取りし、クライアントが発行した書き込みが読み戻した値とサーバー側の状態の両方に反映されることを確認します。
* **node-opcua が自動割り当てする数値ではなく、明示的な文字列 NodeId を使う理由。** 数値 NodeId は作成順に割り当てられます——コード内で既存の DataItem の前に新しい DataItem を挿入すると、既存のものが黙って番号を振り直され、古い番号をハードコードしていた産業用クライアントが壊れてしまいます。`s=HydraNode_1.SwarmOnline` のような明示的な NodeId は、アドレス空間のコードの形が変わったというだけの理由でクライアントの足元で変化することは決してありません。
* **`SpindleTemp` が、他の変数が使うよりシンプルな `get()` ではなく `timestamped_get` を使う理由。** `get()` は読み取りのたびに自動的に現在時刻を付与します——ライブな値には適していますが、ゆっくりと変化する値（主軸はポーリングの間に再加熱されたりしません）には不正確です。`timestamped_get` は、値が実際に最後に変化した時刻を追跡する明示的な `sourceTimestamp` を持つ、本物の `DataValue` を返します。これは OPC-UA のヒストリアンが依存する本来のセマンティクスです。
* **書き込み認可が静的なアクセスレベルフラグではなく、セッションごと（`isUserWritable`）である理由。** 静的な `userAccessLevel` は、あるクライアントのセッションを別のクライアントのセッションと区別できません——どの接続に対しても同じ値だからです。変数ノード上で `isUserWritable(context)` をオーバーライドすることは、実際にセッションごとに変化するチェックのための node-opcua 自身が文書化した仕組みであり、2 つの異なる実際のクライアント ID でテストできるほど本物です。

意図的に後回しにしたものとその理由の正直なリストについては `mejoras_futuras.txt` を参照してください(ロボットごとの動的なツリー、暗号化/サブスクリプションの実際のテストカバレッジ、ロードマップの Pub/Sub 項目)。

---

## 📂 リポジトリ構成

```text
HYDRA-UMC-OPCUA-SERVER/
├── src/         # ソースコード（Node/TypeScript —— モデル、サーバー、マッパー）
├── tests/       # Vitest スイート —— サーバーとセキュリティの動作
├── build/       # コンパイル出力（npm run build）
├── images/      # メディアと図表
├── scripts/     # ユーティリティスクリプト（bump-version.mjs）
├── tools/       # ci_validate.py —— CI が使用する manifest/CHANGELOG/docs の検証
└── README.md
```

純粋なネットワークサービスであり、独自の専用ハードウェアを持ちません
——`hardware/`、`firmware/`、`os/` は元のプロジェクトテンプレートから
省略されており、リポジトリ構造ポリシーに従っています。

---

## 🛠️ 開発環境

### 必要条件
- [Node.js](https://nodejs.org/)（v18 以上を推奨）
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
実際の `npm run build` のたびに、`package.json` 自身の `version` が
自動的に増加します（`scripts/bump-version.mjs`、`build` スクリプトの
最初のステップとして接続）——10 進法の「オドメーター」方式：ビルド
ごとに patch を +1 し、9 を超えると minor に繰り上がり（minor が 9 を
超えると major に繰り上がる）、2 桁のセグメントに到達することはあり
ません（`0.0.9` -> `0.1.0`、`0.0.10` にはなりません）。

---

## 🚀 ロードマップ
* **フェーズ 1：** 高速データ交換とレガシープロトコルブリッジングのための OPC-UA パブリッシュ/サブスクライブ実装。
* **フェーズ 2：** 大量の IoT デバイス管理と高い並行性のための MQTT Broker クラスター。
* **フェーズ 3：** マルチベンダーの CNC および PLC 機械統合のための MTConnect アダプターサポート。
* **フェーズ 4：** OPC UA Robotics コンパニオン仕様への完全準拠と産業用ゲートウェイの同期。

---

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
- **[HYDRA-UMC](https://github.com/JuanenRac/HYDRA-UMC)** — 実際のロボットアームのマザーボード——CM5 ホスト + デュアルコア STM32H745、CAN-OTA/SPI-OTA 経由で最大 8 本のツールアームを統括。
- **[HYDRA-UMC-OS](https://github.com/JuanenRac/HYDRA-UMC-OS)** — CM5 向けの再現可能な Raspberry Pi OS プロダクト層——読み取り専用エージェント、検証済み設定/プロファイル、WiFi 初回接続プロビジョニング。
- **[HYDRA-UMC-SDK](https://github.com/JuanenRac/HYDRA-UMC-SDK)** — すべてのブリッジが自身のコマンドを検証する共有 JSON-Schema 契約と安全ゲートの境界。

*コアバックエンド&クライアント*
- **[HYDRA-UMC-STUDIO](https://github.com/JuanenRac/HYDRA-UMC-STUDIO)** — リアルタイムのマルチロボット 3D 可視化を備えたウェブ制御ダッシュボード。
- **[HYDRA-UMC-SUITE](https://github.com/JuanenRac/HYDRA-UMC-SUITE)** — 複数のサーバーを同時に扱えるデスクトップ(PySide6)スウォームコマンドセンター、スタンドアロン実行ファイルとしてパッケージ化。
- **[HYDRA-UMC-ANDROID-CONTROL](https://github.com/JuanenRac/HYDRA-UMC-ANDROID-CONTROL)** — 生体認証ログインとペアリングされた Wear OS コンパニオンを備えたネイティブ Android 制御アプリ。
- **[HYDRA-UMC-IOS-CONTROL](https://github.com/JuanenRac/HYDRA-UMC-IOS-CONTROL)** — リアルタイム WebSocket 同期を備えた iOS/iPadOS 制御アプリ(Flutter)。
- **[HYDRA-UMC-DSI](https://github.com/JuanenRac/HYDRA-UMC-DSI)** — 本体搭載の 7 インチ DSI タッチスクリーン向けネイティブタッチ UI、CM5 自体に組み込み。
- **[HYDRA-UMC-EDITOR-URDF](https://github.com/JuanenRac/HYDRA-UMC-EDITOR-URDF)** — 完成したモデルを STUDIO 自身のカタログへ送信するデスクトップ用グラフィカル URDF 作成/編集ツール。
- **[HYDRA-UMC-BRIDGE-AMR](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-AMR)** — 実際の VDA 5050 MQTT パブリッシャーによる AGV/AMR フリートの調整境界。
- **[HYDRA-UMC-BRIDGE-CNC](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-CNC)** — 実際の GRBL ステータス/制御バイトへのアクセスを持つ、CNC セルの高レベルコーディネーター。
- **[HYDRA-UMC-BRIDGE-DROIDS](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-DROIDS)** — 実際の Boston Dynamics Spot コマンド送信機能を持つ、脚型/ヒューマノイドドロイドの調整境界。
- **[HYDRA-UMC-BRIDGE-LASER](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-LASER)** — 実際のキー/筐体/インターロック GPIO セーフガード 3 系統を読み取る、レーザーセルの安全コーディネーター。
- **[HYDRA-UMC-BRIDGE-OPENPNP](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-OPENPNP)** — OpenPnP ピックアンドプレースの基板フローを安全に統括する高レベルコーディネーター。
- **[HYDRA-UMC-BRIDGE-PRINTER3D](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-PRINTER3D)** — 実際にゲート制御されたジョブコマンドを持つ、Moonraker/Klipper 3D プリンター向けの安全な調整境界。
- **[HYDRA-UMC-BRIDGE-ROS2](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-ROS2)** — 実際の遅延インポート rclpy ROS 2 トランスポートを持つ安全コーディネーター。
- **[HYDRA-UMC-BRIDGE-UAV](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-UAV)** — 実際の MAVLink コマンド送信機能を持つ、カメラ搭載 UAV の調整境界。

*URTC ツールプラットフォーム*
- **[URTC](https://github.com/JuanenRac/URTC)** — 物理的な Universal Robot Tool Controller 基板向けファームウェア、CAN バス経由の 25 以上のツールプロファイル。
- **[URTC-FLASHER](https://github.com/JuanenRac/URTC-FLASHER)** — URTC 基板用のデスクトップ GUI 書き込みツール、CAN-OTA およびフルチップ SWD/JTAG。
- **[URTC-TESTER](https://github.com/JuanenRac/URTC-TESTER)** — URTC 基板向けのデスクトップ CAN バスライブ診断ツール、ツールプロファイルごとに 1 パネル。
- **[URTC-WEB-STUDIO](https://github.com/JuanenRac/URTC-WEB-STUDIO)** — Web Serial API を使ったブラウザベースの URTC-TESTER の代替、ローカルインストール不要。

*ビジョン AI ノード(Hailo-8)*
- **[HYDRA-UMC-VISION-NODE](https://github.com/JuanenRac/HYDRA-UMC-VISION-NODE)** — Hailo-8 ビジョンパイプラインの統合ハブ、段階ごとの実際のハードウェア準備状況チェック付き。
- **[HYDRA-UMC-DETECTION-HEF](https://github.com/JuanenRac/HYDRA-UMC-DETECTION-HEF)** — Hailo アーキテクチャ/チェックサムによる安全読み込み検証を備えた、実際のコンパイル済みモデルレジストリ。
- **[HYDRA-UMC-VISION-STREAMER](https://github.com/JuanenRac/HYDRA-UMC-VISION-STREAMER)** — 実際の HailoRT 統合境界を持つ、実際の GStreamer パイプライン + MediaMTX 設定生成器。
- **[HYDRA-UMC-VISUAL-SERVOING-API](https://github.com/JuanenRac/HYDRA-UMC-VISUAL-SERVOING-API)** — 上流のゾーン状態に応じて安全ゲート制御される、実際の Position-Based Visual Servoing 補正則。
- **[HYDRA-UMC-SAFETY-ZONES](https://github.com/JuanenRac/HYDRA-UMC-SAFETY-ZONES)** — キャリブレーションの鮮度を強制する、実際のゾーン侵入チェックと E-STOP 要求。

*コグニティブ AI ノード(Hailo-10)*
- **[HYDRA-UMC-COGNITIVE-NODE](https://github.com/JuanenRac/HYDRA-UMC-COGNITIVE-NODE)** — Hailo-10 コグニティブパイプライン(LLM/VLA/音声オーケストレーション)の統合ハブ。
- **[HYDRA-UMC-VLA-ENGINE](https://github.com/JuanenRac/HYDRA-UMC-VLA-ENGINE)** — Vision-Language-Action モデル向けの、実際のアクショントークンのエンコード/デコードと軌道生成。
- **[HYDRA-UMC-VOICE-UI](https://github.com/JuanenRac/HYDRA-UMC-VOICE-UI)** — 確認ゲート付きの限定的な Watch リレーを備えた、実際の音声フロントエンド(VAD + 意図解析)。
- **[HYDRA-UMC-SEMANTIC-PLANNER](https://github.com/JuanenRac/HYDRA-UMC-SEMANTIC-PLANNER)** — MCU エラーコードに対する、実際のルールベースのタスク分解と意味的エラー復旧。
- **[HYDRA-UMC-DOCS-QA](https://github.com/JuanenRac/HYDRA-UMC-DOCS-QA)** — このエコシステム自身の Markdown ドキュメントに対する、標準ライブラリのみの実際の TF-IDF 文書検索。

*オーケストレーション&スウォーム*
- **[HYDRA-UMC-ORCHESTRATOR](https://github.com/JuanenRac/HYDRA-UMC-ORCHESTRATOR)** — 実際の gRPC/Protobuf ヘルスレポート契約とミッションステートマシンを持つ統合ハブ。
- **[HYDRA-UMC-JOB-DISPATCHER](https://github.com/JuanenRac/HYDRA-UMC-JOB-DISPATCHER)** — 実際の HTTP API 上に構築された、優先度ベースの実際のジョブキュー(重複排除付き)。
- **[HYDRA-UMC-NODE-HEALING](https://github.com/JuanenRac/HYDRA-UMC-NODE-HEALING)** — リトライ/バックオフとアイデンティティ不一致検出を備えた、実際の gRPC ベースのフリートヘルスウォッチドッグ。
- **[HYDRA-UMC-PATH-PLANNER-3D](https://github.com/JuanenRac/HYDRA-UMC-PATH-PLANNER-3D)** — 実際の障害物/ワークスペース衝突検証を備えた、実際の RRT ベースの 3D 経路プランナー。
- **[HYDRA-UMC-SWARM-SYNC](https://github.com/JuanenRac/HYDRA-UMC-SWARM-SYNC)** — 複数セルの収束についてプロパティテストされた、実際の CRDT LWW-Element-Map 状態同期。

*デジタルツイン&シミュレーション*
- **[HYDRA-UMC-TWIN](https://github.com/JuanenRac/HYDRA-UMC-TWIN)** — 実際のバージョン互換性同期契約を持つ、デジタルツインエンジンの統合ハブ。
- **[HYDRA-UMC-HIL-BRIDGE](https://github.com/JuanenRac/HYDRA-UMC-HIL-BRIDGE)** — シミュレーションと実際のハードウェアの間でコマンドをルーティングする、実際のハードウェア・イン・ザ・ループ安全インターロック。
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
- **[HYDRA-UMC-WATCH](https://github.com/JuanenRac/HYDRA-UMC-WATCH)** — 実際の触覚アラートとペアリングされたスマートフォンへの音声リレーを備えた WearOS コンパニオンアプリ。
- **[URTC-SMART-RACK](https://github.com/JuanenRac/URTC-SMART-RACK)** — 実際の工具 ID デコードと Smart Idle 予熱ロジックを備えた、基板搭載ラック用ファームウェア。
- **[URTC-VISION-TOOL](https://github.com/JuanenRac/URTC-VISION-TOOL)** — サーマル/RGB 検査ツールヘッド向けの、ファームウェアと実際の Python ビジョンコンパニオン。
- **[HYDRA-UMC-UPDATER](https://github.com/JuanenRac/HYDRA-UMC-UPDATER)** — このエコシステム内のすべてのリポジトリを検出・クローン・更新する、管理用デスクトップツール。


---

## 📚 ドキュメント & コミュニティ

- **[CONTRIBUTING.md](CONTRIBUTING.md)** —— プルリクエストのための技術スタックとコーディング指針。
- **[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)** —— このコミュニティで期待される行動規範。
- **[SECURITY.md](SECURITY.md)** —— 脆弱性の報告方法と、このプロジェクトの実際のセキュリティ重点領域。
- **[SUPPORT.md](SUPPORT.md)** —— 質問の投稿先とバグの報告先。
- **[LICENSE.md](LICENSE.md)** —— このプロジェクト自身のライセンス。

## 👤 作者
**JuanenRac** (Electro Hobby 3D)
📧 electrohobby3d@gmail.com
📺 [youtube.com/@electrohobby3d](https://youtube.com/@electrohobby3d)

## 📜 ライセンス
GPL-3.0 —— 詳細は LICENSE を参照してください。
