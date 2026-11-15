# OpenCode Adaptive Fusion — プロトタイプ v0.9.0

企画書 v1.1 の Phase1 + Phase2(タスク分類)相当のプロトタイプ。
**プラグインHooksによる透過的ルーティング + タスク分類 + メトリクス収集**を実装しています。

**v0.6/v0.7 の拡張計画**(内部レビューハーネス / ベンチマーク事前合成 / Jev による
オーケストレーション形態判定)は末尾の「ロードマップ v0.6/v0.7」にまとめています。

## 構成

```
plugins/adaptive-fusion/index.ts   サーバー部(hooks・学習・ルーティング・RPC実装)
plugins/adaptive-fusion/rpc.ts     RPC契約(TUI⇔サーバーの型付きインターフェース)
plugins/adaptive-fusion/tui.tsx   TUI部(スラッシュコマンド + session.panel)
plugins/adaptive-fusion/jev.ts    Jev(TypeSafe System One)クライアント
opencode.jsonc                     プロジェクト側は登録しない(二重読み込み防止)
~/.config/opencode/opencode.json   グローバル登録(全プロジェクトで有効)
data/benchmarks.json               ベンチマーク事前シード(モデル×カテゴリの下馬評)
```

プラグインはグローバル設定の `plugins` に絶対パスで登録してあるため、
**どのディレクトリでOpenCodeを起動しても読み込まれます**。
学習統計(`ctx.storage`)もプラグイン単位で共有され、プロジェクト横断で蓄積されます。

## 実装している機能

| 機能 | 実装方法(企画書の要素) |
| --- | --- |
| タスク分類 | `prompt` フック + `ctx.experimental.generate.text` → Task Classifier |
| ルーティング | `experimental.model.resolve` フック → Adaptive Router |
| メトリクス収集 | `http.request` / `http.response` フック → Learning Engine への入力 |
| 学習統計の保存 | `ctx.storage`(v0.8.1 実測: OpenCode 2.3 では SQLite `opencode.db` の kv。TUI⇔サーバーで共有)→ Metrics DB(Phase1) |
| 探索 | ε-greedy(通常5%/学習期間30%) → Contextual Bandit の最小実装 |
| スコア | 成功率(ラプラス平滑化) × 0.65 + 人間レビュー評価 × 0.35 − コストペナルティ − 相対レイテンシペナルティ |
| コスト上限 | ホワイトリスト空時は `maxInputCost` / `maxOutputCost` を満たすモデルのみ選択(既定 0 = 無料モデルのみ) |
| コマンド | TUI部のスラッシュコマンド(ダイアログ表示。セッションを汚染しない) |
| 手動レビュー | 最新応答の3行サマリーと1〜5評価。評価をオーケストレーターのスコアへ反映 |
| 内部審査(shadow)(v0.6) | `http.response`(ok)の直後に依頼文+応答を別モデルが3軸採点。`fusion/auto/*` に蓄積のみ(スコアへは未反映) |
| ベンチマーク事前(v0.6) | `data/benchmarks.json` の下馬評を Beta(benchmark×k, (1−benchmark)×k) 事前として観測成功率を平滑化(`benchmarkPriorWeight`, 0で無効) |
| Jev 統合(v0.7a) | `jev.ts` 経由で分類を `Choice`(6カテゴリ)判定、トポロジーを `Choice`(single/router/sequential-chain)判定。`TYPESAFE_API_KEY` または `/fusion-jev-key` の登録キーで有効化。キー未登録時は従来経路へ縮退 |
| トポロジー観測(v0.7a) | 判定した形態と http.response の成否・レイテンシを `fusion/topology/*` に蓄積(stats に表示)。sequential-chain は判定と記録のみ(実行は v0.7b) |
| ティアルーティング(v0.8) | タスク負荷(Light/Middle/Heavy)に応じてティア内のモデルから選択。層はユーザー編成(manual)かベンチマーク3分割(auto)。枯渇時は上方カスケード、全滅時は従来選択に縮退 |

コマンドは以下の14種類です。TUI部からRPC経由でサーバー部を呼び出すため、
エージェントが応答したりセッション履歴が汚れたりすることはありません。

| コマンド | 機能 |
| --- | --- |
| `/fusion-stats` | 学習統計をダイアログ表示(人間評価平均とコスト上限も表示) |
| `/fusion-toggle` | ルーティング ON/OFF 切替(トースト表示) |
| `/fusion-config` | 現在の設定をダイアログ表示 |
| `/fusion-costcap` | ホワイトリスト空時の入力/出力コスト上限を編集(既定 `0,0`) |
| `/fusion-review` | 応答レビューポップアップを開く(サマリー生成 + 1〜5評価 + ターン統計)。**ターン指定で遡及レビュー可**(v0.9.0: `0=最新, 1=1個前…`) |
| `/fusion-jev-key` | Jev(TypeSafe) APIキーを入力ダイアログで登録(v0.7a・空入力で解除)。キーは `fusion/jev-key` にサーバー側保存。`TYPESAFE_API_KEY` 環境変数でも可 |
| `/fusion-reviewmodel` | 内部審査(shadow)の担当モデルを `provider/model` で設定(v0.6・空入力で解除 = classifierModel と同じ経路) |
| `/fusion-chainmode` | sequential-chain の補助実行(計画注入)を off/active 切替(v0.7a) |
| `/fusion-tiermode` | ティアルーティングを off → manual → auto の順に切替(v0.8) |
| `/fusion-tiers` | ティアごとのモデルグループを編集(Heavy/Middle/Light の順にダイアログ。カンマ区切り。空で層をクリア)(v0.8) |
| `/fusion-provider` | ルーティング対象プロバイダーを変更(切替時にホワイトリストを自動リセット) |
| `/fusion-whitelist` | ルーティング候補モデルのホワイトリスト編集(カンマ区切りで入力。空で全候補 + コスト上限) |
| `/fusion-probe` | 候補モデルへ一斉テストプロンプトを送信(応答評価・統計記録・クールダウン) |
| `/fusion-reset` | 学習統計・クールダウン・人間評価をリセット(確認ダイアログあり) |

※TUI部の変更を反映するには、TUIの再起動が必要な場合があります。

## 設定の永続化(v0.3で追加)

設定は `fusion/config`(`ctx.storage`)に永続化され、**TUIから変更できます**
(opencode.json を編集して再起動する必要がありません)。

優先順位: **保存済み設定 > opencode.json の options**

- `/fusion-toggle` や `/fusion-whitelist` での変更は即座に保存され、TUI再起動後も保持されます
- `providerID` も設定から変更可能なため、OpenRouter へのプロバイダー切替は
  設定変更のみで行えます(hooks は動的に `cfg.providerID` を参照します)
