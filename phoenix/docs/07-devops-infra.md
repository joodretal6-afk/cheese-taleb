# 07 — DevOps & Infrastructure

**Project Phoenix** — DevOps, CI/CD, Kubernetes, game-server fleet, patch/CDN, and observability.

> Scope: how Phoenix is built, tested, shipped, run, patched, and observed — from a
> laptop running `docker compose up` to a global Kubernetes footprint serving live
> Battle Royale matches on an [Agones](https://agones.dev) fleet.

This document is the source of truth for the `phoenix/infra/` tree:

```
phoenix/infra/
  compose/            docker-compose.yml + per-service overrides, seed data
  docker/             Dockerfiles + .dockerignore per service
  k8s/                Kustomize bases + per-env overlays (dev/staging/prod)
    base/
    overlays/{dev,staging,prod}/
  helm/               3rd-party charts we pin (kafka, redis, prometheus...)
  agones/             Fleet, FleetAutoscaler, GameServerAllocationPolicy
  patch/              Patch builder, manifest schema, CDN invalidation tooling
  ci/                 Reusable GitHub Actions composite actions + workflow templates
  observability/      Prometheus rules, Grafana dashboards, Loki/Tempo config, Alertmanager
```

---

## 0. Service inventory (what we deploy)

| Component | Type | Language/Runtime | Ships in | Where it runs |
| --- | --- | --- | --- | --- |
| `gateway` | Edge API (REST/WS) | NestJS | Docker image | K8s Deployment |
| `auth` | Service | NestJS | Docker image | K8s Deployment |
| `profile` | Service | NestJS | Docker image | K8s Deployment |
| `inventory` | Service | NestJS | Docker image | K8s Deployment |
| `matchmaking` | Service | NestJS | Docker image | K8s Deployment |
| `store` / `economy` | Service | NestJS | Docker image | K8s Deployment |
| `liveops` | Service | NestJS | Docker image | K8s Deployment |
| `analytics-ingest` | Service | NestJS | Docker image | K8s Deployment |
| `editor` | Web app (Map Editor) | React + Vite | Static bundle + tiny API | CDN + K8s |
| `admin` | Web app (Admin Dashboard) | React + Vite | Static bundle | CDN (S3+CloudFront) |
| `game-server` | UE5 dedicated server | UE5 (Linux server target) | Docker image (headless) | **Agones fleet** |
| `game-client` | UE5 player client | UE5 (Android/iOS/Win) | Signed builds + patch bundles | **App stores + CDN**, not K8s |

Two hard rules that drive everything below:

1. **The UE5 client is NOT built in Linux CI.** It is built on dedicated Windows/macOS
   build agents (see §2.5). Linux CI has no working iOS/Android UE5 toolchain, no code
   signing identities, and no console SDKs.
2. **The UE5 dedicated *server*** *is* a Linux headless build — it can be containerized
   and run on Kubernetes via Agones, but it is built on the same UE5 build farm as the
   client (shared engine + cook step), then packaged into a Linux container.

---

## 1. Local development — one command backend

Goal: a new engineer clones the monorepo, runs one command, and has the entire
backend (databases, brokers, all NestJS services) running with seed data in < 5 minutes.
The UE5 client/editor connect to `localhost` gateway.

### 1.1 Compose topology

`infra/compose/docker-compose.yml` brings up:

```
                    ┌───────────────────────────────────────────┐
   UE5 client  ───► │  gateway :8080 (REST) :8081 (WS)           │
   / editor         └───────┬───────────────────────────────────┘
                            │ gRPC (internal docker network: phoenix-net)
        ┌───────────┬───────┼─────────┬────────────┬───────────┐
        ▼           ▼       ▼         ▼            ▼           ▼
      auth       profile inventory matchmaking  store      liveops
        │           │       │         │            │           │
        └─────┬─────┴───┬───┴────┬────┴──────┬─────┴─────┬─────┘
              ▼         ▼        ▼           ▼           ▼
          postgres   redis    kafka     kafka-ui    schema-registry
          :5432      :6379    :9092      :8082        :8085
              │
          (one DB per service via separate schemas / logical DBs)
```

Supporting containers:

| Container | Image | Purpose | Dev port |
| --- | --- | --- | --- |
| `postgres` | `postgres:16-alpine` | Primary datastore (one logical DB per service) | 5432 |
| `redis` | `redis:7-alpine` | Sessions, matchmaking queues, rate limits, caches | 6379 |
| `kafka` | `bitnami/kafka:3.7` (KRaft, no ZK) | Event bus (match events, economy, analytics) | 9092 |
| `kafka-ui` | `provectuslabs/kafka-ui` | Topic/consumer inspection | 8082 |
| `schema-registry` | `confluentinc/cp-schema-registry` | Avro schemas for events | 8085 |
| `minio` | `minio/minio` | S3-compatible object store (assets, patch artifacts) | 9000/9001 |
| `jaeger` | `jaegertracing/all-in-one` | Local traces (OTLP :4317) | 16686 |
| `mailhog` | `mailhog/mailhog` | Captures outbound email locally | 8025 |
| `migrate` | (built) | Runs DB migrations, then exits | — |
| `seed` | (built) | Seeds dev data (test accounts, items), then exits | — |

### 1.2 The compose file (abridged, representative)

```yaml
# infra/compose/docker-compose.yml
name: phoenix

x-service-defaults: &service-defaults
  build:
    context: ../..
    dockerfile: infra/docker/service.Dockerfile
  restart: unless-stopped
  env_file: [ ./.env.dev ]
  networks: [ phoenix-net ]
  depends_on:
    postgres:   { condition: service_healthy }
    redis:      { condition: service_healthy }
    kafka:      { condition: service_healthy }
    migrate:    { condition: service_completed_successfully }

networks:
  phoenix-net: {}

volumes:
  pgdata: {}
  miniodata: {}

services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: phoenix
      POSTGRES_PASSWORD: phoenix
      POSTGRES_MULTIPLE_DATABASES: auth,profile,inventory,matchmaking,store,liveops,analytics
    volumes:
      - pgdata:/var/lib/postgresql/data
      - ./init/create-multiple-dbs.sh:/docker-entrypoint-initdb.d/00-dbs.sh
    ports: [ "5432:5432" ]
    healthcheck:
      test: [ "CMD-SHELL", "pg_isready -U phoenix" ]
      interval: 5s
      timeout: 3s
      retries: 20
    networks: [ phoenix-net ]

  redis:
    image: redis:7-alpine
    command: [ "redis-server", "--appendonly", "yes" ]
    ports: [ "6379:6379" ]
    healthcheck:
      test: [ "CMD", "redis-cli", "ping" ]
      interval: 5s
      timeout: 3s
      retries: 20
    networks: [ phoenix-net ]

  kafka:
    image: bitnami/kafka:3.7
    environment:
      KAFKA_CFG_NODE_ID: "1"
      KAFKA_CFG_PROCESS_ROLES: broker,controller
      KAFKA_CFG_CONTROLLER_QUORUM_VOTERS: "1@kafka:9093"
      KAFKA_CFG_LISTENERS: PLAINTEXT://:9092,CONTROLLER://:9093
      KAFKA_CFG_ADVERTISED_LISTENERS: PLAINTEXT://kafka:9092
      KAFKA_CFG_CONTROLLER_LISTENER_NAMES: CONTROLLER
      ALLOW_PLAINTEXT_LISTENER: "yes"
    ports: [ "9092:9092" ]
    healthcheck:
      test: [ "CMD-SHELL", "kafka-topics.sh --bootstrap-server localhost:9092 --list || exit 1" ]
      interval: 10s
      timeout: 5s
      retries: 20
    networks: [ phoenix-net ]

  migrate:
    build:
      context: ../..
      dockerfile: infra/docker/service.Dockerfile
      target: migrator
    env_file: [ ./.env.dev ]
    command: [ "node", "dist/tools/migrate.js", "--all" ]
    depends_on:
      postgres: { condition: service_healthy }
    networks: [ phoenix-net ]

  seed:
    build:
      context: ../..
      dockerfile: infra/docker/service.Dockerfile
      target: migrator
    command: [ "node", "dist/tools/seed.js" ]
    depends_on:
      migrate: { condition: service_completed_successfully }
    networks: [ phoenix-net ]

  gateway:
    <<: *service-defaults
    build:
      context: ../..
      dockerfile: infra/docker/service.Dockerfile
      args: { SERVICE: gateway }
    environment:
      SERVICE_NAME: gateway
      HTTP_PORT: "8080"
      WS_PORT: "8081"
    ports: [ "8080:8080", "8081:8081" ]

  auth:      { <<: *service-defaults, build: { context: ../.., dockerfile: infra/docker/service.Dockerfile, args: { SERVICE: auth } } }
  profile:   { <<: *service-defaults, build: { context: ../.., dockerfile: infra/docker/service.Dockerfile, args: { SERVICE: profile } } }
  inventory: { <<: *service-defaults, build: { context: ../.., dockerfile: infra/docker/service.Dockerfile, args: { SERVICE: inventory } } }
  matchmaking:{ <<: *service-defaults, build: { context: ../.., dockerfile: infra/docker/service.Dockerfile, args: { SERVICE: matchmaking } } }
  store:     { <<: *service-defaults, build: { context: ../.., dockerfile: infra/docker/service.Dockerfile, args: { SERVICE: store } } }
  liveops:   { <<: *service-defaults, build: { context: ../.., dockerfile: infra/docker/service.Dockerfile, args: { SERVICE: liveops } } }
```

`docker-compose.override.yml` (auto-loaded in dev) adds hot-reload by bind-mounting
source and running `nest start --watch` instead of the compiled image, so code changes
reload without rebuilding images:

```yaml
# infra/compose/docker-compose.override.yml
services:
  gateway:
    build:
      target: dev
    command: [ "pnpm", "--filter", "gateway", "start:dev" ]
    volumes:
      - ../../services:/app/services
      - ../../packages:/app/packages
```

### 1.3 Multi-stage service Dockerfile

One Dockerfile builds every NestJS service (selected by the `SERVICE` build arg),
keeping images small and consistent.

```dockerfile
# infra/docker/service.Dockerfile
# ---- base: pnpm workspace, deps only (cached) ----
FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /app
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/ packages/
COPY services/ services/
RUN pnpm install --frozen-lockfile

# ---- dev: hot-reload target used by compose override ----
FROM base AS dev
ENV NODE_ENV=development
CMD ["pnpm", "start:dev"]

# ---- build: compile TS -> dist ----
FROM base AS build
ARG SERVICE
RUN pnpm --filter "${SERVICE}" build

# ---- migrator: shared tools image for migrate/seed ----
FROM build AS migrator
CMD ["node", "dist/tools/migrate.js"]

# ---- runtime: minimal production image ----
FROM node:22-alpine AS runtime
ARG SERVICE
ENV NODE_ENV=production
WORKDIR /app
RUN addgroup -S app && adduser -S app -G app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/services/${SERVICE}/dist ./dist
COPY --from=build /app/packages ./packages
USER app
HEALTHCHECK --interval=15s --timeout=3s --retries=5 \
  CMD wget -qO- http://localhost:${HTTP_PORT:-3000}/healthz || exit 1
CMD ["node", "dist/main.js"]
```

### 1.4 Developer workflow

```bash
# one-time
cp infra/compose/.env.example infra/compose/.env.dev

# bring up the whole backend (build, migrate, seed, run)
make dev          # -> docker compose -f infra/compose/docker-compose.yml up --build

# tail one service
docker compose logs -f matchmaking

# run a migration you just wrote
docker compose run --rm migrate node dist/tools/migrate.js --service inventory

# reset everything (drops volumes)
make dev-reset    # -> docker compose down -v && make dev
```

The UE5 client is pointed at `http://localhost:8080` / `ws://localhost:8081` via its
dev `DefaultEngine.ini` config. For a local *match*, developers run a single game-server
container directly (`docker compose --profile gameserver up game-server`) rather than the
full Agones stack — Agones is a staging/prod concern (see §3.5).

---

## 2. CI/CD — GitHub Actions

### 2.1 Repo strategy & triggers

Monorepo with **path-filtered pipelines** — a change to `services/auth` should not rebuild
the editor. We use [`dorny/paths-filter`](https://github.com/dorny/paths-filter) to compute
which components changed, then fan out.

| Workflow file | Trigger | Does |
| --- | --- | --- |
| `ci-services.yml` | PR + push to `main`/`release/*` touching `services/**`, `packages/**` | lint, test, build, image push |
| `ci-web.yml` | same for `editor/**`, `admin/**` | lint, test, build static bundles |
| `cd-deploy.yml` | push of image tag / `release/*` tag | deploy to K8s via Argo/kubectl |
| `client-build.yml` | manual `workflow_dispatch` + `release/client-*` tag | dispatches UE5 build to **self-hosted Windows/mac runners** |
| `patch-publish.yml` | successful client build artifact | builds delta patches, uploads to CDN, publishes manifest |
| `security.yml` | PR + nightly | Trivy image scan, `pnpm audit`, CodeQL, secret scan |

### 2.2 Service pipeline (`ci-services.yml`)

```yaml
name: ci-services
on:
  pull_request:
    paths: [ "services/**", "packages/**", "infra/docker/**" ]
  push:
    branches: [ main, "release/**" ]

concurrency:
  group: ci-services-${{ github.ref }}
  cancel-in-progress: true

jobs:
  changes:
    runs-on: ubuntu-latest
    outputs:
      services: ${{ steps.filter.outputs.changes }}
    steps:
      - uses: actions/checkout@v4
      - uses: dorny/paths-filter@v3
        id: filter
        with:
          filters: |
            gateway:     services/gateway/**
            auth:        services/auth/**
            profile:     services/profile/**
            inventory:   services/inventory/**
            matchmaking: services/matchmaking/**
            store:       services/store/**
            liveops:     services/liveops/**
            packages:    packages/**   # forces full matrix when shared libs change

  build-test:
    needs: changes
    if: needs.changes.outputs.services != '[]'
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        service: ${{ fromJSON(needs.changes.outputs.services) }}
    services:
      postgres:
        image: postgres:16-alpine
        env: { POSTGRES_USER: phoenix, POSTGRES_PASSWORD: phoenix, POSTGRES_DB: test }
        ports: [ "5432:5432" ]
        options: >-
          --health-cmd "pg_isready -U phoenix" --health-interval 5s --health-retries 20
      redis:
        image: redis:7-alpine
        ports: [ "6379:6379" ]
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm --filter ${{ matrix.service }}... lint
      - run: pnpm --filter ${{ matrix.service }}... typecheck
      - run: pnpm --filter ${{ matrix.service }}... test:unit
      - run: pnpm --filter ${{ matrix.service }}... test:e2e   # spins against the pg/redis services above
      - uses: codecov/codecov-action@v4

  image:
    needs: [ changes, build-test ]
    if: github.event_name == 'push'          # only build/push images on merge, not PRs
    runs-on: ubuntu-latest
    permissions: { contents: read, packages: write, id-token: write }
    strategy:
      matrix:
        service: ${{ fromJSON(needs.changes.outputs.services) }}
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-buildx-action@v3
      - uses: docker/login-action@v3
        with: { registry: ghcr.io, username: ${{ github.actor }}, password: ${{ secrets.GITHUB_TOKEN }} }
      - uses: docker/build-push-action@v6
        with:
          context: .
          file: infra/docker/service.Dockerfile
          build-args: SERVICE=${{ matrix.service }}
          push: true
          # immutable, traceable tag: <service>-<git-sha>
          tags: |
            ghcr.io/phoenix/${{ matrix.service }}:${{ github.sha }}
            ghcr.io/phoenix/${{ matrix.service }}:main
          cache-from: type=gha
          cache-to: type=gha,mode=max
          provenance: true          # SLSA build provenance
          sbom: true
      - name: Sign image
        run: cosign sign --yes ghcr.io/phoenix/${{ matrix.service }}:${{ github.sha }}
```

Key decisions:

- **Immutable image tags** are the git SHA. `main`/`release` tags are *moving* pointers
  for humans; deploys always pin the SHA digest.
- **Images built only on merge**, not on every PR push, to save minutes; PRs run
  lint/test/build-only.
- **Supply chain:** `cosign` signatures + SBOM + SLSA provenance; verified by a Kyverno
  admission policy in prod (§3.4).

### 2.3 Web pipeline (editor + admin) (`ci-web.yml`)

```yaml
jobs:
  web:
    strategy:
      matrix: { app: [ editor, admin ] }
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm --filter ${{ matrix.app }} lint
      - run: pnpm --filter ${{ matrix.app }} test        # vitest + RTL
      - run: pnpm --filter ${{ matrix.app }} build        # vite build -> dist/
      - run: pnpm --filter ${{ matrix.app }} test:e2e     # playwright against a preview server
      - uses: actions/upload-artifact@v4
        with: { name: ${{ matrix.app }}-dist, path: ${{ matrix.app }}/dist }
```

**Admin** is a pure static SPA → published to S3 + CloudFront (§4 CDN pattern reused).
**Editor** is static bundle + a small companion API (map import/export, asset upload) →
static to CDN, API to K8s. Deploy step (in `cd-deploy.yml`) syncs `dist/` to the bucket
and issues a CloudFront invalidation for `index.html` only (hashed assets are immutable).

### 2.4 CD / deploy pipeline (`cd-deploy.yml`)

We use **GitOps**: CI never `kubectl apply`s to prod directly. Instead CI bumps image
digests in the environment overlay repo, and **Argo CD** reconciles the cluster to match Git.

```
merge to main ─► ci-services builds+signs image (sha digest)
             ─► cd-deploy job runs `kustomize edit set image` in overlays/staging
             ─► commits to gitops repo  ─► Argo CD auto-syncs staging
                                          └─► prod overlay is bumped only by a
                                              release PR (manual approval, §6)
```

```yaml
# cd-deploy.yml (staging auto, prod gated)
jobs:
  bump-staging:
    if: github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { repository: phoenix/gitops, token: ${{ secrets.GITOPS_PAT }} }
      - run: |
          cd overlays/staging
          for svc in $CHANGED_SERVICES; do
            kustomize edit set image ghcr.io/phoenix/$svc=ghcr.io/phoenix/$svc@${DIGEST}
          done
          git commit -am "staging: bump ${CHANGED_SERVICES} to ${GITHUB_SHA}"
          git push
```

### 2.5 UE5 client build — why it is separate, and how

**Why not Linux CI:**

| Blocker | Detail |
| --- | --- |
| iOS build | Requires macOS + Xcode + Apple provisioning profiles/signing. Impossible on Linux. |
| Android build | UE5 Android toolchain (NDK/Gradle/AGDE) is supported and reliable on Windows/macOS; Linux support is unofficial and fragile. |
| Code signing | Keychain (Apple) and keystore (Google Play) live on secured build machines, not ephemeral Linux runners. |
| Cook + shader compilation | Cooking content and compiling shaders for mobile is heavy (RAM/disk/GPU) and platform-specific; needs long-lived, fat build agents with warm DDC. |
| Engine size | A UE5 source + DDC checkout is hundreds of GB; ephemeral `ubuntu-latest` runners are unsuitable. |

**How it is built** — a dedicated **self-hosted build farm** registered as GitHub Actions
runners with labels `[self-hosted, ue5, windows]` and `[self-hosted, ue5, macos]`:

```yaml
# client-build.yml
name: client-build
on:
  workflow_dispatch:
    inputs:
      platform: { type: choice, options: [ android, ios, both ] }
      config:   { type: choice, options: [ Development, Shipping ] }
  push:
    tags: [ "release/client-*" ]

jobs:
  android:
    if: inputs.platform == 'android' || inputs.platform == 'both'
    runs-on: [ self-hosted, ue5, windows ]      # fat Windows build box
    steps:
      - uses: actions/checkout@v4
        with: { lfs: true }                      # art via Git LFS
      - name: Sync DDC (shared derived data cache)
        run: robocopy \\ddc\phoenix Engine\DerivedDataCache /MIR
      - name: BuildCookRun (Android, Shipping)
        run: >
          RunUAT.bat BuildCookRun -project=Phoenix.uproject
          -platform=Android -clientconfig=Shipping -cook -stage -package -pak
          -archive -archivedirectory=D:\out
      - name: Sign & align APK/AAB
        run: apksigner sign --ks %PHOENIX_KEYSTORE% ...    # keystore on the machine, not in the repo
      - uses: actions/upload-artifact@v4
        with: { name: client-android, path: D:\out\**\*.aab }

  ios:
    if: inputs.platform == 'ios' || inputs.platform == 'both'
    runs-on: [ self-hosted, ue5, macos ]
    steps:
      - uses: actions/checkout@v4
        with: { lfs: true }
      - name: BuildCookRun (IOS, Shipping)
        run: >
          RunUAT.sh BuildCookRun -project=Phoenix.uproject
          -platform=IOS -clientconfig=Shipping -cook -stage -package -archive
      - name: Sign & export IPA
        run: xcodebuild -exportArchive -exportOptionsPlist Distribution.plist ...
      - uses: actions/upload-artifact@v4
        with: { name: client-ios, path: build/*.ipa }
```

The output cooked `.pak`/`.ucas`/`.utoc` content is what feeds the **patch builder**
(§4). Store binaries (`.aab`, `.ipa`) go to Google Play / App Store Connect via
`fastlane`; game *content* (maps, cosmetics, tuning) is shipped as **CDN patches** so we
can update without a store review whenever the change is data-only.

> The UE5 **dedicated server** target (`-platform=Linux -server`) is also produced on
> this farm (or a Linux UE5 build agent), then `docker build`-packaged into the
> `game-server` image consumed by Agones (§3.5). Same engine, same cook, different target.

---

## 3. Kubernetes production topology

Managed Kubernetes (EKS/GKE — cloud-agnostic manifests via Kustomize). Two node-pool
classes because game servers and stateless services have very different profiles.

### 3.1 Cluster & node pools

| Node pool | Purpose | Instance shape | Scaling |
| --- | --- | --- | --- |
| `sys` | ingress, Argo CD, observability, coredns | small, on-demand | fixed 3 |
| `services` | NestJS deployments | general compute, on-demand + spot mix | Cluster Autoscaler |
| `gameservers` | Agones GameServer pods | CPU-optimized, **dedicated**, taint `agones.dev/role=gameserver` | Agones FleetAutoscaler + Cluster Autoscaler |

Game-server nodes are **tainted and dedicated** so a match server never shares a node
with noisy stateless workloads (tick-rate stability matters), and `hostPort`/UDP is
first-class there.

### 3.2 Namespaces

| Namespace | Contents |
| --- | --- |
| `phoenix-system` | ingress-nginx, cert-manager, external-secrets, Argo CD, Kyverno |
| `phoenix-svc` | all NestJS Deployments + Services |
| `phoenix-data` | Redis (Enterprise/Sentinel), Kafka (Strimzi), operators; Postgres is managed RDS/CloudSQL, not in-cluster |
| `phoenix-agones` | `agones-system` controller + `Fleet`/`GameServer` pods |
| `phoenix-observability` | Prometheus, Grafana, Loki, Tempo, Alertmanager, OTEL collector |

### 3.3 Deployment / Service / Ingress (representative)

```yaml
# infra/k8s/base/matchmaking/deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata: { name: matchmaking, namespace: phoenix-svc }
spec:
  replicas: 3
  selector: { matchLabels: { app: matchmaking } }
  template:
    metadata:
      labels: { app: matchmaking }
      annotations: { prometheus.io/scrape: "true", prometheus.io/port: "9464" }
    spec:
      containers:
        - name: matchmaking
          image: ghcr.io/phoenix/matchmaking@sha256:PLACEHOLDER  # set by kustomize/GitOps
          ports: [ { containerPort: 8080 }, { containerPort: 9464, name: metrics } ]
          envFrom:
            - configMapRef: { name: matchmaking-config }
            - secretRef:    { name: matchmaking-secrets }   # projected by External Secrets
          resources:
            requests: { cpu: "250m", memory: "256Mi" }
            limits:   { cpu: "1",    memory: "512Mi" }
          readinessProbe: { httpGet: { path: /healthz, port: 8080 }, initialDelaySeconds: 5 }
          livenessProbe:  { httpGet: { path: /livez,   port: 8080 }, periodSeconds: 10 }
          startupProbe:   { httpGet: { path: /healthz, port: 8080 }, failureThreshold: 30, periodSeconds: 2 }
      topologySpreadConstraints:
        - maxSkew: 1
          topologyKey: topology.kubernetes.io/zone
          whenUnsatisfiable: DoNotSchedule
          labelSelector: { matchLabels: { app: matchmaking } }
---
apiVersion: v1
kind: Service
metadata: { name: matchmaking, namespace: phoenix-svc }
spec:
  selector: { app: matchmaking }
  ports: [ { name: http, port: 80, targetPort: 8080 } ]
---
# Only the gateway is exposed publicly; everything else is ClusterIP.
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: gateway
  namespace: phoenix-svc
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-prod
    nginx.ingress.kubernetes.io/proxy-read-timeout: "3600"   # long-lived WS
spec:
  ingressClassName: nginx
  tls: [ { hosts: [ api.playphoenix.gg ], secretName: gateway-tls } ]
  rules:
    - host: api.playphoenix.gg
      http:
        paths:
          - { path: /,   pathType: Prefix, backend: { service: { name: gateway, port: { number: 80 } } } }
```

Internal service-to-service traffic uses **gRPC over ClusterIP** with mTLS from a
service mesh (Linkerd) — only `gateway` is North-South exposed via Ingress.

### 3.4 Autoscaling, config, secrets

**HPA** on services (CPU + custom RPS/queue-depth metrics from Prometheus adapter):

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata: { name: matchmaking, namespace: phoenix-svc }
spec:
  scaleTargetRef: { apiVersion: apps/v1, kind: Deployment, name: matchmaking }
  minReplicas: 3
  maxReplicas: 40
  metrics:
    - type: Resource
      resource: { name: cpu, target: { type: Utilization, averageUtilization: 65 } }
    - type: Pods
      pods:
        metric: { name: mm_queue_depth }
        target: { type: AverageValue, averageValue: "50" }
  behavior:
    scaleUp:   { stabilizationWindowSeconds: 30 }
    scaleDown: { stabilizationWindowSeconds: 300 }   # scale down slowly
```

Plus **PodDisruptionBudgets** (`minAvailable: 2`) so rollouts/node drains never take a
service below quorum.

**Config** — non-secret, per-env values live in Kustomize `ConfigMap` overlays.
**Secrets** — **never** in Git. We run **External Secrets Operator** pulling from AWS
Secrets Manager / Vault:

```yaml
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata: { name: matchmaking-secrets, namespace: phoenix-svc }
spec:
  refreshInterval: 1h
  secretStoreRef: { name: aws-secrets, kind: ClusterSecretStore }
  target: { name: matchmaking-secrets }
  data:
    - { secretKey: DATABASE_URL, remoteRef: { key: prod/matchmaking/db } }
    - { secretKey: JWT_PUBLIC_KEY, remoteRef: { key: prod/jwt/public } }
```

**Admission control** — Kyverno policies enforce: images must be from `ghcr.io/phoenix/*`,
must be **cosign-verified**, must set resource limits, must not run as root.

### 3.5 Dedicated game-server fleet — Agones

Match servers are **stateful, session-scoped UDP** workloads: one pod hosts one match,
lives for one game (~20–30 min), then dies. Plain Deployments/HPA are the wrong model
(no per-session addressing, no graceful "don't kill a pod mid-match"). We use **Agones**.

**Fleet** — a warm pool of `Ready` game servers:

```yaml
# infra/agones/fleet.yaml
apiVersion: agones.dev/v1
kind: Fleet
metadata: { name: br-match, namespace: phoenix-agones }
spec:
  replicas: 50                       # warm ready servers
  scheduling: Packed                 # bin-pack to let empty nodes scale down
  template:
    spec:
      ports:
        - name: game
          containerPort: 7777
          protocol: UDP
          portPolicy: Dynamic        # Agones assigns a host UDP port
      health: { initialDelaySeconds: 30, periodSeconds: 5, failureThreshold: 3 }
      template:
        spec:
          nodeSelector: { pool: gameservers }
          tolerations:
            - { key: agones.dev/role, operator: Equal, value: gameserver, effect: NoSchedule }
          containers:
            - name: game-server
              image: ghcr.io/phoenix/game-server@sha256:PLACEHOLDER
              resources:
                requests: { cpu: "1500m", memory: "2Gi" }
                limits:   { cpu: "2",     memory: "3Gi" }
```

**FleetAutoscaler** — keep a buffer of ready servers ahead of demand:

```yaml
apiVersion: autoscaling.agones.dev/v1
kind: FleetAutoscaler
metadata: { name: br-match, namespace: phoenix-agones }
spec:
  fleetName: br-match
  policy:
    type: Buffer
    buffer: { bufferSize: 25, minReplicas: 20, maxReplicas: 500 }
```

**Match flow (matchmaking ↔ Agones):**

```
1. Players queue          -> matchmaking service forms a lobby (100 players)
2. matchmaking calls Agones Allocator (GameServerAllocation, gRPC)
3. Agones marks one Ready server -> Allocated, returns its <nodeIP:UDPport>
4. matchmaking pushes {ip,port,matchId,token} to each client over gateway WS
5. Clients connect UDP directly to the game-server
6. Server-side SDK: gameserver.MarkReady() at boot, Allocate() on assign,
   Shutdown() when match ends -> pod terminates -> Fleet replaces it
```

The UE5 dedicated server embeds the **Agones C++ SDK**: it calls `Ready()` after level
load, `Health()` on a ticker, reads player count, and calls `Shutdown()` at match end so
Agones reclaims capacity. `GameServerAllocation` supports label selectors so we can route
by **region** and **game mode** (e.g., `mode=squads`, `region=eu-west`).

Node capacity for game servers scales via Cluster Autoscaler triggered by Agones
buffer pressure; `Packed` scheduling + `Allocated`-pod-protected cordoning ensure we
never evict a node running a live match.

---

## 4. Client patch system & CDN

Two independent update channels:

| Channel | What ships | Path | Cadence |
| --- | --- | --- | --- |
| **Binary / store** | Executable code, native libs, engine changes | Google Play / App Store review | slow (days) |
| **Content patch (CDN)** | Cooked `.pak`/`.ucas`/`.utoc` — maps, cosmetics, tuning tables, VFX | Phoenix CDN, no store review | fast (minutes) |

Goal: after installing the store binary once, players get most live content via CDN
patches — the classic "small store app, download-on-first-run + delta updates" model.

### 4.1 Versioning

- **Client protocol version** — an integer compatibility gate. The gateway rejects any
  client whose protocol version is outside the accepted window (forces a store update).
- **Content version** — semver-ish `MAJOR.MINOR.PATCH` per platform per channel
  (`live`, `staging`, `qa`). A *content manifest* pins the exact file set + hashes.

### 4.2 Patch manifest

Each published content version has an immutable, signed manifest:

```json
{
  "contentVersion": "3.14.2",
  "protocolVersion": 42,
  "platform": "android",
  "channel": "live",
  "createdAt": "2026-07-29T00:00:00Z",
  "baseUrl": "https://cdn.playphoenix.gg/content/android/",
  "files": [
    { "path": "pakchunk0-Android.pak",  "size": 734003200, "sha256": "a1b2…", "compression": "oodle" },
    { "path": "pakchunk10-erangel.utoc","size":  52428800, "sha256": "c3d4…" }
  ],
  "deltas": [
    { "from": "3.14.1", "to": "3.14.2",
      "patches": [ { "path": "pakchunk10-erangel.utoc", "sha256": "9f8e…", "size": 5242880 } ] }
  ],
  "signature": "ed25519:…"        // launcher verifies before applying
}
```

### 4.3 Delta patches

We do **not** re-download whole 700 MB paks for a tuning tweak. The patch builder
(`infra/patch/`) runs after each client content cook:

```
new cook + previous cook  ─► for each changed pak chunk:
                              bsdiff/HDiffPatch  ─►  <chunk>.<from>-<to>.hpatch
                          ─► compute sha256, sign manifest, upload
```

- **Chunked paks:** content is cooked into many `pakchunkN` files by category (core,
  per-map, cosmetics, audio) so a change touches few chunks → small deltas.
- **Delta patch** = binary diff between old and new chunk; launcher applies it locally to
  reconstruct the new chunk, then verifies the sha256 against the manifest.
- If a client is more than N versions behind (or delta chain would exceed full-download
  size), the launcher **falls back to full chunk download**.

### 4.4 CDN & asset delivery

```
S3-origin (immutable, versioned)  ──►  CloudFront / multi-CDN edge  ──►  players
    content/<platform>/<version>/...        (Oodle/zstd compressed,
    manifests/<platform>/<channel>.json      range-request friendly,
    patches/<platform>/<from>-<to>/...        long cache TTL on hashed files)
```

- **Immutable content, mutable pointer.** Version directories and hashed files are
  cached "forever" (`Cache-Control: immutable, max-age=31536000`). Only the tiny
  **channel manifest pointer** (`manifests/android/live.json`) is short-TTL and
  invalidated on release — this is the atomic "flip the switch" for a content release.
- **Signed + integrity-checked.** Manifest is ed25519-signed; every file has a sha256;
  the launcher refuses tampered/partial downloads. HTTPS + optional CDN signed URLs for
  premium/pre-release content.
- **Multi-region / multi-CDN** with health-based failover for global reach and cost.

### 4.5 Launcher / first-run flow

```
App launch
  └─ read local installed contentVersion
  └─ GET manifests/<platform>/live.json           (channel pointer, short TTL)
  └─ compare protocolVersion
        ├─ incompatible  ─► hard gate: "Update required" -> store page
        └─ compatible
             └─ compare contentVersion
                  ├─ up to date        ─► enter main menu
                  └─ behind
                       ├─ delta chain exists & small  ─► download+apply deltas
                       └─ else                        ─► download changed full chunks
                       └─ verify sha256 per file
                       └─ atomic swap into content dir  ─► enter main menu
```

Downloads are **resumable** (HTTP range), **background/parallel**, and applied
**atomically** (download to temp, verify, then swap) so a killed app never corrupts the
install. A "staging"/"qa" channel lets QA and internal testers pull unreleased content by
overriding the channel pointer in a debug menu.

### 4.6 Publishing a content patch (`patch-publish.yml`)

```
client content cook (build farm) ─► upload raw cooked paks to S3 content/<ver>/
                                 ─► patch-builder: diff vs previous live -> deltas
                                 ─► generate + ed25519-sign manifest
                                 ─► upload manifest to manifests/.../staging.json
                                 ─► QA validates on `staging` channel
                                 ─► "promote": copy staging.json -> live.json + CF invalidate
                                    (this is the atomic go-live; instant rollback = re-point)
```

---

## 5. Observability

Unified stack; every service is instrumented with **OpenTelemetry** (logs, metrics,
traces) exporting to a cluster **OTEL Collector**, which fans out.

| Signal | Tooling | Notes |
| --- | --- | --- |
| Metrics | Prometheus + Grafana | `/metrics` (Prom exposition) on port 9464 per pod; kube-state-metrics, node-exporter, Agones metrics |
| Logs | Loki (via Promtail/OTEL) + Grafana | Structured JSON logs, `trace_id` in every line for log↔trace correlation |
| Traces | Tempo (OTLP) | Distributed traces across gateway → services → Kafka; game-server match spans |
| Dashboards | Grafana | Golden-signals per service + game-specific boards |
| Alerts | Alertmanager → PagerDuty/Slack | Severity-routed |

### 5.1 What we measure

**Service golden signals** (RED): request rate, error rate, latency p50/p95/p99 per
route; saturation (CPU/mem/GC); Kafka consumer lag; DB pool saturation.

**Game-specific SLIs:**

| Metric | Why |
| --- | --- |
| `matchmaking_time_to_match_seconds` | player experience |
| `mm_queue_depth`, buffer of `Ready` game servers | capacity / autoscale input |
| `gameserver_tick_ms` (server tick budget) | match quality; alert if p95 > tick target |
| `gameserver_allocation_failures_total` | out of capacity → players can't get a match |
| `active_matches`, `ccu` (concurrent users) | live health, capacity planning |
| `patch_download_failures_total`, CDN egress/cache-hit-ratio | patch pipeline health |

### 5.2 Example alert rules

```yaml
# infra/observability/rules/service.yaml
groups:
  - name: phoenix-services
    rules:
      - alert: GatewayHighErrorRate
        expr: sum(rate(http_requests_total{app="gateway",code=~"5.."}[5m]))
              / sum(rate(http_requests_total{app="gateway"}[5m])) > 0.02
        for: 5m
        labels: { severity: page }
        annotations: { summary: "Gateway 5xx > 2% for 5m" }

      - alert: MatchmakingSlow
        expr: histogram_quantile(0.95, sum by (le) (rate(matchmaking_time_to_match_seconds_bucket[5m]))) > 45
        for: 10m
        labels: { severity: page }

      - alert: GameServerCapacityLow
        expr: agones_fleets_replicas_count{type="ready",fleet_name="br-match"} < 10
        for: 2m
        labels: { severity: page }
        annotations: { summary: "Ready game-server buffer critically low" }

      - alert: KafkaConsumerLag
        expr: sum by (consumergroup) (kafka_consumergroup_lag) > 100000
        for: 10m
        labels: { severity: warn }
```

### 5.3 Tracing example

A `POST /match/queue` trace flows: `gateway` → `matchmaking` (gRPC) → Kafka
`match.lobby.formed` → Agones allocation → WS push to clients. `trace_id` is propagated
via W3C `traceparent` on HTTP/gRPC and as a Kafka header, so one trace spans REST, gRPC,
async events, and the allocation call. Every structured log line carries the same
`trace_id` for instant pivot from a Grafana log panel to the Tempo trace.

---

## 6. Environments, release strategy, rollback

### 6.1 Environments

| Env | Cluster / infra | Data | Deploy trigger | Purpose |
| --- | --- | --- | --- | --- |
| **dev** | local `docker compose` (+ optional shared dev EKS) | seeded/synthetic | on demand | build features |
| **staging** | EKS `phoenix-staging`, prod-like, smaller | anonymized snapshot | auto on merge to `main` (Argo CD) | integration, QA, load tests, canary of patches |
| **prod** | EKS `phoenix-prod` (multi-region) | real | gated release PR + approval | live players |

Each env is a **Kustomize overlay** over the same `base/`; differences are replica
counts, resource sizes, HPA bounds, domains, and which Secrets Manager path is used.
Staging and prod are as identical as budget allows.

### 6.2 Release strategy

**Backend services** — GitOps + progressive delivery:

1. Merge to `main` → image built/signed → Argo CD deploys to **staging** automatically.
2. Automated staging gate: smoke tests + synthetic load + key SLOs green for a soak period.
3. **Release PR** to the prod overlay (bumps pinned digests). Requires human approval
   (release manager) — this is the only path to prod.
4. Prod rollout is **progressive** via Argo Rollouts (canary):

```yaml
# canary: 5% -> 25% -> 50% -> 100%, auto-analysis between steps
strategy:
  canary:
    steps:
      - setWeight: 5
      - pause: { duration: 5m }
      - analysis: { templates: [ { templateName: error-rate-latency } ] }
      - setWeight: 25
      - pause: { duration: 10m }
      - setWeight: 50
      - pause: { duration: 10m }
      - setWeight: 100
```

The analysis template auto-aborts (and rolls back) the canary if p95 latency or 5xx rate
regresses beyond thresholds vs. the stable baseline.

**Web (editor/admin)** — deploy new hashed bundle to CDN, flip `index.html` pointer;
instant rollback by re-pointing to the previous bundle prefix.

**Game servers (Agones)** — a Fleet update rolls new `Ready` servers with the new image
while **existing `Allocated` servers finish their matches** (never killed mid-game).
Agones drains old servers as matches end → zero interrupted matches. Rollback = redeploy
the previous Fleet image; in-flight matches on the bad build are allowed to complete or
are force-shut per severity.

**Client content** — promote `staging.json` → `live.json` (§4.6).

### 6.3 Rollback playbook

| Failure | Rollback action | Time |
| --- | --- | --- |
| Bad service deploy | Argo Rollouts auto-abort canary → stable; or `argo rollouts undo` / revert GitOps commit | seconds–1 min |
| Bad config/secret | Revert overlay commit; External Secrets re-syncs | ~1 min |
| Bad DB migration | Migrations are **expand/contract** (backward-compatible); revert app, run down-migration only if safe | minutes |
| Bad content patch | Re-point channel manifest to previous version + CDN invalidate | seconds |
| Bad game-server build | Redeploy previous Fleet image; drain bad servers | 1–2 min (in-flight matches finish) |
| Bad client store binary | Cannot un-ship a store build → mitigate via **server-side kill switch** (LiveOps flag) + forced content patch; hard-gate old protocol only as last resort | varies |

**Migration discipline:** all schema changes are **expand → migrate → contract** across
at least two releases so a rollback of app code never faces an incompatible schema. This
is why service rollback is safe and fast.

### 6.4 Release checklist (per prod release)

- [ ] Staging green: SLOs, smoke, load soak passed
- [ ] DB migrations are expand-phase / backward compatible
- [ ] Feature flags default OFF; gated rollout plan noted
- [ ] Client protocol version window still accepts current live clients
- [ ] Content patch (if any) validated on `staging` channel
- [ ] Runbook + on-call notified; dashboards open
- [ ] Rollback path confirmed (previous digest known-good)

---

## Appendix A — Make targets

| Command | Action |
| --- | --- |
| `make dev` | Full backend up via compose (build + migrate + seed) |
| `make dev-reset` | Tear down (drop volumes) and recreate |
| `make test` | Run all service + web tests locally |
| `make images SERVICE=auth` | Build a service image locally |
| `make agones-local` | Spin a local minikube + Agones + one Fleet for match testing |
| `make patch VERSION=3.14.2` | Run patch builder against last live cook |

## Appendix B — Ports reference

| Port | Where | Use |
| --- | --- | --- |
| 8080 / 8081 | gateway | REST / WebSocket |
| 9464 | every service | Prometheus metrics |
| 7777/udp | game-server | match traffic (Agones dynamic host port in prod) |
| 4317 | OTEL collector | OTLP ingest |
| 5432 / 6379 / 9092 | pg / redis / kafka | datastores (dev exposed; prod internal) |

---

*Cross-refs: `01-architecture.md` (service boundaries), `06-matchmaking.md`
(lobby → allocation contract), `08-security-anticheat.md` (kill switches, signed
manifests, admission policy).*
