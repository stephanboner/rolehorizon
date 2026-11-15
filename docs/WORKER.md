# Optional Python document worker

The `worker/` folder contains a FastAPI implementation adapted from the personal RoleHorizon application preparation service. It provides source advertisement capture, private profile reading and draft document storage. **It is not required for career-page scanning or the Apps Script app.**

## Prerequisites

- Docker with Compose and sufficient memory for a Playwright Chromium browser.
- A private rclone remote (originally used with iCloud) configured outside Git.
- A remote folder `Bewerbungen/_Profil/` with a readable resume/profile file and optionally a separate style guide text file.
- A long, random `WORKER_TOKEN` that you configure in both the worker and the n8n request header credentials.

## Build and run privately

```bash
# From repository root: image only; does NOT start a public service
docker build -t rolehorizon-worker ./worker
```

One possible private Docker deployment:

```bash
docker network create rolehorizon-private
docker run -d --name rolehorizon-worker --restart unless-stopped \
  --network rolehorizon-private \
  -e WORKER_TOKEN='<RANDOM_LONG_SECRET>' \
  -e ICLOUD_REMOTE='icloud' \
  -e ICLOUD_BEWERBUNGEN_ROOT='Bewerbungen' \
  -e RCLONE_CONFIG='/config/rclone/rclone.conf' \
  -v /absolute/private/path/rclone.conf:/config/rclone/rclone.conf:ro \
  rolehorizon-worker
```

No `-p` mapping is used: the worker should only be reachable from another container on the **same private Docker network**, for example n8n. Connect an existing n8n container to the network only after verifying its purpose and authentication. You may need to adjust Docker networking for your host; never expose port 8080 to the internet.

The optional workflow refers to `http://rolehorizon-worker:8080` by its Docker service/container name. Configure its HTTP request nodes with the credential header `X-Worker-Token` and the same `WORKER_TOKEN` value.

## Endpoint overview

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/health` | Basic process/remote configuration status (avoid public exposure) |
| GET | `/profile` | Read a private CV/profile and optional style files |
| POST | `/job-source` | Retrieve and validate the complete original advertisement |
| POST | `/save` | Generate/save a package of draft files |

The worker supports a specific private-folder and rclone configuration. Other storage systems require modifications and additional tests.

## Security and testing

Test with **synthetic profiles and fictional data** first. Verify authenticated requests return 401 without a valid token. A DNS preflight is not sufficient to prevent all SSRF scenarios, especially DNS rebinding: restrict outbound access to internal/private networks at the container or host level. Keep the rclone configuration (OAuth credentials) and personal document directory outside version control. Explicitly inspect generated drafts before using them in a real application.