- opencode.json 側の options は初期値(セード)としてのみ使われます

**TUI⇔サーバー設定の自動再同期(v0.8.1)**:

- TUI のスラッシュコマンドは **TUI プロセス内のプラグインインスタンス**で実行されるため、
  トグル直後のサーバー側メモリは古い値のままになることがありました
- OpenCode 2.3 では `ctx.storage` が単一の SQLite DB(`~/.local/share/opencode/opencode.db` の
  `kv` テーブル)に統合されており、両インスタンスが同じキーを読み書きします
- これを利用し、サーバー側は **`prompt` フック(ターン開始・必ず通る)で保存済み設定を
  再読込して反映**します。TUI でトグルした後の最初のプロンプト送信時に必ず同期されます
  (ルーティングログに `CONFIG synced from storage (enabled=...)` として記録)
- 変更が無い場合(両者が既に一致)は再適用をスキップするため、オーバーヘッドは最小です
- 実機検証済み: DB 側の `enabled` を変更 → 次の prompt でサーバー側が追従(OFF 反映)を確認

## Rescue(緊急退避)と自動復帰(v0.5.1で追加、v0.8.1で強化)

- モデルが「利用不可」(Model unavailable / クオータ制限)と判定されると、次のプロンプト送信前に
  セッションを健康なモデルへ自動切替します(ルーティングOFFでもこの経路だけは動きます)
- 切替元モデルの冷却が解除され、プロバイダーのクオータ冷却も解除された場合、
  次のプロンプト送信時に**元のモデルへ自動復帰**します(24時間の復帰ウィンドウ付き)
- 復帰判定は `session.step.failed`(after-fail)および rescue 発動時(pre-prompt)の両経路で記録されます
- 復帰は1回の切替のみを行い、失敗した場合は次のプロンプトで通常のrescue処理へフォールバックします

**検証付き冷却(verified cooldown、v0.8.1)**:

- クオータ冷却は **1時間ごと**。タイマー満了 = 回復 ではなく、実機への最小プローブ
  ("Reply with exactly: OK")が**成功した時だけ**冷却を解除する(`needsVerify`)
- プローブが失敗したらタイマーをさらに1時間延長し、健康モデルへフォールバックし続ける
  (実運用で「タイマーは切れたが利用制限は未解除 → Model unavailable で強制停止」を
  繰り返したことが発端。ルーティングログに `VERIFY ok/fail` として記録される)
- プロバイダー単位のクオータ冷却は**無料モデルにのみ適用**する。同プロバイダーの
  有料モデルは無料枠と別枠のため、退避先として使える
- rescue 時の緊急拡大(crossProvider 時は常に)は、ホワイトリスト外の
  **予算内(maxInputCost/maxOutputCost)の有料モデル**まで候補に含める。
  ホワイトリストの無料モデルが全滅しても応答が止まらない
