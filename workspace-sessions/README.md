# workspace-sessions

いま開いているワークスペース (git リポジトリの本体と、その worktree) で動いている・動いていた Claude Code のセッションを、`/ws` で開くペインに並べる mod。

## できること

- **並べる**: 動いているもの (端末の対話・バックグラウンド) → 止まったバックグラウンド → 過去のトランスクリプト の順。よそのリポジトリのセッションは出さない
- **のぞく**: 行を選ぶ (`1`〜`9` か Enter) と、そのセッションの最後の依頼と最後の返答を出す
- **開く** (`o`): バックグラウンドは `claude attach <id>`、過去のものは `claude --resume <id>`。cmux の中なら新しいワークスペースで開き、そうでなければコマンドをクリップボードへ
- **Web** (`w`): Remote Control がつながっているものは claude.ai/code で開く
- **送る**: 動いているセッションへ、その場でメッセージを送る (`$.session.send`)
- `r` で更新、`p` で過去をすべて表示。ペインが開いている間は 20 秒ごとに描き直す

## どこから読んでいるか

| 何 | どこ |
| --- | --- |
| 動いているセッション・止まったバックグラウンド | `claude agents --json --all` |
| 過去のセッション | `~/.claude/projects/<ワークスペースのフォルダ>*/<id>.jsonl` (cwd で確かめる) |
| 題名 | トランスクリプトの `customTitle` / `agentName` / `aiTitle`、無ければ `~/.claude/history.jsonl` の最初の依頼 |
| Web のリンク | `~/.claude/sessions/<pid>.json` の `bridgeSessionId` |

## 確かめる

```sh
claude plugin validate .
claude plugin test .
```
