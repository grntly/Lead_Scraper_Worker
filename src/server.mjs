import http from 'node:http';
import crypto from 'node:crypto';

const port = Number(process.env.PORT || 8080);
const workerToken = process.env.WORKER_TOKEN || '';

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload)
  });
  res.end(payload);
}

function bearerToken(req) {
  const header = req.headers.authorization || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
    if (Buffer.concat(chunks).length > 5 * 1024 * 1024) {
      throw new Error('Payload too large.');
    }
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
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
  return html
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
  const match = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return match ? match[0].slice(0, 191) : '';
}

function waterfallEmails(domain, names = []) {
  const safeDomain = String(domain || '').replace(/^www\./, '');
  const guesses = ['info', 'contact', 'sales', 'hello'].map((prefix) => `${prefix}@${safeDomain}`);
  for (const name of names) {
    const parts = String(name).toLowerCase().match(/[a-z]+/g);
    if (parts && parts.length >= 2) {
      guesses.push(`${parts[0]}.${parts[parts.length - 1]}@${safeDomain}`);
    }
  }
  return [...new Set(guesses)].slice(0, 8);
}

async function fetchText(url, userAgent, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': userAgent },
      signal: controller.signal,
      redirect: 'follow'
    });
    const text = await response.text();
    return { status: response.status, text: text.slice(0, 1_000_000) };
  } finally {
    clearTimeout(timeout);
  }
}

async function postCallback(callbackUrl, callbackToken, body) {
  const response = await fetch(callbackUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${callbackToken}`
    },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    throw new Error(`Callback failed with HTTP ${response.status}: ${await response.text()}`);
  }
}

async function runLeadJob(payload) {
  const source = payload.source || {};
  const parameters = payload.parameters || {};
  const listUrl = source.list_url || '';
  const maxLinks = Math.min(Number(parameters.max_links || 300), 1000);
  const timeoutMs = Math.min(Number(parameters.timeout_ms || 30000), 120000);
  const userAgent = payload.user_agent || 'Mozilla/5.0 (compatible; Grantly Lead Scraper/1.0)';

  if (!isAllowedUrl(listUrl)) {
    throw new Error('List URL is not allowed.');
  }

  const listResponse = await fetchText(listUrl, userAgent, timeoutMs);
  const links = extractLinks(listResponse.text, listUrl, maxLinks);
  const candidates = links
    .filter((link) => link.text.length > 1)
    .slice(0, Math.min(maxLinks, 100));

  const items = [];
  const leads = [];

  for (const candidate of candidates) {
    let detail = '';
    let httpCode = 0;
    try {
      const response = await fetchText(candidate.url, userAgent, timeoutMs);
      detail = response.text;
      httpCode = response.status;
    } catch (error) {
      items.push({
        detail_url: candidate.url,
        raw_title: candidate.text,
        status: 'error',
        error_message: error.message
      });
      continue;
    }

    const title = titleFromHtml(detail) || candidate.text;
    const text = stripHtml(detail);
    const email = extractEmail(text);
    const host = new URL(candidate.url).hostname;

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
      email,
      score_reason: 'Score based on configured non-AI criteria.',
      suggested_next_action: 'Handmatig reviewen en daarna eventueel converteren.',
      keywords: [parameters.branch, source.source_type].filter(Boolean).join(', '),
      raw_email_guesses: waterfallEmails(host)
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

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    return json(res, 200, { success: true });
  }

  if (req.method !== 'POST' || req.url !== '/jobs/leads') {
    return json(res, 404, { success: false, message: 'Not found.' });
  }

  if (workerToken && bearerToken(req) !== workerToken) {
    return json(res, 401, { success: false, message: 'Unauthorized worker request.' });
  }

  let payload;
  try {
    payload = await readJson(req);
  } catch (error) {
    return json(res, 400, { success: false, message: error.message });
  }

  if (!payload.run_id || !payload.callback_url || !payload.callback_token || !payload.source?.list_url) {
    return json(res, 400, { success: false, message: 'Missing required fields.' });
  }

  const remoteJobId = crypto.randomUUID();
  json(res, 202, { success: true, accepted: true, remote_job_id: remoteJobId });

  try {
    await postCallback(payload.callback_url, payload.callback_token, {
      run_id: payload.run_id,
      status: 'running',
      message: 'Worker started.'
    });

    const result = await runLeadJob(payload);

    await postCallback(payload.callback_url, payload.callback_token, {
      run_id: payload.run_id,
      status: 'success',
      message: `Imported ${result.leads.length} lead candidate(s).`,
      ...result
    });
  } catch (error) {
    try {
      await postCallback(payload.callback_url, payload.callback_token, {
        run_id: payload.run_id,
        status: 'error',
        message: error.message || 'Unknown worker error.'
      });
    } catch (callbackError) {
      console.error('Callback failed:', callbackError);
    }
    console.error('Job failed:', error);
  }
});

server.listen(port, () => {
  console.log(`lead-scraper-worker listening on ${port}`);
});