- ルーティング結果はセッションの保存モデルにも永続化する。resolve による差し替えは
  dispatch 単位のため、保存モデルが死んだモデルのままだと drain(キュー再開)や
  再起動後の再開が同じ死んだモデルを使って強制停止していた(#実機ログで確認)
  - ただし保存するのは **rescue による差し替えの場合だけ**。通常のスコアルーティングまで
    保存すると step ごとにセッションモデルが書き替わり、キャッシュが切れるため

**OpenCode 2.3 の model.resolve 制約と DEFER 経路(v0.8.1・バイナリ解析+実機検証)**:

- `experimental.model.resolve` フックでの `event.model` 書き換えは **同一プロバイダーのみ**
  解決される(本体 `SessionRunnerModel.resolve` は `y.providerID === m.providerID` のときだけ
  resolve し、異プロバイダーへの書き換えは即 `ModelUnavailableError: <新モデル>` を投げる)。
  これが過去の誤診連鎖(健康な有料モデルを「死亡」と誤冷却)の主因だった
- そのため:
  - 同一プロバイダーへの差し替え → 従来どおり `event.model` を書き換えて即時適用
  - 異プロバイダーへの退避(rescue 時) → `ctx.session.switchModel`(手動モデル選択と同じ
    安全な経路)でセッションモデルを更新し、**次の dispatch から**適用
    (ルーティングログに `DEFER ... (cross-provider, next dispatch)` として記録)
  - 通常ルーティングでの異プロバイダー差し替えは行わない
    (dispatch ごとに往復してキャッシュが切れるため。`KEEP ... (no rewrite)` と記録)

**複数インスタンス環境での冷却消失対策(v0.8.1・再現実験で実証)**:

- サーバープロセスは同一プラグインを **2インスタンスでロードする**(ログに
  `role=server` の二重ロードを実証)。フックを持たない側が「復元時点の古いマップ」で
  `fusion/cooldowns` を persist すると、フック側が記録した冷却が丸ごと消えていた
  (gemini のクオータ冷却が失われる事故を再現・カナリア実験で確定)
- 対策: `persistCooldowns` / `persistRescue` を **kv をベースにメモリをマージ**する方式に変更。
  削除は tombstone(25h TTL)で貫通させ、`/fusion-reset` 後の復活も防ぐ
- 併せて `http.response` 成功時の冷却解除に `RECOVER ok <ref>` ログを追加
  (「冷却が消えた理由不明」を撲滅)、ルーティングログを直近20件→200件に拡大

**未切替セッションの事前rescue(v0.8.1・実機検証済み)**:

- 新規セッションは最初の `switchModel` が起きるまで `session.model` が未設定のため、
  従来の事前rescueは「セッションモデル読めず」で沈黙し、死んだデフォルトモデルに
  2回連続で失敗していた(実機ログで確認)
- 対策: resolve フックが**実 dispatch モデルを `lastResolved` に記録**し、
  事前rescueと step.failed の犯人特定のフォールバックに使用する
  (ログに `PRE hint <ref>` として記録)。これにより:
  - 死んだモデルへの **2回目の失敗が起きる前に** `SWITCH pre-prompt` で退避できる
  - HTTP が飛ばない失敗(課金 precheck 等)でも正しいモデルを冷却できる
    (`pending` → `lastResolved` → `session.model` の順で特定。健康モデルの誤冷却を防止)

## レイテンシの相対正規化(v0.5.1で追加)

- 従来は `avgMs / 60_000` の固定正規化で、3500ms のモデルでも 0.003 程度しか減点されませんでした
- 候補群の最大平均応答時間を基準とした**相対比(0〜1)**で減点するように変更しました
- 観測のないモデルには中立の 0.5 を与えます
- スコアの重みは `latencyWeight`(既定 0.05)のままですが、遅いモデルは
  速いモデルより最大 `latencyWeight` 分だけ実際に減点されます

## TUIステータス表示(v0.5.1で追加)

- fusionが有効か無効かを、ホーム画面とプロンプト入力欄のフッター(内蔵ステータスの右、
  バージョン表示の前)に常時表示します
  - `● fusion: ON` — ルーティング有効
  - `○ fusion: OFF` — ルーティング無効(rescueのみ動作)
- 表示は `/fusion-toggle` や `/fusion-config` 経由で即時更新されます

## タスク分類(v0.2で追加)

- ユーザープロンプトの受付時に、`classifierModel` で指定した軽量モデルが
  プロンプトを以下のいずれかに分類します:
  `coding`(実装)/ `debugging`(修正)/ `review`(検証)/ `research`(調査)/ `writing`(文章)/ `ops`(シェル・実行)
- 設定モデル `classifierModel` がエラー・無料枠制限・クールダウンの場合は、当該時刻に観測可能な無料モデルへ順にフォールバックします。さらに依頼文の明示的な語彙シグナルからキーワード推定します。明示的シグナルが無い場合は推測せず「未分類」のまま返します
- 分類は初回リクエスト時に1回の軽量呼び出しとして動作します
- 統計は **タスク種別 × モデル** 単位(`fusion/task/<category>/...`)で記録されます
- ルーティング時は「そのタスク種別で強いモデル」を優先選択します
- 該当種別の観測が `minObservations` 回未満なら全体統計に、
  それもなければ中立値(0.5)にフォールバックします

## 使い方

1. どのディレクトリでも OpenCode を起動すると、グローバル設定経由でプラグインが読み込まれます。
2. 初期状態は **ルーティング OFF / 観測のみ** です。通常通り作業すると、
   `providerID`(既定: `opencode`)配下の各モデルの成功率・平均レイテンシが蓄積されます。
3. 十分にデータが溜まったら `/fusion-toggle` でルーティングを ON にします。
4. `/fusion-stats` で統計表示、`/fusion-config` で設定確認、
   `/fusion-whitelist` で候補モデルの絞り込み、`/fusion-reset` でリセット。

## オプション(`opencode.jsonc`)

| オプション | 既定 | 説明 |
| --- | --- | --- |
| `providerID` | `"opencode"` | ルーティング対象のプロバイダー。OpenRouter利用時は `"openrouter"` を指定。**v0.3から設定で変更可能** |
| `crossProvider` | `false` | **v0.4で追加**。`true` で全プロバイダーを混合してオーケストレーション(接続済みサービス横断)。ホワイトリストは `provider/model-id` 完全参照形式になる(`/fusion-config` で変更可能) |
| `enabled` | `false` | ルーティングの初期状態(`/fusion-toggle`で変更可能) |
| `exploreRate` | `0.05` | 通常時の ε-greedy 探索率 |
| `learningRate` | `0.3` | 学習期間中の探索率 |
| `minObservations` | `5` | 学習期間のしきい値。観測がこの回数未満のモデルが残っている間、learningRate で未熟モデルを優先探索する(cold-start対策) |
| `classifierModel` | (なし) | タスク分類に使う軽量モデル(`provider/model` 形式)。未指定なら分類は無効 |
| `categories` | 6種別 | 分類カテゴリの一覧(`coding / debugging / review / research / writing / ops`) |
| `costWeight` | `0.1` | Routing Score のコスト重み |
| `latencyWeight` | `0.05` | Routing Score のレイテンシ重み |
| `maxInputCost` | `0` | ホワイトリスト空時の入力コスト上限(USD / 1M tokens)。`0`なら無料モデルのみが候補対象 |
| `maxOutputCost` | `0` | ホワイトリスト空時の出力コスト上限(USD / 1M tokens)。`/fusion-costcap` で変更可能 |
| `debug` | `false` | ルーティング決定をサーバーログへ出力 |
| `kinds` | `["primary"]` | 対象リクエスト種別(`primary / compaction / title / generate`) |

## 手動レビュー(v0.5で追加、v0.9.0 で遡及レビュー対応)

応答の最後にタグ付け・担当業務への満足度をユーザーが直接評価し、
学習ルーティングへ還元する機能です。`/fusion-review` を実行すると、
対象応答に対する大型ポップアップで表示します。

1. エージェントの応答を確認後、`/fusion-review` を実行
2. **対象ターンの選択(v0.9.0)**: ダイアログに `0=最新, 1=1個前, 2=2個前…`
   を入力(空で最新)。**後からバグが見つかった古い応答も遡ってレビューできる**
   (パネル内の `[◀ 前の応答へ]` `[▶ 新しい方へ]` でも移動可)
3. 担当カテゴリ・使用モデル・既存の平均評価・**ターン統計**を表示
   - ターン統計(v0.9.0): 入力/出力/推論/キャッシュ読みトークン、コスト($)、
     実測所要時間、**実測スループット(tok/s)** — メッセージに記録された
     tokens/cost/time から算出するため、**過去ターンも後付けで表示できる**
4. `[サマリーを生成]` を押すと、**依頼文と応答内容の両方**を踏まえた
   3行の要約が表示されます
   - `指示`: 何を依頼されたか
   - `実施`: どのような作業をしたか
   - `成果`: 何を達成・改善したか
   - サマリーモデルはLLM APIを呼び、設定モデルが使えない場合は観測結果の良い正常モデルへ順にフォールバックします
5. `[1]` `[2]` `[3]` `[4]` `[5]` の評価ボタン(またはキー入力)で
   満足度を記録します(評価は対象ターンの応答に対して記録される)

- 評価は `fusion/feedback/<provider>/<model>`(全体)と
  `fusion/feedback/task/<category>/<provider>/<model>`(タスク別)に保存
- Routing Score は自動観測を65%、人間評価を35%で合成します
- 評価3は中立です。4以上は成功率加点、2以下は大きな減点として働きます
- `/fusion-reset` で統計と一緒に人間評価も削除します
- (v0.7 で「トポロジーコスパ評価」の軸を追加予定 → ロードマップ §5)

## コスト上限(v0.5で追加)

ホワイトリストが空の自動候補選択では、入力/出力トークンのコストレートをそれぞれ上限値で制限できます。

- 既定は両方 `0` で、**無料モデルしか呼びません**
- 高コストモデル(例: `GPT 6 Astra reasoning=MAX` のような構成)を自動選択から除外できるため、
  想定外の課金が起きません
- 上限は `/fusion-costcap` で `input,output`(USD/Mtoken)、例 `0.3,2.0` のように変更
- ホワイトリストが空の場合のみ適用します(明示的に絞ったホワイトリストは優先されます)

## cross-provider 混合ルーティング(v0.4で追加・実証済み)

**実証テスト(2026-11-14)**: `experimental.model.resolve` による**プロバイダー越えの
モデル差し替えは動作する**ことを確認しました(opencode 既定モデルのリクエストを
`openrouter/thinkingmachines/inkling-2-small:free` に差し替え、応答の model メタデータが
OpenRouter 側になることを検証)。

`crossProvider: true` にすると、接続済みの全サービス(例: `opencode` / `openrouter` /
`anthropic` / `google` / `xai`)を混合してオーケストレーションします。

- 候補は全プロバイダーのモデルに拡大され、成功率・コスト・レイテンシの学習スコアで選択
- ホワイトリストは `provider/model-id` の**完全参照形式**(例: `openrouter/z-ai/glm-4.6`)
- 統計キーは実プロバイダー単位(`fusion/stat/<provider>/<model>`)なので、
  プロバイダーを跨いでも学習データが保持されます
- 切替は `/fusion-config`(RPC)から `crossProvider` を boolean で変更します
  (切替時、ホワイトリストの記法が変わるため自動でクリアされます)

**注意(実証テストで判明したリスク)**: 差し替え先のモデルが「利用不可」
(無料枠のレート制限など)の場合、OpenCode はリトライせずそのステップが失敗します。
無料モデル中心の運用では、成功率学習により失敗の多いモデルのスコアが下がり、
自動的に安定したモデルへフォールバックする設計になっているため、
`costWeight` で有料モデルを抑制しつつ `:free` モデルを候補に入れる運用が想定されます。

### OpenRouter を単一プロバイダーとして使う(crossProvider を使わない場合)

1. `opencode auth login` で OpenRouter の API キーを登録
2. `/fusion-provider` で `openrouter` に切替(ホワイトリストは自動リセットされます)
3. `/fusion-whitelist` で OpenRouter のモデルIDを入力(例: `openai/gpt-...:free` のような
   `org/model` 形式のID、カンマ区切り。空で全候補)

- コストペナルティ(`costWeight`)を有効にすると、有料モデルは自然にスコアが下がります
- 無料モデルのみで運用する場合はホワイトリストに `:free` モデルを列挙するか、
  `costWeight` を大きくして有料モデルを事実上除外する方法があります

## 既知の制約

- 差し替え先モデルが利用不可(レート制限等)の場合、リトライなしでステップが失敗します
  (HTTP に到達しないため統計も記録されない。失敗時の検知は今後の課題)。
- `model.resolve` / `http.*` フックは実験的なため、OpenCode の更新で名称・シグネチャが変わる可能性があります。
- 成功判定は HTTP レスポンスの成否のみ(→ v0.6 の内部レビューハーネスで解消予定)。
- モデル選定は自前観測のみを参照し、公開ベンチマークの事前知識は未使用
  (→ v0.6 のベンチマーク事前合成で解消予定)。

## ロードマップ v0.6/v0.7 — カテゴリ別 課題適応の完成

現状の Routing Score は「HTTP 成否 × 実績」しか見ていません。これは
「Inkling が成功率100%で常勝する」ように、**内容の良し悪しを測っていない**ことを意味します。
以下の要素を追加し、**カテゴリごとの課題適応・パフォーマンス改善**(企画書の本来目的)を完成させます。

```
選定スコア(v0.7 目標)
  = 0.55 × 観測成功率(ベンチマーク事前で平滑化)   ← 実績 + 下馬評
  + 0.25 × 人間レビュー評価                        ← /fusion-review
  + 0.20 × 内部レビュー評価(Jev/LLM審査)          ← v0.6 新設
  − コストペナルティ − 相対レイテンシペナルティ
(重みは設定可能。すべてタスク種別 × モデル単位で記録)
```

### 1. 内部レビューハーネス(v0.6) — shadow mode で実装済み

応答を**別モデルが審査**する経路を新設しました(2026-11-14、shadow mode で実装済み)。
`http.response`(kind=primary, ok=true)の直後に非同期で審査し、結果は `fusion/auto/*` に蓄積します。
**現時点では Routing Score へ反映しません**(表示のみ・記録のみ)。

- **発火点**: `http.response`(kind=primary, ok=true)の直後にバックグラウンドで1回だけ審査。
  ユーザーへの応答はブロックしない
- **審査モデル**: `generateWithFallback` 経由。`/fusion-reviewmodel`(または
  `reviewModel` 設定)で専用モデルを指定可能(v0.6)。未指定なら classifierModel と
  同じフォールバック経路(設定モデル → 観測良好な無料モデル)を共有する。
  全モデル不通時は審査をスキップし統計だけ記録
- **ルーブリック**: `指示達成` / `正確性` / `完全性` / **`コストパフォーマンス`**
  の各1〜5 + 1行理由。依頼文と応答本文の両方を入力にする
  - v0.9.0: 4軸目 `efficiency`(消費トークン・時間に対する成果)を追加。
    審査プロンプトには**ターン統計**(入出力トークン/キャッシュ読み/実測秒/tok-s/コスト)も
    参考情報として渡すため、数字に基づいた判断が可能
  - 旧レビューモデルの出力(3軸のみ)でもパース可能(efficiency 欠落=未収集扱い)
- **実績列挙(v0.9.0)**: 審査結果に `results` 配列を必須化 — 「応答が実際に
  成し遂げた実績」を**具体的な証拠ベースで列挙**(作成・変更したファイル、実行した
  コマンド、提示した回答・数値など)。抽象的な感想は排除し、`/fusion-review` パネルに
  「実績N: …」として表示。直近の審査分を `fusion/auto/*` に保持(最大5件)
- **出力パースの3段フォールバック**: ①JSON(`{"instruction":n,...,"results":[...]}`)
  括弧対応抽出(results 配列・複数行 JSON でも取りこぼさない)→
  ②ラベル付き行(`instruction: 4` / `指示: 4` / `正確: 4` / `完了: 4`)→
  ③文中の独立した1〜5整数を軸順に割当。全滅時はスキップ
- **スキップの永続記録**: 審査できなかった事実(reviewer 不在 / パース失敗 /
  異常値 / 例外)を `fusion/auto-skip/latest` に reviewerRef と理由付きで記録し、
  `/fusion-stats` の「内部審査スキップ」に直近5件を表示。shadow 集計の盲点を可視化
- **保存の分離**: 人間評価と混ぜない。`fusion/auto/<provider>/<model>`(全体)と
  `fusion/auto/task/<category>/<provider>/<model>`(タスク別)に専用保存
- **shadow mode から開始**: 現在はスコアへ反映せず、`/fusion-review` の
  「自動審査(shadow): x.xx/5 (指示… / 正確性… / 完全性…)」表示と
  `/fusion-stats`(「内部審査(shadow)」セクション)のみで数十件回して精度を確認。
  人間評価との乖離が小さいことを確認してからスコア反映へ切替
- **表示**: `/fusion-review` に「自動審査(shadow)」行と直近理由、
  `/fusion-stats` に自動審査一覧(reviewerRef 付き)+ **審査モデル別集計**
  (reviewer が複数あるとき)+ **乖離(shadow − 人間)** を表示。
  `|乖離| ≥ 1.0` のモデルには ⚠ を付ける(A-4 完了条件の確認用)
- **成果物検証**: ビルド/テストが走ったセッションでは、その成否をLLM審査より優先して
  成功判定へ合成(LLM審査より確実なシグナルのため)※未実装
- **コスト**: 応答1件につき審査1回。無料枠枯渇を避けるため軽量モデル指定を推奨
- **完了条件(次)**: shadow 審査と人間評価の平均乖離 < 1.0(30件程度)。
  乖離確認後にスコア反映(active mode)へ切替

### 2. ベンチマーク事前 × 記録実績のブレンディング選定(v0.6)

**現状の欠落**: 選定スコアは自前観測のみで、公開ベンチマーク(下馬評)を参照していません。
そのため観測の少ない新規モデルは常に中立 0.5 扱いとなり、
「たまたま実績が溜まったモデル」(Inkling 189件/100%など)が常勝する cold-start 偏りがあります。

- **シード**: `data/benchmarks.json` に モデル × タスク種別 × スコア(0〜1) を登録。
  手動シード + 取得スクリプトのハイブリッド(README v0.5 時点から掲載の予定項目を具体化)
  - 入手元: [OpenRouter モデルDB](https://openrouter.ai/models) と
    [HuggingFace OpenEvals リーダーボード](https://huggingface.co/spaces/OpenEvals/every-leaderboards)
  - **2026-11-14 拡充**: 6モデル → 21モデル(DeepSeek V4 系、Xiaomi MiMo 2.6、
    MiniMax M3 系、Kimi K3 系、Step 5 Preview、Qwen 3.8 Max、Ling 3.2 Flash(:free)、
    Nemotron 3 Ultra/3.5 系(:free)、GPT-OSS 120B、Mistral Large 4)。
    拡充分は Artificial Analysis の intelligence_index ÷100 で全カテゴリを代替
    (coding/agentic 未掲載モデルのため。既存 inkling-2-small と同じ代用規約)。
    free 枠の候補として Ling 3.2 Flash(30)、Nemotron 3 Ultra(12)、
    Nemotron 3.5 系(6/14)を追加済み。
  - **陳腐化規則**: `fetchedAt` から90日経過でベンチマーク事前の k を半減(§2 合成の実装)
- **カテゴリ対応**: coding → SWE-bench 系 / research → 知識QA系 / writing → 長文要約系、
  のようにタスク種別に対応するベンチマーク軸をマップ
- **合成方法(ベイズ事前)**: 観測成功率を `Beta(α, β)` の事前で平滑化する。
  `α = benchmark × k`、`β = (1 − benchmark) × k`、実績 n 件の重みは `n / (n + k)`。
  観測が溜まるほど下馬評は後退し、**実績が最終的に支配する**
  - `k` は新オプション `benchmarkPriorWeight`(既定 5 程度、0 で機能OFF)
- **予算内のみ適用**: `fusion-costcap` の上限でフィルタした後の候補に事前を適用。
  「予算内でベンチマーク強いモデルを優先、実績で補正」の順序。下馬評で予算外の
  高コストモデルが侵入することはない
- **ベンチマーク不在のモデル**: 中立 0.5 の事前(= 現行動作と同等)。減点はしない
- **注意**: 下馬評は陳腐化・出典偏在があるため「事前」に限定し、記録実績が常に上書きする設計とする

### 3. Jev(TypeSafe System One)統合の検討(v0.7)

Jev は自然言語を理解し**型付き判定と確率**(Choice / Score / Noul)を約100msで返す
System One モデルです。「コードが制御フローを持ち、モデルは狭く型付けされた判断だけを返す」
という fusion の設計思想(**判定は Composable に、制御はコードが持つ**)と高く整合します。

| 適用箇所 | 現状 | Jev での置換後 |
| --- | --- | --- |
| タスク分類 | LLM 自由文 JSON + キーワード正規表現の二段フォールバック | `Choice`(6カテゴリ)。`confidence` 低なら未分類(現行の「推測しない」方針を確率で表現) |
| 内部レビュー | 未実装 | `Score`(ルーブリック各軸) + `Noul`(指示に応えたか/引用整合)を**1リクエストで並列質問**。Composite scoring パターンでコード側が重み合成 |
| モデル適性判定 | なし(メタデータ未評価) | 候補モデルの属性(コンテキスト長・モダリティ・ベンチマーク)を state にして「この課題に適するか」を `Score` 判定 → ブレンディングの第4信号 |
| オーケストレーション形態選択 | なし(常に単一モデル) | `Choice`(7トポロジー)。確率分布ごと記録し、カテゴリ別の記録コスパと合成(→ §4) |
| 不確実性処理 | なし | `confidence` しきい値未満は人間レビュー(`/fusion-review`)へエスカレーション |

設計上の制約:

- **確定的処理はコードのまま**: コスト上限・クールダウン・統計集計は Jev に渡さない
  (TypeSafe の指針「code owns the workflow」通り)。Jev は意味判断にのみ使う
- **重みは設定可能のまま**: 判定は個別に保持し、合成はコード側の重み付け
  (Composite scoring)。重み変更に再推論は不要
- **縮退運転**: TypeSafe API が無い環境では現行の LLM/キーワード経路へフォールバック
  (classifierModel と同じ二段構成)。API キーは `/fusion-jev-key`(後述)の入力ダイアログ、
  または `TYPESAFE_API_KEY` 環境変数から読み込む
- **注意**: 判定は確率であって真実ではない。閾値(shadow mode での人間評価との一致率)を
  自データで検証してからスコア反映する。API キーはサーバー側で管理
- **決めること**(2026-11-14 確定): Jev API キーはユーザーが既に所持。
  `/fusion-jev-key` の入力ダイアログを用意し、その段階で提供される。
  API コスト対効果(応答ごと +1 判定か、分類・トポロジー判定のみに留めるか)/
  トポロジー事前(Choice 分布)の保存期間と陳腐化管理

**実装状況(2026-11-14、v0.7a)**: `plugins/adaptive-fusion/jev.ts` に System One
クライアントを実装済み。分類は Jev `Choice`(6カテゴリ、confidence ≥ 0.5)を最優先し、
失敗・低 confidence 時は従来の LLM/キーワード経路へフォールバック。トポロジー判定は
同一リクエストに並列質問で行い、判定は `fusion/topology/*` に記録(実行は v0.7a では
single/router のまま、sequential-chain は記録のみ)。`TYPESAFE_API_KEY` 環境変数または
`/fusion-jev-key` でキーを登録すると有効化され、未登録なら従来経路で動作する。

### 4. オーケストレーション形態の自動選択 — Jev トポロジー判定(v0.7)

ユーザーの入力プロンプトに対し、実施すべきオーケストレーション形態を Jev に判定させます。

**判定(`Choice` プリミティブ)**:

- 選択肢: `single` / `router` / `sequential chain` / `Parallel Fan-out / Fan-in` /
  `Hierarchical` / `Multi-Agent Collaboration` / `Graph(State Machine)`
- `criteria` には各形態の「何が来たら選ぶか」を対比で定義する
  (例: fan-out =「独立したサブタスクに分解でき、並列に処理できる」、
  chain =「計画→実行→検証の順序依存がある」、single =「単一の質問・編集で1モデルで十分」)
- `state`: ユーザー指示文 + タスク分類結果 + カテゴリ別の記録コスパ実績
- 返却は確率分布ごと記録する(トポロジー事前として蓄積 → §5 で利用)
- `confidence` が閾値未満 → 最も安い `single`(または `router`)へフォールバック

**実行形態(OpenCode 内での実装上の現実)**:

プラグインフックは応答本文を差し替える仕組みではなくモデルを差し替える仕組みのため、
各トポロジーは `ctx.experimental.generate.text`(分類器・サマライザーと同じ経路)による
**補助オーケストレーション**として実装します。主応答は常に主モデルが書き、
オーケストレーション成果は主モデルへの参照コンテキストとして渡します
(応答の置換は行わない= 現行アーキテクチャの安全な形)。
**(2026-11-14 決定)** `model.resolve` がプロンプト本文を差し替えられない場合は、
chain/fan-out の「実行」を行わず**判定と記録のみ**に留めます(v0.6 互換、安全な縮退)。

**実装状況(2026-11-14 更新、v0.7a 完全版)**: 判定と記録に加え、**sequential-chain の
補助実行を解禁**(当初の C-3 案どおり)。当時の技術リスクだった「計画を主モデルへ渡す
経路」は、OpenCode v2.3.0 の `context` フック(`event.system.push`)で公式に解決された
(P0 実機プローブで注入がモデルに届くことを確認済み。詳しくは
`.docs/plan_v0.7a-chain.txt`)。`topologyMode`(`auto`/`fixed`)、
`allowedTopologies`(既定 `["single","router","sequential-chain"]`)、
`maxTopologyCalls`(既定 4)、`chainMode`(`off`/`active`、既定 off)を新設。
`confidence < 0.7` または `allowedTopologies` 外/コストガード不足の場合は `single` へ縮退。
観測は `/fusion-stats` の「トポロジー(観測)」セクションに表示され、`/fusion-reset` で消去できます。
fan-out/hierarchical の実行は v0.7b で解禁予定(同じ context フック機構の拡張)。

**chain 実行の流れ(v0.7a 完全版)**:
1. admission(prompt フック)で分類+トポロジー判定 → chain 選択かつ `chainMode=active`
   かつ `maxTopologyCalls >= 2` のときだけ実行 pending をセット
2. 主モデル dispatch 直前(context フック)で planner を実行
   (`generateWithFallback`、8秒タイムアウト)し、計画3-5行を system へ「参考」として注入
   — 注入は送出する1呼出限定で履歴は汚さない。tool 継続でも同一 turn の計画を再注入
3. 応答後は従来どおり観測 + autoReview が verifier を兼ねる(追加コストなし)
4. planner 失敗/タイムアウト時は注入せず single 相当で続行(縮退、例外を出さない)
5. 実行計画は `/fusion-review` パネルの「実行計画(chain)」行で確認できる。
   補助呼出数は `TopologyStat.auxCalls/auxMs` に記録され `/fusion-stats` に表示
6. `/fusion-chainmode` で off/active を切替(既定 off。品質比較のデータが揃ってから
   active 運用へ移行する2段階方式)

**chain の選ばれ方とテスト手順**: Jev キーありでは `Choice` が confidence≥0.7 で
chain を選べば実行される(Jev 判定の確率分布は事前として蓄積される)。Jev キーなしでは
実績ヒューリスティックが「chain の観測が3件以上」を要求するため、初期状態では chain は
選ばれない(鶏と卵)。テスト/ブートストラップには
`allowedTopologies: ["sequential-chain"]` を options に設定して強制し、chain 実績を
3件以上溜めてから通常設定へ戻すと、ヒューリスティック経路でも chain が選択可能になる。
動作確認は `/fusion-review` の「実行計画(chain)」行と `/fusion-stats` の
トポロジー(観測)行の `aux` 表示、およびルーティングログの `CHAIN plan injected` で行う。

### ティアルーティング(v0.8・実装済み)

GitHub Copilot Fusion / Project HydraFusion が行っている「タスク負荷・知能負荷に応じた
モデル選択」に相当する機能。ホワイトリストの強化版として、**負荷帯ごとのモデルグループ
(ティア)**をユーザーが編成できる。

**構成要素**:

- **負荷帯(3段階)**: `Light` / `Middle` / `Heavy`。admission の分類時に
  difficulty(0-100) を推定し、`34` / `67` を閾値に3分割する。
- **ティア**: 各負荷帯に対応するモデルグループ。各層に複数の `provider/model`
  を設定できる(`tiers` オプション、`/fusion-tiers` で編集)。層内では既存の
  Routing Score(statScore+探索)がそのまま働くため、ティアは「プール」を定義するだけ。
- **tierMode**: `off`(既定・全候補から選択)/ `manual`(ユーザー定義ティア)/
  `auto`(ベンチマーク overall の降順で候補を3分割。ベンチマーク3件未満なら従来選択に縮退)。
  `/fusion-tiermode` で切替。

**負荷推定の3段縮退**(追加の API 呼び出しを発生させない):

1. **Jev Score**: カテゴリ分類と同じ1往復の `ask` に difficulty(score 0-100)を同居。
2. **LLM**: 分類 LLM の JSON に `"difficulty":<0-100>` を追加で要求。
3. **ヒューリスティック**: カテゴリ既定 + 文字数 + multi-step キーワード
   (リファクタ/設計/一括移行など)で 0-100 を概算。キー・LLM なしでも常時動作。

**選択とカスケード**: `experimental.model.resolve` の選択時に、セッションの負荷帯の
ティア内の健全(非クールダウン)モデルに候補を絞る。該当ティアが枯渇(全滅/不在)なら
**上方カスケード**(Light→Middle→Heavy)で昇り、全ティア枯渇なら従来の全候補選択に縮退。
下位への自動降格は行わない(キャッシュ効果と応答品質の予測可能性を優先)。
`:free` 接尾辞の有無は同一モデル扱い(`benchmarkFor` と同じ正規化)。
rescue(退避)経路でもティアを優先し、ティア内に退避先がなければ従来の rescue 動作。

**観測**: `/fusion-stats` にティアのモードと層ごとの集計(メンバー全体統計の合算から
導出、追加の保存なし)を表示。ルーティングログに `LOAD <tier>(via jev/llm/heuristic)` と
`TIER <tier>(load=...)` を記録。`/fusion-review` パネルに「負荷帯(tier)」行を表示。

**注意**: crossProvider 時の保守規則(観測ゼロのモデルを自動差し替え先にしない)は
ティア内でも適用される。新規モデルをティアに加えた場合は `/fusion-probe` で観測を作って
から使うと確実に選ばれる。

実装済みの判定フロー(2026-11-14):
1. カテゴリ分類が確定した**後**に `pickTopology()` を呼び出す(1リクエスト2質問ではなく、
   トポロジー判定の state に `category` と「カテゴリ別トポロジー実績の要約」を入れるための2段構成)。
2. Jev 利用可: `Choice`(`allowedTopologies` のみを選択肢)。state は
   `{ instruction, category, categoryTopologyStats }`。`confidence < 0.7` → `single` へ縮退。
3. Jev 不可: **実績ベースのヒューリスティック**(カテゴリ別実績が3件以上ある形態から
   `0.8 × 自動審査品質平均 + 0.2 × 人間コスパ評価平均` の最高スコアを選択。評価が1件も無い形態は除外。
   該当なし → `single`)。これによりキーなしでも「このカテゴリでは chain が安い」が学習される。
4. 統計は `fusion/topology/<topology>`(全体)と `fusion/topology/task/<category>/<topology>`
   (タスク別)の `TopologyStat` に、実行結果(ok/ms)・自動審査品質(sumQuality/qualityCount)・
   人間コスパ評価(sumCostPerformance/costPerformanceCount)・lastUsedAt とともに蓄積される。

| トポロジー | 実行形態 | 呼び出し数 |
| --- | --- | --- |
| single | 現行動作(セッションモデル1つ) | 1 |
| router | タスク分類 → カテゴリ別専門モデル選択(ほぼ実装済み) | 1+分類 |
| sequential chain | 計画 → 実行 → 検証 の段階を多段 generate.text で実行 | 2〜3 |
| Fan-out / Fan-in | サブタスク分解後、複数モデルへ並列 generate.text、主モデルが統合 | N+1 |
| Hierarchical | planner が割当、worker が並列実行、synthesizer が統合 | N+2 |
| Multi-Agent Collaboration | 複数モデルが独立回答し、judge が合議 | N+1 |
| Graph(State Machine) | 状態遷移つきタスク実行。最も実装コストが高い | 動的 |

段階リリース: **a)** single / router / chain → **b)** fan-out/fan-in + hierarchical →
**c)** collaboration + graph(a と b が安定してから)。

