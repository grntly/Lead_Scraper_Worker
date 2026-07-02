import dns from 'node:dns/promises';
import net from 'node:net';

const PRIVATE_HOSTS = new Set(['localhost', 'metadata.google.internal', '169.254.169.254']);

function parseJson(value, fallback = {}) {
  try {
    const parsed = JSON.parse(value || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function clampNumber(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.max(min, Math.min(max, parsed));
}

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const parts = ip.split('.').map(Number);
    return parts[0] === 10
      || parts[0] === 127
      || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
      || (parts[0] === 192 && parts[1] === 168)
      || (parts[0] === 169 && parts[1] === 254)
      || parts[0] === 0;
  }

  if (net.isIPv6(ip)) {
    const normalized = ip.toLowerCase();
    return normalized === '::1'
      || normalized.startsWith('fc')
      || normalized.startsWith('fd')
      || normalized.startsWith('fe80:');
  }

  return true;
}

async function assertPublicUrl(rawUrl) {
  const url = new URL(rawUrl);
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Only public HTTP(S) URLs are allowed.');
  }

  const host = url.hostname.toLowerCase();
  if (PRIVATE_HOSTS.has(host) || host.endsWith('.local')) {
    throw new Error('Private or local hosts are not allowed.');
  }

  if (net.isIP(host)) {
    if (isPrivateIp(host)) {
      throw new Error('Private IP targets are not allowed.');
    }
    return url;
  }

  const records = await dns.lookup(host, { all: true });
  for (const record of records) {
    if (isPrivateIp(record.address)) {
      throw new Error('Source hostname resolves to a private IP.');
    }
  }

  return url;
}

function stripTags(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function titleFromHtml(html) {
  const match = String(html || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? stripTags(match[1]).slice(0, 191) : '';
}

function extractEmails(text) {
  const matches = String(text || '').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [];
  return [...new Set(matches.map((email) => email.toLowerCase()))];
}

function extractPhones(text) {
  const matches = String(text || '').match(/(?:\+31|0031|0)[\d\s().-]{8,}/g) || [];
  return [...new Set(matches.map((phone) => phone.replace(/\s+/g, ' ').trim()))];
}

function extractLinks(html, baseUrl) {
  const links = [];
  const regex = /<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;

  while ((match = regex.exec(String(html || ''))) !== null) {
    try {
      const url = new URL(match[1], baseUrl).toString();
      links.push({
        url,
        text: stripTags(match[2]).slice(0, 191),
      });
    } catch {
      // Ignore malformed links.
    }
  }

  return links;
}

function scoreLead(lead, criteria) {
  let score = 30;
  const reasons = [];

  if (lead.website) {
    score += 20;
    reasons.push('website gevonden');
  }
  if (lead.email) {
    score += 15;
    reasons.push('e-mailadres gevonden');
  }
  if (lead.phone) {
    score += 10;
    reasons.push('telefoonnummer gevonden');
  }

  const keywords = Array.isArray(criteria.keywords) ? criteria.keywords : [];
  const haystack = `${lead.company_name} ${lead.description}`.toLowerCase();
  const matched = keywords.filter((keyword) => haystack.includes(String(keyword).toLowerCase()));
  if (matched.length > 0) {
    score += Math.min(25, matched.length * 8);
    reasons.push(`criteria keywords: ${matched.join(', ')}`);
  }

  return {
    score: Math.max(0, Math.min(100, score)),
    reason: reasons.join('; ') || 'basisgegevens gevonden',
  };
}

async function fetchHtml(url, timeoutSeconds) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutSeconds * 1000);

  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': 'Grantly Lead Scraper GitHub Worker/0.1',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });

    const text = await res.text();
    return {
      ok: res.ok,
      status: res.status,
      url: res.url,
      body: text,
    };
  } finally {
    clearTimeout(timer);
  }
}

function buildLeadFromPage({ sourceName, url, html, criteria }) {
  const text = stripTags(html);
  const emails = extractEmails(text);
  const phones = extractPhones(text);
  const company = titleFromHtml(html) || sourceName || new URL(url).hostname.replace(/^www\./, '');
  const description = text.slice(0, 700);
  const scored = scoreLead({
    company_name: company,
    website: url,
    email: emails[0] || '',
    phone: phones[0] || '',
    description,
  }, criteria);

  return {
    company_name: company,
    website: url,
    email: emails[0] || '',
    phone: phones[0] || '',
    description,
    criteria_score: scored.score,
    criteria_reason: scored.reason,
    status: 'new',
  };
}

export async function runLeadScrape(payload) {
  const config = parseJson(payload.config_json);
  const criteria = parseJson(payload.criteria_json);
  const maxPages = clampNumber(payload.max_pages, 5, 1, 20);
  const timeoutSeconds = clampNumber(payload.timeout_seconds, 30, 5, 120);
  const startUrl = await assertPublicUrl(payload.list_url);
  const fetched = [];
  const leads = [];
  const errors = [];

  const first = await fetchHtml(startUrl.toString(), timeoutSeconds);
  fetched.push(first.url);
  if (!first.ok) {
    return {
      success: false,
      message: `Lijstpagina gaf HTTP ${first.status}.`,
      stats: {
        pages_fetched: 1,
        items_found: 0,
        errors_count: 1,
      },
      leads: [],
    };
  }

  const baseUrl = payload.base_url || startUrl.toString();
  const links = extractLinks(first.body, baseUrl)
    .filter((link) => /^https?:\/\//i.test(link.url))
    .filter((link, index, all) => all.findIndex((candidate) => candidate.url === link.url) === index)
    .slice(0, Math.max(0, maxPages - 1));

  leads.push(buildLeadFromPage({
    sourceName: payload.source_name,
    url: first.url,
    html: first.body,
    criteria,
  }));

  for (const link of links) {
    try {
      await assertPublicUrl(link.url);
      const page = await fetchHtml(link.url, timeoutSeconds);
      fetched.push(page.url);
      if (page.ok) {
        leads.push(buildLeadFromPage({
          sourceName: link.text || payload.source_name,
          url: page.url,
          html: page.body,
          criteria,
        }));
      } else {
        errors.push(`HTTP ${page.status}: ${link.url}`);
      }
    } catch (error) {
      errors.push(error.message || String(error));
    }
  }

  const uniqueLeads = leads.filter((lead, index, all) => {
    const key = `${lead.company_name}|${lead.website}`.toLowerCase();
    return all.findIndex((candidate) => `${candidate.company_name}|${candidate.website}`.toLowerCase() === key) === index;
  });

  return {
    success: true,
    message: `Lead Scraper worker afgerond: ${uniqueLeads.length} kandidaat-leads gevonden.`,
    stats: {
      pages_fetched: fetched.length,
      items_found: uniqueLeads.length,
      errors_count: errors.length,
    },
    leads: uniqueLeads,
    config_used: config,
  };
}
