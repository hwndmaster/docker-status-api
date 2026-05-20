# docker-status-api
A Vibe-code driven Dashy widget for showing docker containers with their status and update functionality.

## Environment Variables

The API reads the following environment variables from app/server.js.

| Variable | Required | Default | Example | Description |
| --- | --- | --- | --- | --- |
| LOCAL_LABEL | No | nas | nas | Label used for this local server in combined responses and the dashboard widget. |
| REMOTE_SERVERS | No | empty | windows=http://192.168.1.100:3000,<br>pi=http://192.168.1.50:3000 | Comma-separated list of remote servers in label=url format. Used by /all-containers and remote /update proxying. |
| EXCLUDE_IMAGES | No | empty | ghcr.io/immich-app/postgres,redis | Comma-separated image match patterns. If a container image contains one of these values, it is excluded from results. |
| EXCLUDE_NAMES | No | empty | immich_postgres,some_other | Comma-separated exact container names to exclude from results. |
| GHCR_TOKENS | No | empty | ghcr.io/hwndmaster=<br>ghp_xxx,ghcr.io/acme=ghp_yyy | Comma-separated prefix=token pairs used for authenticated GHCR requests and private-image pulls. Longest matching image prefix wins. |
| ENABLE_TIMING_LOGS | No | true (anything except 0) | 1 | Enables timing logs for /containers and per-container resolution. Set to 0 to disable timing logs. |
| REGISTRY_HTTP_TIMEOUT_MS | No | 4000 | 3000 | Per HTTPS request timeout (ms) for registry calls such as GHCR token and tags endpoints. |
| GHCR_LATEST_CHAIN_TIMEOUT_MS | No | 6000 | 5000 | Total timeout (ms) for the full GHCR latest-created lookup chain (token + manifest + optional config blob). |
| GHCR_LATEST_CREATED_TTL_MS | No | 300000 (5 minutes) | 120000 | Cache TTL (ms) for GHCR latest-created timestamps. Set to 0 to disable this cache. |

## Example

Example docker-compose environment block:

```yaml
environment:
  LOCAL_LABEL: nas
  REMOTE_SERVERS: windows=http://192.168.1.100:3000,pi=http://192.168.1.50:3000
  EXCLUDE_IMAGES: ghcr.io/immich-app/postgres
  EXCLUDE_NAMES: immich_postgres
  GHCR_TOKENS: ghcr.io/hwndmaster=ghp_xxx
  ENABLE_TIMING_LOGS: "1"
  REGISTRY_HTTP_TIMEOUT_MS: "4000"
  GHCR_LATEST_CHAIN_TIMEOUT_MS: "6000"
  GHCR_LATEST_CREATED_TTL_MS: "300000"
```