**コストガード**:

- 各トポロジーに呼び出し倍率を定義し、`fusion-costcap` の予算 × 倍率で事前チェック
- `maxTopologyCalls`(既定 4 程度)で fan-out 数を上限化
- 予算超過時は Jev の判定が `fan-out` を指していても `single` へ縮退
  (**判定と実行は分離**。TypeSafe の「code owns the workflow」通り、実行可否はコードが決める)

**Jev API キーがない場合のフォールバック**:

- トポロジー判定を Jev に任せない: タスク分類 + プロンプト長・複雑さのヒューリスティック +
  **カテゴリ別の記録コスパ実績**(評価値ベース)で選択
- 記録コスパが無いカテゴリは `single`(従来動作)を選ぶ。つまりキーの有無で
  挙動が破綻せず、キーがあるときだけ判定精度が上がる構成
- キーの有無は `jevAvailable` として `/fusion-config` に表示

### 5. トポロジーコストパフォーマンスのレビュー(v0.7、**一部実装済み**)

`/fusion-review` を「担当モデルの成果評価」と「オーケストレーション形態のコスパ評価」の
2軸に拡張します。モデル選定(v0.6 §2)と同じ「**事前 × 記録実績**」ブレンディングを
トポロジー選定にも適用する対称設計です。

- パネル表示の追加: 使用トポロジー + **観測実績**(実行回数 / ok率 / 実測レイテンシ / 品質平均)
  + コスパ評価平均(`/fusion-review` 第2行目)【実装済み】
  (「推定トークン・コスト」の表示は未実装 — トークン計測は v0.7b で対応)
