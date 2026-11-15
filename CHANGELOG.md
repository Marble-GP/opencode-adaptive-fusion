# Changelog

## [0.9.0] - 2026-11-15

レビュー機能拡張リリース。実機検証済み(OpenCode 2.3 / Windows)。

### 追加
- **遡及レビュー(offset)**: `/fusion-review` で 0=最新, 1=1個前, 2=2個前…の応答を
  対象にできる(パネル内の `[◀ 古い方へ]` / `[▶ 新しい方へ]` ナビにも対応)。
  後からバグが見つかった応答を遡って評価・記録できる。RPC の `reviewInfo` /
  `reviewSummary` / `reviewRate` に `offset`(number, 省略時 0)を追加
- **ターン統計**: 応答1ターンあたりの入力/出力/推論/キャッシュ読みトークン、コスト($)、
  実測所要時間、実測スループット(tok/s)を `/fusion-review` パネルに表示。
  メッセージに記録された tokens/cost/time から算出するため過去ターンも後付けで表示可能
- **自動審査の実績列挙(results)**: shadow 審査が「応答が実際に成し遂げた実績」を
  証拠ベースで列挙(作成・変更ファイル / 実行コマンド / 提示した回答・数値など)。
  抽象的感想は排除。`/fusion-review` パネルに「実績N: …」として表示
- **コストパフォーマンス軸 efficiency(1〜5)**: 自動審査の第4軸。審査プロンプトに
  ターン統計を渡し、トークン・時間あたりの成果を採点。`/fusion-review` に「コスパ x.x」
  として表示
- 採用トポロジー・ティア負荷帯・チェーン計画のパネル表示を改善(高さ44・折り返し抑制)

### 変更
- 自動審査プロンプトを4軸 + results 形式に再設計。JSON 抽出を括弧対応の厳密方式に
  (複数行・results 配列を含む出力でも取りこぼさない)。旧3軸出力への後方互換パースは維持
- `fusion/auto/*` の AutoReviewStat に `efficiency`/`efficiencyCount`/`results` を追加
  (旧データは未収集として扱う)

### 互換性
- RPC スキーマの新キーはすべて optional。旧バージョンの storage データ・出力と互換

## [0.8.1] - 2026-11-15

ルーティング堅牢化リリース。実機検証・再現実験で確定した問題を修正。

### 修正
- OpenCode 2.3 の `experimental.model.resolve` は**同一プロバイダーへの書き換えのみ**
  解決する(本体は `y.providerID === m.providerID` のときだけ resolve)。
  異プロバイダーへの退避は `ctx.session.switchModel`(手動選択と同じ安全経路)で
  次の dispatch から適用する **DEFER 経路**に変更(通常時は KEEP で書き換えしない)
- **複数インスタンス(role=server 二重ロード)による `fusion/cooldowns` の
  stale 上書き事故**を、kv をベースにメモリをマージする persist 方式に変更
  (削除は tombstone、TTL 25h)。`/fusion-reset` 後の復活も防止
- 未切替セッションは `session.model` が未設定のため事前rescueが働かなかった問題を、
  resolve フックが実 dispatch モデルを `lastResolved` に記録し、
  事前rescue(`PRE hint`)と step.failed の犯人特定のフォールバックに使用して修正
  (健康モデルの誤冷却を防止)
- TUI トグル⇔サーバー構成の再同期を prompt フックで実施(CONFIG synced ログ)

### 追加
- **検証付き冷却**: 1時間タイマー満了は回復を意味しない。`needsVerify` 付きの冷却は
  実機プローブ(`Reply with exactly: OK`)が成功するまで解除しない
  (失敗時は更に1時間延長)
- 成功時の冷却解除に `RECOVER ok <ref>` ログ、`after-fail` 失敗の logRoute 化、
  ルーティングログを直近20件→200件に拡大

## [0.8.0] - 2026-11-14

- **ティアルーティング**: タスク負荷(Light/Middle/Heavy)に応じてティア内から選択。
  ティアはユーザー編成(manual)またはベンチマーク3分割(auto)。枯渇時は上方カスケード、
  全滅時は従来選択に縮退。既定は off

## [0.7a] - 2026-11-14

- Jev(TypeSafe System One)によるタスク分類 + トポロジー判定(confidence<0.7 縮退)、
  topologyScore ヒューリスティック縮退、D-4 topologyScore 加重合成
- sequential-chain 補助実行(context フックで計画注入、既定は off)
- 内部審査の2軸表示、トポロジー統計 `fusion/topology/*`

## [0.6] - 2026-11-14

- **内部レビューハーネス(shadow mode)**: http.response(ok)の後に依頼文+応答を
  別モデルが3軸採点し `fusion/auto/*` に蓄積(スコア未反映・表示のみ)。
  `/fusion-reviewmodel` で審査モデルを指定可能
- **ベンチマーク事前合成**: `data/benchmarks.json` を Beta 事前(`benchmarkPriorWeight`,
  k=5 既定)として観測成功率を平滑化

## [0.5] - 初版

- 手動レビュー(応答の3行サマリー + 1〜5評価)とコスト上限
  (ホワイトリスト空時の入力/出力トークンレート上限、既定 0=無料モデルのみ)
