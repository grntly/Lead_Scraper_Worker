const runId = Number(process.env.RUN_ID || '0');
const callbackUrl = process.env.CALLBACK_URL || '';
const callbackToken = process.env.CALLBACK_TOKEN || '';
const userAgent = process.env.USER_AGENT || 'Mozilla/5.0 (compatible; Grantly Lead Scraper/1.0)';

function required(name, value) {
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
}

function parseJson(name, value) {
  try {
    return JSON.parse(value || '{}');
  } catch (error) {
    throw new Error(`Invalid ${name}: ${error.message}`);
  }
}

function isAllowedUrl(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return false;
    if (['localhost', '127.0.0.1', '0.0.0.0', '::1'].includes(url.hostname)) return false;
    if (/^(10|127|169\.254|172\.(1[6-9]|2\d|3[01])|192\.168)\./.test(url.hostname)) return false;
    return true;
  } catch {
    return false;
  }
}

function absoluteUrl(href, base) {
  try {
    const url = new URL(href, base);
    return isAllowedUrl(url.href) ? url.href : '';
  } catch {
    return '';
  }
}

function stripHtml(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function titleFromHtml(html) {
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const title = h1 || html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return title ? stripHtml(title[1]).slice(0, 191) : '';
}

function extractLinks(html, baseUrl, maxLinks) {
  const links = [];
  const seen = new Set();
  const re = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;

  while ((match = re.exec(html)) && links.length < maxLinks) {
    const url = absoluteUrl(match[1], baseUrl);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    links.push({ url, text: stripHtml(match[2]).slice(0, 191) });
  }

  return links;
}

function extractEmail(text) {
  const match = String(text || '').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return match ? match[0].slice(0, 191) : '';
}

async function fetchText(url, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': userAgent },
      signal: controller.signal,
      redirect: 'follow'
    });
    return { status: response.status, text: (await response.text()).slice(0, 1_000_000) };
  } finally {
    clearTimeout(timeout);
  }
}

async function postCallback(payload) {
  const response = await fetch(callbackUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${callbackToken}`
    },
    body: JSON.stringify(payload)
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Callback failed: ${response.status} ${text}`);
  }
}

async function runLeadJob(source, parameters) {
  const listUrl = source.list_url || '';
  const maxLinks = Math.min(Number(parameters.max_links || 300), 1000);
  const timeoutMs = Math.min(Number(parameters.timeout_ms || 30000), 120000);

  if (!isAllowedUrl(listUrl)) {
    throw new Error('List URL is not allowed.');
  }

  const listResponse = await fetchText(listUrl, timeoutMs);
  const links = extractLinks(listResponse.text, listUrl, maxLinks);
  const candidates = links.filter((link) => link.text.length > 1).slice(0, Math.min(maxLinks, 100));
  const items = [];
  const leads = [];

  for (const candidate of candidates) {
    let detail = '';
    let httpCode = 0;

    try {
      const response = await fetchText(candidate.url, timeoutMs);
      detail = response.text;
      httpCode = response.status;
    } catch (error) {
      items.push({ detail_url: candidate.url, raw_title: candidate.text, status: 'error', error_message: error.message });
      continue;
    }

    const title = titleFromHtml(detail) || candidate.text;
    const text = stripHtml(detail);

    items.push({
      list_page_url: listUrl,
      detail_url: candidate.url,
      raw_title: title,
      status: 'processed',
      http_code: httpCode
    });

    leads.push({
      company_name: title,
      website: candidate.url,
      branch: parameters.branch || source.branch || '',
      country: source.country || 'Netherlands',
      description: text.slice(0, 1000),
      email: extractEmail(text),
      score_reason: 'Score based on configured non-AI criteria.',
      suggested_next_action: 'Handmatig reviewen en daarna eventueel converteren.',
      keywords: [parameters.branch, source.source_type].filter(Boolean).join(', ')
    });
  }

  return {
    items,
    leads,
    stats: {
      pages_fetched: 1 + candidates.length,
      links_found: links.length,
      detail_pages_processed: items.length,
      errors_count: items.filter((item) => item.status === 'error').length
    }
  };
}

async function main() {
  required('RUN_ID', runId);
  required('CALLBACK_URL', callbackUrl);
  required('CALLBACK_TOKEN', callbackToken);

  const source = parseJson('SOURCE_JSON', process.env.SOURCE_JSON);
  const parameters = parseJson('PARAMETERS_JSON', process.env.PARAMETERS_JSON);

  await postCallback({ run_id: runId, status: 'running', message: 'GitHub Actions lead scraper gestart.' });
  const result = await runLeadJob(source, parameters);
  await postCallback({
    run_id: runId,
    status: 'success',
    message: `Imported ${result.leads.length} lead candidate(s).`,
    ...result
  });
}

main().catch(async (error) => {
  console.error(error);
  try {
    await postCallback({
      run_id: runId || 0,
      status: 'error',
      message: error.message || 'Unknown GitHub Actions worker error.'
    });
  } catch (callbackError) {
    console.error(callbackError);
  }
  process.exit(1);
});