- 評価軸の追加: モデル成果 `[1-5]`(既存)+ **トポロジーコスパ `[1-5]`**(第2行)【実装済み】
  (「この形態はコストに見合ったか」— 第1行はモデル評価、第2行は形態コスパ)
- 保存: 計画では `fusion/topology-feedback/*` を想定していたが、実装では既存の
  `fusion/topology/<topology>` / `fusion/topology/task/<category>/<topology>` の
  `TopologyStat` に `sumCostPerformance` / `costPerformanceCount` として相乗りさせた
  (スキーマ移行を避けるための簡素化。`v0.7c` で分離可能)【実装済み】
- トポロジー選定スコア(**D-4 実装済み、2026-11-14**):

```
topologyScore(t | category)
  = w1 × Jev事前適性(t | category)   ← §4 の Choice 確率分布の平均(sumJevPrior/jevPriorCount)
  + w2 × 記録コスパ評価(t | category) ← この節の人間評価(0〜1 正規化)
  + w3 × 自動観測(内部審査の品質平均。無ければ ok 率)
(w1-w3 は設定可能: topologyWeightJev=0.5 / topologyWeightHumanCP=0.25 /
 topologyWeightAuto=0.25。Jev キー無し時は w1 を 0 扱い、w2+w3 で正規化。
 データの無い軸は中立 0.5。/fusion-stats の「トポロジー(観測)」に score を表示)
```

  実装状況: Jev 利用時は `Choice` の confidence(≥ 0.7)による採否を優先し、
  判定の**確率分布を `TopologyStat.sumJevPrior` に記録**する。
  Jev 不可時(または Jev 呼び出し失敗時)は上記の加重合成で
  実績3件以上の形態から最高スコアを選ぶ。`/fusion-config` に重みを表示。
