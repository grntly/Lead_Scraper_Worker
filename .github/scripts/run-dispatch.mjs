import { runLeadScrape } from '../../src/lead_scrape.mjs';

function required(name, value) {
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
}

function optional(name, fallback = '') {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

async function postCallback(callbackUrl, callbackToken, payload) {
  const res = await fetch(callbackUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${callbackToken}`,
    },
    body: JSON.stringify(payload),
  });

  const text = await res.text();
  console.log(`Callback ${payload.status}: ${res.status} ${text}`);

  if (!res.ok && res.status !== 409) {
    throw new Error(`Callback failed: ${res.status} ${text}`);
  }

  return { status: res.status, text };
}

async function main() {
  required('RUN_ID', process.env.RUN_ID);
  required('SOURCE_ID', process.env.SOURCE_ID);
  required('LIST_URL', process.env.LIST_URL);
  required('CALLBACK_URL', process.env.CALLBACK_URL);
  required('CALLBACK_TOKEN', process.env.CALLBACK_TOKEN);

  const runId = Number(process.env.RUN_ID);
  const sourceId = Number(process.env.SOURCE_ID);
  const callbackUrl = process.env.CALLBACK_URL;
  const callbackToken = process.env.CALLBACK_TOKEN;

  await postCallback(callbackUrl, callbackToken, {
    run_id: runId,
    source_id: sourceId,
    status: 'running',
    message: 'GitHub Actions Lead Scraper worker gestart.',
    stats: {
      pages_fetched: 0,
      items_found: 0,
      errors_count: 0,
    },
  });

  const result = await runLeadScrape({
      run_id: runId,
      source_id: sourceId,
      source_name: optional('SOURCE_NAME'),
      list_url: process.env.LIST_URL,
      base_url: optional('BASE_URL'),
      config_json: optional('CONFIG_JSON', '{}'),
      criteria_json: optional('CRITERIA_JSON', '{}'),
      max_pages: optional('MAX_PAGES', '5'),
      timeout_seconds: optional('TIMEOUT_SECONDS', '30'),
    },
    async (progress) => {
      try {
        const callbackResult = await postCallback(callbackUrl, callbackToken, {
          run_id: runId,
          source_id: sourceId,
          status: 'running',
          message: progress.message,
          stats: progress.stats,
        });

        if (callbackResult.status === 409) {
          throw new Error('Run cancelled from Grantly.');
        }
      } catch (error) {
        if (error && error.message === 'Run cancelled from Grantly.') {
          throw error;
        }
        console.warn('Progress callback failed:', error);
      }
    });

  await postCallback(callbackUrl, callbackToken, {
    run_id: runId,
    source_id: sourceId,
    status: result.success ? 'success' : 'failed',
    message: result.message,
    stats: result.stats,
    leads: result.leads,
    run_items: result.run_items || [],
  });

  if (!result.success) {
    console.warn(`Lead scrape completed with source-level failure: ${result.message}`);
  }
}

main().catch(async (error) => {
  console.error('Lead Scraper worker failed:', error);

  if (error && error.message === 'Run cancelled from Grantly.') {
    process.exit(0);
  }

  if (process.env.CALLBACK_URL && process.env.CALLBACK_TOKEN) {
    await postCallback(process.env.CALLBACK_URL, process.env.CALLBACK_TOKEN, {
      run_id: Number(process.env.RUN_ID || 0),
      source_id: Number(process.env.SOURCE_ID || 0),
      status: 'failed',
      message: error.message || String(error),
      stats: {
        pages_fetched: 0,
        items_found: 0,
        errors_count: 1,
      },
      leads: [],
    }).catch((callbackError) => {
      console.error('Error callback failed:', callbackError);
    });
  }

  process.exit(1);
});
