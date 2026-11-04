# claude-mods

Pregum の Claude Code の mod 置き場。リポジトリ全体がひとつの marketplace (`pregum-mods`) で、mod はフォルダごとに入っている。

| mod | 何をするか |
| --- | --- |
| [workspace-sessions](./workspace-sessions) | `/ws` で、いまのワークスペース (リポジトリと worktree) のセッションを並べ、のぞく・開く・送る |
| [where-now](./where-now) | 計画 todo と、このターンで読んだ・書いたファイルを会話の横のペインに出す |
| [pane-todo](./pane-todo) | Pane アプリの Todo を会話の横のペインに出し、完了・追加・Claude への依頼をその場で |
| [artifact-dates](./artifact-dates) | Artifact を更新日で分けて並べ、本文をのぞいて、続きを頼む・作った会話へ戻る |

## 入れ方

ターミナルの Claude Code のプロンプトで (他の mod も同じ):

```
/plugin install workspace-sessions --marketplace Pregum/claude-mods
```

marketplace を足すか聞かれたら `y`、スコープはそのまま Enter (user)。

シェルからなら:

```sh
claude plugin install workspace-sessions --marketplace Pregum/claude-mods
```

デスクトップアプリでは、プロンプト横の + → Plugins → Add marketplace で `Pregum/claude-mods` を足し、Add plugin から選ぶ。

## mod を足すとき

1. `<mod>/.claude-plugin/plugin.json` と `<mod>/hooks/` を置く
2. `.claude-plugin/marketplace.json` の `plugins` に `{ "name": "<mod>", "source": "./<mod>" }` を足す
3. `claude plugin validate <mod>` と `claude plugin test <mod>` で確かめる