- これにより「このカテゴリでは chain が安くて十分」「research は single で足りる」
  のような**カテゴリ別の形態適応**が学習されていく(両経路で統計が共有される)

### 6. Jev 活用の全体像 — キー有無での動作マトリクス

「**キーがあれば Jev の判定器を最大限活用し、なければ従来動作 + 記録評価値で縮退**」
をすべての判定点で統一します。

| 判定点 | Jev キーあり | Jev キーなし(従来動作) |
| --- | --- | --- |
| タスク分類 | `Choice`(6カテゴリ)+ confidence | classifierModel の LLM JSON → キーワード推定(現行) |
| オーケストレーション形態 | `Choice`(allowedTopologies)、confidence≥0.7 で採用。確率分布を事前として記録 | topologyScore 加重合成(w1=0、コスパ+自動観測の最高評価) |
| 内部レビュー | (計画) `Score` + `Noul` の並列質問 → Composite scoring | reviewModel の LLM ルーブリック審査(§1、shadow)【実装済み】 |
| モデル適性 | (計画) 候補属性を state にした `Score` 判定 | ベンチマーク事前のみ(§2)【実装済み】 |
| トポロジー選定の合成 | Jev Choice の confidence 判定 + 事前確率の記録(w1 有効) | topologyScore 加重合成(w1=0)【実装済み】 |

