# usage-band

Claude Code の入力欄の上に、レート制限の残り使用量を表示する MOD です。

```
残り使用量   5時間枠 ███░░░░░░░ 残り27.5%（14:30リセット）   週間枠 ██████░░░░ 残り55%（10/10 9:00リセット）
```

- 残量が 50% 以上は緑、20〜50% は黄、20% 未満は赤で表示します
- リセット時刻は日本時間で表示します（当日なら時刻のみ、翌日以降は日付つき）
- 値は応答のたびに自動で更新されます（Pro / Max などのサブスクリプション接続のみ。API キー接続では表示されません）
- アンケートが出ているあいだは表示を譲ります。`[-]` または ctrl+x ctrl+a で折りたためます

## インストール

このリポジトリの既定ブランチに取り込んだあと、ターミナルの Claude Code で:

```
/plugin install usage-band --marketplace Edward20240214/jra-dispatch
```

`Add marketplace?` に `y`、スコープはユーザーを選んで Enter です。

取り込む前に試すときは、リポジトリを手元に置いて:

```
claude --plugin-dir ./claude-mods/usage-band
```

## テスト

```
claude plugin validate claude-mods/usage-band
claude plugin test claude-mods/usage-band
```
