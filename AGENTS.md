# AGENTS.md — cs-demo-downloader (fork guuilp)

Este é o **fork patcheado** do cs-demo-downloader do Claabs, usado exclusivamente
pelo pipeline Mamômetro. O upstream (Claabs) NÃO recebe contribuições deste
fork — o uso aqui diverge (VPN, multi-usuário, throttling real). Não reabrir
PR para o upstream.

## Estado do fork

- **Branch:** `feat/throttle-safe-downloads` (única branch de trabalho).
- **Imagem local:** `mamometro-downloader:local` (buildada deste repo em
  `/tmp/csdd-patched`). O compose do deploy aponta para ela, não para a pública.
- **PR #6 foi fechado** (não-mergeado) — o upstream não deve saber destes patches.
- 11 commits de patch sobre o upstream `master`.

## Os 11 patches (e por que existem)

| Commit | Patch | Motivo |
|---|---|---|
| `e5e449b` | throttle-safe: concurrency, interval 2s, timeout 120s, retry backoff | CDN da Valve throttla com ETIMEDOUT em rajadas |
| `8436799` | cache de share codes (`pendingShareCodes` no store) | restart não refaz o API loop inteiro |
| `1a75694` | força IPv4 (`family: 4`) | VPN sem IPv6 quebrava Happy Eyeballs (ENETUNREACH/timeout) |
| `baba4de` | não retryar 502/permanentes (só rede) | retry de demo expirada só queimava tempo |
| `5b49fcb` | paralelismo 4 (intervalCap 4) | após rede estável, acelerar backfill sem voltar ao burst |
| `f94b834` + `46c6525` | lastShareCode grava com falhas parciais | não perder progresso por um match falho no meio |
| `a8515c5` | checkpoint por usuário durante downloads | downloads levam horas; progresso contínuo |
| `be5451b` | store: escrita serializada + atômica (tmp+rename) | checkpoints concorrentes corrompiam store.json |
| `b46e6e2` | checkpoint NÃO avança em download falho + limpa temp/ + `failedRetries` | download falho avançava lastShareCode e o match era perdido para sempre (177 perdidos em produção) |
| `c37fbd2` | `timeout` nos runs (entrypoint, RUN_TIMEOUT_SEC default 3600s) | hang do game coordinator sem timeout; substituto do watchdog externo |

## Arquitetura interna (relevante para mexer)

- `src/index.ts` — orquestra: GCPD (login sem authCode) + `getAllUsersMatches`
  (authCodes multi-usuário). Baixa via `downloadQueue` (PQueue, concurrency 4).
- `src/steam-gc.ts` — coração do fluxo authCodes: busca share codes novos após
  `lastShareCode`, resolve metadata no game coordinator, baixa demos, faz
  checkpoint por usuário. Contém `failedMatches`/`failedRetries` (patch b46e6e2).
- `src/download.ts` — `downloadSaveDemo`: baixa `.dem.bz2` para `temp/`, extrai,
  renomeia para raiz. Retorna `matchId` em FALHA (não lança) — quem chama DEVE
  tratar o retorno (foi o bug do b46e6e2).
- `src/store.ts` — `store.json`: `lastShareCode`, `pendingShareCodes`,
  `refreshToken`, `failedRetries`. TODA escrita passa por `enqueueWrite`
  (serializa) + `setStore` (tmp+rename). NUNCA escrever direto no arquivo.
- `src/match-history.ts` — `GetNextMatchSharingCode` da API (anda SÓ pra frente;
  é por isso que match "queimado" é perdido para sempre).
- `src/demo-log.ts` — `appendDemoLog` grava TODOS os matches resolvidos em
  `demo-log.csv` ANTES do download (o log pode listar match que falhou). Este
  arquivo é o **sinal confiável de progresso** (o parser deleta os .dem).
- `entrypoint.sh` — lê config, roda run no startup, agenda cron via supercronic
  se `runOnce=false`. Runs envolvidos em `timeout $RUN_TIMEOUT_SEC`.

## Gotchas críticos

1. **`downloadSaveDemo` retorna `matchId` (não lança) em falha** — todo caller
   deve tratar o retorno, senão o checkpoint "queima" o match (perda permanente).
2. **Store é single-writer serializado** — nunca bypass `enqueueWrite`.
3. **`runOnce: false` = cron ativo** (supercronic dentro do container). O
   container fica de pé; `restart: unless-stopped` no compose.
4. **`demo-log.csv` é a fonte para recuperação** de demos que falharam no
   download (as URLs ficam lá). Última recuperação: 177 demos perdidos
   re-baixados direto das URLs do log.
5. **Config vem do roster-sync** (regenera config.json; `runOnce` some na
   regeneração). Não depende do config.json manual.

## Build/validação

```bash
npm run lint    # tsc --noEmit && eslint (10 erros PRÉ-EXISTENTES em download.ts — não corrigir)
npm run build   # tsc -> dist/
# rebuild da imagem local
docker build -t mamometro-downloader:local .
```

## Config (ambiente do deploy)

- `DEMOS_DIR` (default `demos`), `CONFIG_DIR` (default `config`).
- Roda no network namespace do gluetun (VPN) — não tem rede própria.
- `RUN_TIMEOUT_SEC` (entrypoint) e `BACKOFF_*` não existem mais no watchdog
  (removido) — o timeout substituiu.
