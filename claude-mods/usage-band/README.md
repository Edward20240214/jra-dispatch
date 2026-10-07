# usage-band

Claude Code の入力欄の上に、レート制限の残り使用量を表示する MOD です。

```
残量 5時間 ███░░░░░░░ 28% 14:30回復 ｜ 週間 ██████░░░░ 55% 10/10 9:00回復
```

- 残量が 50% 以上は緑、20〜50% は黄、20% 未満は赤で表示します
- 1行にまとめて表示します。帯の幅が 80 桁より狭いときはバーを半分の長さにし、それでも収まらないときは末尾を切ります
- 回復（リセット）時刻は日本時間で表示します（当日は時刻のみ、翌日は「明日」、それ以降は日付つき）
- 値は応答のたびに自動で更新されます（Pro / Max などのサブスクリプション接続のみ。API キー接続では表示されません）
- アンケートが出ているあいだは表示を譲ります。`[-]` または ctrl+x ctrl+a で折りたためます
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
