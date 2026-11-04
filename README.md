# claude-mods

Pregum の Claude Code の mod 置き場。リポジトリ全体がひとつの marketplace (`pregum-mods`) で、mod はフォルダごとに入っている。

| mod | 何をするか |
| --- | --- |
| [workspace-sessions](./workspace-sessions) | `/ws` で、いまのワークスペース (リポジトリと worktree) のセッションを並べ、のぞく・開く・送る |

## 入れ方

ターミナルの Claude Code のプロンプトで:

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
