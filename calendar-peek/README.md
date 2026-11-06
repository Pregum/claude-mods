# calendar-peek

Google Calendar の直近の予定を、ステータス行とペインに出す mod。`/calendar` で開いてキーを渡す。

claude.ai の Google Calendar コネクタがつながっていることが前提。予定は表示のために読むだけで、変更しない。

## 入れ方

ターミナルの Claude Code のプロンプトで:

```
/plugin install calendar-peek --marketplace Pregum/claude-mods
```

## 見えるもの

- **ステータス行:** 進行中か次の予定と、始まるまでの時間
- **タイムライン:** 1 日、3 日、1 週間で切り替え。今日には現在時刻の行が入り、1 日表示では 15 分以上の空きも出す
- **会議:** Zoom、Google Meet、Teams の URL がある予定には、その印が付く

辞退した予定は出さない。セッションの開始時に読み込み、5 分ごとに読み直す。取得に失敗したときは 1 分後にやり直す。

ペインはセッションの開始時にも開こうとするが、ターミナルの幅が足りないときは出ない。`/calendar` ならどの幅でも開く。

## キー

| キー | 動き |
| --- | --- |
| `t` | 1 日 / 3 日 / 1 週間を切り替え |
| `j` / `k` | 予定を上下に移動 |
| 上下の矢印 | ボタンを順にたどる |
| Enter | 選んでいる予定の会議を開く |
| `o` | 進行中か次の会議を開く |
| `h` | キー一覧の開閉 |
| `q` / Esc | 閉じる |

会議は macOS の `open` で開く。招待の本文は他人が書けるので、開くのは https の Zoom、Google Meet、Teams の URL だけ。

## 確かめる

```sh
claude plugin validate .
claude plugin test .
```
