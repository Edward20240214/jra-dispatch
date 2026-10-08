# usage-band

Claude Code の入力欄の上に、レート制限の残り使用量を表示する MOD です。

```
残量 5時間 ███░░░░░░░ 28% 14:30回復 ｜ 週間 ██████░░░░ 55% 10/10 9:00回復
```

- 残量が 50% 以上は緑、20〜50% は黄、20% 未満は赤で表示します
- 残量が 20% を切ったら、トースト（画面の隅に出るお知らせ）と読み上げで一度だけ知らせます。リセットで回復したあと、また 20% を切ったら再び知らせます
- 読み上げは、自然な声から順に試します: [VOICEVOX](https://voicevox.hiroshiba.jp/)（起動しているとき）→ Windows に入っている日本語の声 → Claude Code の読み上げ（macOS など）→ Windows の警告音
- 読み上げは「けんいちさん、5時間枠の残りが、20パーセントを切りましたよ。1時20分に回復します。」のように、名前で呼びかけて回復時刻も伝えます。呼びかける名前は設定 `name` で決めます（読み間違いを防ぐため、ひらがながおすすめ）。呼びかけをやめるときは `--config name=なし` にします（`--config` では空にできないため）
- 設定は PowerShell などで `claude plugin install usage-band@jra-dispatch-mods --config name=けんいち` のように変えられます（`voice` も同じ書き方です）
- VOICEVOX の声は設定 `voice` で選べます（冥鳴ひまり・ずんだもん・四国めたん・春日部つむぎ・青山龍星・玄野武宏。既定は冥鳴ひまり）。`/config` の一覧か、`~/.claude/settings.json` の `pluginConfigs["usage-band@jra-dispatch-mods"].options.voice` で変えられます
- `/usage-band-test` と入力すると、その場で通知（トーストと音）を試せます。VOICEVOX・標準の声・警告音のどれで鳴らしたかも表示します
- 残量が変わるたびに、ホームフォルダの `.claude\usage-band\usage-log-YYYY-MM.csv` に1行ずつ記録します（月ごとのファイル）。列は `timestamp_jst, weekday, hour, five_hour_used_pct, five_hour_resets_jst, seven_day_used_pct, seven_day_resets_jst` で、Excel・R・pandas でそのまま開けます。`/usage-band-log` でファイルの場所と今月の件数を表示し、設定 `log` を false にすると記録を止めます。Claude Code を同時にいくつも開いていると、まれに1行抜けることがあります
- 中身を見るときは `/usage-band-open` を使うと、記録のコピーを Excel で開きます。元のファイルを Excel で開いたままにしても、書き込めなかった記録は取り置いて、閉じたあとにまとめて書き込みます（そのあいだは画面の隅に注意が出ます）
- 1行にまとめて表示します。帯の幅が 80 桁より狭いときはバーを半分の長さにし、それでも収まらないときは末尾を切ります
- 回復（リセット）時刻は日本時間で表示します（当日は時刻のみ、翌日は「明日」、それ以降は日付つき）
- 値は応答のたびに自動で更新されます（Pro / Max などのサブスクリプション接続のみ。API キー接続では表示されません）
- アンケートが出ているあいだは表示を譲ります。`[-]` または ctrl+x ctrl+a で折りたためます
- スマホの Claude アプリからパソコンの Claude Code を操作するとき（PowerShell で `claude --remote-control` と起動し、スマホの Code から開く）は、スマホのアプリには帯もパネルも出ません。そこで、スマホがつながっているあいだは各回答の下に残量を添えます（パソコンの画面にも同じ行が出ます）。いつでも `/usage-band-now` と入力すると、今の残量を文字で返します
- `/usage-band-pane` は残量パネルを開きます（入力欄の上の帯が出ない画面向け）。パネルが出ない画面でも分かるよう、返事に今の残量も添えます
- 入力欄の上の帯が描けるのはターミナルとデスクトップアプリの Code タブだけです。それ以外の画面しかつながっていないときは、ステータス行と各回答の下に同じ内容を出します（クラウドセッションを Claude アプリで見ている場合は、どちらも表示されないことがあります）

## インストール

このリポジトリの既定ブランチに取り込んだあと、ターミナルの Claude Code で:

```
/plugin install usage-band --marketplace Edward20240214/jra-dispatch
```

`Add marketplace?` に `y`、スコープはユーザーを選んで Enter です。

この種類の MOD（関数フックのプラグイン）は先行公開の機能で、最初はオフになっています。
インストールしただけでは読み込まれないので、環境変数 `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` を設定してください。
Windows の PowerShell なら次の1行です（設定後は PowerShell とデスクトップアプリを起動し直します）:

```
[Environment]::SetEnvironmentVariable("CLAUDE_CODE_ENABLE_FUNCTION_HOOKS", "1", "User")
```

`~/.claude/settings.json` の `env` に `"CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1"` を書いても同じです。
オフのままだと、`claude --debug` のログに `hooks modules are not turned on for installed plugins` と出ます。

取り込む前に試すときは、リポジトリを手元に置いて:

```
claude --plugin-dir ./claude-mods/usage-band
```

## 更新

新しい版を取り込むときは、PowerShell などで次の2行を実行し、Claude Code を起動し直します:

```
claude plugin marketplace update jra-dispatch-mods
claude plugin update usage-band@jra-dispatch-mods
```

## テスト

```
claude plugin validate claude-mods/usage-band
claude plugin test claude-mods/usage-band
```
