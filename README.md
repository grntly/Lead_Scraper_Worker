# Lead Scraper Worker

Minimal isolated worker template for Lead Scraper.

It accepts jobs from Grantly, fetches public pages with bounded limits, extracts simple lead candidates without AI, and posts results back to the module callback endpoint.

## Environment

- `PORT`: HTTP port, default `8080`
- `WORKER_TOKEN`: optional bearer token required for incoming Grantly dispatch requests

## Tokens

This worker does not need a GitHub Personal Access Token.

Use a random shared secret for `WORKER_TOKEN`, for example:

```bash
openssl rand -hex 32
```

Then set the same value in Grantly as `lead_scraper_remote_worker_token`.

The Grantly module sends a separate `callback_token` in each job payload. The worker uses that token when posting results back to `lead_scraper/callback`.

## Endpoint

`POST /jobs/leads`

The payload is the object sent by `LeadRemoteWorkerClient`.
