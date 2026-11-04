# where-now

いまどこまで進んだかを、会話の横のペインに出す mod。

- **計画**: TodoWrite / TaskCreate / TaskUpdate / TaskList の内容と進み具合 (`▶` 進行中、`○` 未着手、`✓` 完了)
- **このターン**: 人の依頼が来てから Read / Write / Edit / NotebookEdit で触ったファイル (`●` 動作中、`✎` 書いた、`·` 読んだ、`✗` 失敗)。最後に触ったものが上。サブエージェントだけが触ったものには `sub` が付く

セッションの開始時に開く。幅が足りないと待つので、そのときは `/where` で開く。

## 入れ方

ターミナルの Claude Code のプロンプトで:

```
/plugin install where-now --marketplace Pregum/claude-mods
```

## 出ないもの

Bash の `cat` や `sed` で読み書きしたファイルは出ない。コマンドの文字列から確実には読み取れないため。

## 確かめる

```sh
claude plugin validate .
claude plugin test .
```