- キーの有無は起動時に検出し、`jevAvailable` として `/fusion-config` に表示する
- どちらの経路でも保存スキーマ・統計キーは同一にする
  (Jev の有無は「事前の質」が変わるだけで、蓄積データは共有される)

### リリース計画(まとめ)

| 版 | 内容 | 完了条件 |
| --- | --- | --- |
| v0.6 | §1 内部レビューハーネス(shadow mode)+ §2 ベンチマーク事前合成 | shadow 審査と人間評価の平均乖離が 1.0 未満。ブレンディングで cold-start 偏り(Inkling 常勝)が改善 |
| v0.7a | Jev タスク分類 + トポロジー判定 + D-4 topologyScore 加重合成 + §5 2軸レビュー + **sequential-chain 補助実行** | **実装済み(2026-11-14)**。Jev 分類 + confidence<0.7 縮退 + topologyScore ヒューリスティック縮退。chain 実行は `chainMode=active` で解禁(context フックで計画注入、planner 失敗時は single 縮退)。既定は off |
| v0.7b | `fan-out/fan-in` + `hierarchical` + コストガード完成 | `maxTopologyCalls` 内で予算超過ゼロ。fan-in 統合の品質が単独モデルを上回る(自動審査で検証)。chain 実行の品質比較(chain vs single 各15件)も完了条件 |
| v0.7c | `collaboration` + `graph` + §5 残り(コスパ/観測統計キーの分離・推定トークン表示) | カテゴリ別の形態適応が統計として確認できる |
| v0.8 | **ティアルーティング**(Copilot Fusion / HydraFusion 方式): 負荷推定(Jev Score → LLM → ヒューリスティック)+ Heavy/Middle/Light のモデルグループ + 上方カスケード | **実装済み(2026-11-14)**。負荷帯ごとにティア内選択、枯渇時は上方カスケード、全滅時は従来選択に縮退。既定 off |
| v0.9.0 | **レビュー拡張**: 遡及レビュー(offset)+ ターン統計(tokens/cost/実測tok-s)+ 自動審査の実績列挙 + efficiency 軸 | **実装済み(2026-11-15・実機検証)**。`/fusion-review` で 1〜N 個前の応答もレビュー可、採用トポロジーとターン統計を同表示、shadow 審査が `results` 配列(証拠ベースの実績列挙)と `efficiency`(コストパフォーマンス軸)を出力。旧3軸出力にも後方互換 |

