# pane-todo

Pane アプリの Todo を会話の横のペインに出す mod。`/todo` で開いてキーを渡す。

Pane の MCP (`pane`) がつながっていることが前提。Todo の中身は手元の Pane から読むだけで、この mod には入らない。

## 入れ方

ターミナルの Claude Code のプロンプトで:

```
/plugin install pane-todo --marketplace Pregum/claude-mods
```

## キー

| キー | 動き |
| --- | --- |
| `1`〜`4` | 今日 / すべて / 重要 / 思いつき |
| `j` / `k` (矢印も) | 次・前を選ぶ |
| Enter | 選んだ Todo をプロンプトの下書きにして閉じる。送るかどうかは自分で決める |
| `s` `s` | 選んだ Todo を Claude へそのまま送る。作業が始まるので、3 秒以内に 2 回押す。Todo は完了にしない |
| `x` / `u` | 完了にする / 直前の完了を戻す |
| `a` | 追加。`明日 17時` のように書くと期限になる。期限が無い Todo は「今日」に出ないので、「すべて」へ移る |
| `d` / `o` | メモの開け閉め / リンクを開く |
| `r` / `q` | 更新 / 閉じる |
| Esc | キーをプロンプトへ返す。ペインは残る |

開いている間は 1 分ごとと、Claude の返答のたびに読み直す。

## 確かめる

```sh
claude plugin validate .
claude plugin test .
```
