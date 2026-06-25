# Lead Scraper Worker

Minimal isolated worker template for Lead Scraper.

It accepts jobs from Grantly, fetches public pages with bounded limits, extracts simple lead candidates without AI, and posts results back to the module callback endpoint.

## Environment

- `PORT`: HTTP port, default `8080`
- `WORKER_TOKEN`: optional bearer token required for incoming Grantly dispatch requests

## Endpoint

`POST /jobs/leads`

The payload is the object sent by `LeadRemoteWorkerClient`.

