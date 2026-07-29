# Phoenix Infra

Local orchestration for the backend stack.

## Run the whole backend

```bash
docker compose -f phoenix/infra/docker-compose.yml up --build
```

Brings up PostgreSQL, Redis, and the four services:

| Service | Port | Health |
| --- | --- | --- |
| auth | 4001 | `GET /health` |
| profile | 4002 | `GET /health` |
| inventory | 4003 | `GET /health` |
| matchmaking | 4004 | `GET /health` |

Each service has a multi-stage `Dockerfile` (build with dev deps → slim runtime
image running `node dist/main.js`). `DATABASE_URL` / `REDIS_URL` are wired now so
swapping the in-memory stores for the Postgres/Redis repositories needs no
compose change.

> Note: `docker compose config` is validated in CI. A live `up`/image build
> needs a running Docker daemon (not available in every sandbox); it runs on any
> normal dev machine or CI runner.