### 新設オプション(v0.6/v0.7・実装済みは明記)

| オプション | 既定 | 説明 |
| --- | --- | --- |
| `benchmarkPriorWeight` | `5` | ベンチマーク事前の強さ(k)。0 で機能OFF(§2)【実装済み】 |
| `benchmarksFile` | `data/benchmarks.json` | 下馬評シードの参照先(相対パス可、既定はプラグインからの相対解決)【実装済み】 |
| `reviewModel` | (なし) | 内部審査に使うモデル。未指定なら classifierModel と同じフォールバック経路【実装済み】 |
| `topologyMode` | `auto` | `auto`(Jev/実績で選択)/ `fixed`(現行どおり single 固定)【実装済み】 |
| `allowedTopologies` | `["single","router","sequential-chain"]` | 実行を許可する形態のホワイトリスト(段階リリースと連動、§4)【実装済み】 |
| `maxTopologyCalls` | `4` | 1応答あたりの補助呼び出し上限(コストガード、§4)【実装済み】 |
| `topologyWeightJev` | `0.5` | トポロジー選定スコアの Jev 事前重み(w1)。Jev キー無し時は自動で 0 扱い(§5/D-4)【実装済み】 |
| `topologyWeightHumanCP` | `0.25` | 同・人間コスパ評価の重み(w2)(§5/D-4)【実装済み】 |
| `topologyWeightAuto` | `0.25` | 同・自動観測(品質/ok率)の重み(w3)(§5/D-4)【実装済み】 |
| `chainMode` | `off` | sequential-chain の補助実行。`active` で chain 選択時に planner(8s timeout)が計画を作り system へ参考注入(`/fusion-chainmode` で切替)【実装済み】 |
| `tierMode` | `off` | ティアルーティング。`manual`(ユーザー定義ティア)/ `auto`(ベンチマーク overall 降順の3分割)/ `off`(全候補から選択)。`/fusion-tiermode` で切替【実装済み】 |
| `tiers` | `(全層空)` | ティアごとのモデルグループ `{ heavy: [], middle: [], light: [] }`。各層に複数の `provider/model` を設定可。`/fusion-tiers` で編集【実装済み】 |
| `jevMode` | `auto` | `auto`(キー検出で有効化)/ `off`。キーは `TYPESAFE_API_KEY` 環境変数か `fusion/jev-key`(`/fusion-jev-key` で登録)【実装済み】 |
| `autoReviewMode` | `shadow` | 内部審査の反映モード(`off / shadow / active`)(§1)【未実装】 |

### 補助タスク(順不同)

- SQLite への Metrics DB 移行(統計・審査ログ・ベンチマーク・トポロジー実績の保存先)
- Team-of-Models 用の Markdown エージェント(planner / reviewer / security)
- ベンチマーク取得スクリプトの自動化(出典URL + 取得日を記録し陳腐化検知)
