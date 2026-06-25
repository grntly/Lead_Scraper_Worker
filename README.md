# Lead Scraper Worker

Minimal isolated worker template for Lead Scraper.

It supports two dispatch styles:

- GitHub Actions workflow dispatch, using `.github/workflows/lead-scraper.yml`
- Always-on HTTP worker, using `src/server.mjs`

Both fetch public pages with bounded limits, extract simple lead candidates without AI, and post results back to the module callback endpoint.

## Environment

- `PORT`: HTTP port, default `8080`
- `WORKER_TOKEN`: optional bearer token required for incoming Grantly dispatch requests

## Tokens

The GitHub Actions mode needs a GitHub Personal Access Token in Grantly, stored as `lead_scraper_github_pat`.

The always-on HTTP mode does not need a GitHub PAT. Use a random shared secret for `WORKER_TOKEN`, for example:

```bash
openssl rand -hex 32
```

Then set the same value in Grantly as `lead_scraper_remote_worker_token`.

The Grantly module sends a separate `callback_token` in each job payload. The worker uses that token when posting results back to `lead_scraper/callback`.

## Endpoint

`POST /jobs/leads`

The payload is the object sent by `LeadRemoteWorkerClient`.
