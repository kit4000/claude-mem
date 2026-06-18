# Mac mini claude-mem Upstream Operations

この checkout は、素の `claude-mem` upstream ではなく Mac mini の実運用向けに改造している。
今後 upstream を継続的に取り込むため、ローカル改造を「運用ブランチのソース差分」として守り、生成物は毎回 rebuild で作り直す。

## ブランチ方針

- `main`: upstream の基準点として扱う。直接の運用改造を増やさない。
- `mac-mini/server-beta-local`: この Mac mini の運用ブランチ。Docker 実サーバーへ反映するソース差分はここに載せる。
- `mac-mini/integrate/<date>-<upstream>`: upstream 取り込み作業用の一時ブランチ。検証後に `mac-mini/server-beta-local` へ fast-forward または merge する。

## ローカル改造の責務

守るべき改造は以下。

- Claude Code OAuth / subscription を `server-beta` generation worker で使う provider。
- Docker worker へ Claude Code credentials を read-only mount する `docker-compose.claude-oauth.yml`。
- Keychain/Claude credentials を Docker 用ファイルへ同期する `scripts/sync-claude-oauth-credentials.mjs` と launchd installer。
- Postgres server-beta を旧 viewer UI へつなぐ `/api/*` / `/stream` 互換 layer。
- 自然文の日本語出力を絶対ルールとして扱う validation / prompt / fallback。
- `SEOUP` / `ホームページシャトル` を表示上 `HPShuttle` に正規化するローカル alias。
- BullMQ / Postgres generation job の retry、stale lock、startup reconciliation、transient error 分類の運用 hardening。
- 長すぎる prompt card を viewer 上で日本語要約表示する互換処理。

## 生成物の扱い

以下は source of truth ではない。conflict したら source 側を解決し、最後に `npm run build` で作り直す。

- `plugin/scripts/*.cjs`
- `plugin/ui/viewer-bundle.js`
- `plugin/ui/viewer.html`
- `plugin/ui/assets/*`
- `plugin/package.json`
- `plugin/bun.lock`
- `dist/*`
- `openclaw/dist/*`

これらを含む commit は、できれば source commit と分ける。upstream 取り込み時に捨てて rebuild しやすくするため。

## 更新前チェック

```bash
npm run local:upstream-status
```

見る点:

- `ahead/behind`: upstream に対して何 commit 遅れているか。
- `overlap with upstream`: ローカル改造と upstream の変更が同じファイルに触れているか。
- `[generated]`: rebuild で処理する。手作業で意味を読みに行きすぎない。
- `[source]`: 実際に設計判断が必要。

## 取り込み手順

1. 実サーバーの見える状態を保存する。

```bash
curl -fsS http://127.0.0.1:37877/healthz
docker compose -f docker-compose.yml -f docker-compose.claude-oauth.yml ps
```

2. DB backup を取る。

```bash
mkdir -p /Users/macmini/.claude-mem/backups
docker compose -f docker-compose.yml -f docker-compose.claude-oauth.yml exec -T postgres \
  pg_dump -U claudemem -d claudemem \
  > /Users/macmini/.claude-mem/backups/claude-mem-$(date +%Y%m%d-%H%M%S).sql
```

3. ローカル差分を commit する。source/docs/config と generated artifacts は分ける。

4. integration branch を作る。

```bash
git fetch --all --prune
git switch mac-mini/server-beta-local
git switch -c mac-mini/integrate/$(date +%Y%m%d)-origin-main
git merge --no-ff origin/main
```

5. conflict 方針。

- `plugin/scripts/*.cjs` など生成物は upstream 側か一旦削除側で解決し、最後に `npm run build`。
- source file はローカル invariant を守る。
- `package.json` の version bump は upstream を受け入れる。
- `docker-compose.claude-oauth.yml` と credential sync scripts はローカル運用物なので残す。

6. 検証。

```bash
npm run local:update-preflight
npm run build
docker compose -f docker-compose.yml -f docker-compose.claude-oauth.yml build claude-mem-server claude-mem-worker
docker compose -f docker-compose.yml -f docker-compose.claude-oauth.yml up -d claude-mem-server claude-mem-worker
curl -fsS http://127.0.0.1:37877/healthz
docker compose -f docker-compose.yml -f docker-compose.claude-oauth.yml exec -T claude-mem-worker \
  claude -p '日本語で「ok」とだけ返してください。'
```

7. viewer と queue を見る。

```bash
curl -fsS http://127.0.0.1:37877/api/projects
docker compose -f docker-compose.yml -f docker-compose.claude-oauth.yml exec -T postgres \
  psql -U claudemem -d claudemem -At \
  -c "SELECT status, source_type, COUNT(*) FROM observation_generation_jobs GROUP BY status, source_type ORDER BY status, source_type;"
```

## upstream に寄せたい候補

将来的には、以下をローカル専用から upstreamable な設計へ寄せると merge がさらに楽になる。

- `server-beta` の Claude Code OAuth provider を、正式な provider option として upstream に提案する。
- viewer compatibility route を plugin viewer の API contract として整理する。
- 日本語固定は本来 `CLAUDE_MEM_OUTPUT_LANGUAGE=ja` のような設定化が望ましい。
- HPShuttle alias は完全にローカル設定化し、コードに固有名を残さない。
- retry/reconciliation hardening は汎用価値が高いので upstream PR 候補にする。
