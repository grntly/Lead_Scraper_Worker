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

function decodeEntities(value) {
  return String(value || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function titleFromHtml(html) {
  const match = String(html || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? stripTags(match[1]).slice(0, 191) : '';
}

function metaDescriptionFromHtml(html) {
  const match = String(html || '').match(/<meta\s+[^>]*name=["']description["'][^>]*content=["']([^"']+)["'][^>]*>/i)
    || String(html || '').match(/<meta\s+[^>]*content=["']([^"']+)["'][^>]*name=["']description["'][^>]*>/i);
  return match ? decodeEntities(match[1]).replace(/\s+/g, ' ').trim().slice(0, 700) : '';
}

function firstTagText(html, tagName) {
  const safeTag = String(tagName || '').replace(/[^a-z0-9]/gi, '');
  if (!safeTag) {
    return '';
  }

  const regex = new RegExp(`<${safeTag}\\b[^>]*>([\\s\\S]*?)<\\/${safeTag}>`, 'i');
  const match = String(html || '').match(regex);
  return match ? stripTags(match[1]) : '';
}

function selectorConfig(config, path, fallbackSelector = '') {
  let current = config || {};
  for (const part of path) {
    current = current && typeof current === 'object' ? current[part] : null;
  }

  return current && typeof current === 'object'
    ? {
      selector_type: current.selector_type || 'css',
      selector: current.selector || fallbackSelector,
    }
    : { selector_type: 'css', selector: fallbackSelector };
}

function extractBySelector(html, selector, fallback = '') {
  const selectors = String(selector || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

  for (const item of selectors) {
    if (item === 'title') {
      const title = titleFromHtml(html);
      if (title) return title;
    }

    if (item === 'meta[name="description"]') {
      const meta = metaDescriptionFromHtml(html);
      if (meta) return meta;
    }

    if (/^[a-z][a-z0-9-]*$/i.test(item)) {
      const text = firstTagText(html, item);
      if (text) return text;
    }
  }

  return fallback;
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

function patternMatches(pattern, value) {
  const raw = String(pattern || '').trim();
  if (!raw) {
    return false;
  }

  const regexMatch = raw.match(/^#(.+)#([a-z]*)$/i) || raw.match(/^\/(.+)\/([a-z]*)$/i);
  if (regexMatch) {
    try {
      return new RegExp(regexMatch[1], regexMatch[2]).test(value);
    } catch {
      return false;
    }
  }

  return value.toLowerCase().includes(raw.toLowerCase());
}

function filterLinks(links, config, baseHost) {
  const listConfig = config.list || {};
  const includePatterns = Array.isArray(listConfig.include_patterns) ? listConfig.include_patterns : [];
  const excludePatterns = Array.isArray(listConfig.exclude_patterns) ? listConfig.exclude_patterns : [];

  return links
    .filter((link) => /^https?:\/\//i.test(link.url))
    .filter((link) => {
      try {
        return new URL(link.url).hostname.replace(/^www\./, '') === baseHost;
      } catch {
        return false;
      }
    })
    .filter((link) => includePatterns.length === 0 || includePatterns.some((pattern) => patternMatches(pattern, link.url)))
    .filter((link) => !excludePatterns.some((pattern) => patternMatches(pattern, link.url)))
    .filter((link, index, all) => all.findIndex((candidate) => candidate.url === link.url) === index);
}

function extractEmployeeRange(text) {
  const value = String(text || '').toLowerCase();
  const range = value.match(/(\d{1,5})\s*[-–]\s*(\d{1,5})\s*(medewerkers|employees|fte)?/i);
  if (range) {
    return {
      text: range[0],
      min: Number(range[1]),
      max: Number(range[2]),
    };
  }

  const minimum = value.match(/(?:meer dan|over|at least|minimaal)\s*(\d{1,5})\s*(medewerkers|employees|fte)?/i);
  if (minimum) {
    return {
      text: minimum[0],
      min: Number(minimum[1]),
      max: null,
    };
  }

  const single = value.match(/(\d{1,5})\s*(medewerkers|employees|fte)/i);
  if (single) {
    return {
      text: single[0],
      min: Number(single[1]),
      max: Number(single[1]),
    };
  }

  return { text: '', min: null, max: null };
}

function findMatchingTerms(terms, haystack) {
  return (Array.isArray(terms) ? terms : [])
    .map((term) => String(term || '').trim())
    .filter(Boolean)
    .filter((term) => haystack.includes(term.toLowerCase()));
}

function classifyEnrichmentLinks(links) {
  const mapped = [];

  for (const link of links) {
    const haystack = `${link.url} ${link.text}`.toLowerCase();
    let type = '';

    if (haystack.includes('linkedin.com')) type = 'linkedin';
    else if (haystack.includes('contact')) type = 'contact';
    else if (haystack.includes('over-ons') || haystack.includes('about')) type = 'about';
    else if (haystack.includes('vacature') || haystack.includes('werken-bij') || haystack.includes('career')) type = 'jobs';
    else if (haystack.includes('facebook.com') || haystack.includes('instagram.com') || haystack.includes('x.com')) type = 'social';

    if (type) {
      mapped.push({
        link_type: type,
        url: link.url,
        title: link.text || type,
      });
    }
  }

  return mapped.filter((link, index, all) => all.findIndex((candidate) => candidate.url === link.url) === index).slice(0, 20);
}

function scoreLead(lead, criteria) {
  let score = 30;
  const reasons = [];
  const haystack = `${lead.company_name} ${lead.description} ${lead.industry}`.toLowerCase();

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

  const matched = findMatchingTerms(criteria.keywords, haystack);
  if (matched.length > 0) {
    score += Math.min(25, matched.length * 8);
    reasons.push(`keywords: ${matched.join(', ')}`);
  }

  const branches = findMatchingTerms(criteria.branches, haystack);
  if (branches.length > 0) {
    score += Math.min(20, branches.length * 10);
    reasons.push(`branche-match: ${branches.join(', ')}`);
  }

  const excluded = findMatchingTerms(criteria.exclude_keywords, haystack);
  if (excluded.length > 0) {
    score -= 35;
    reasons.push(`uitsluiting: ${excluded.join(', ')}`);
  }

  const minEmployees = Number(criteria.min_employees || 0);
  if (minEmployees > 0 && lead.employee_count_min !== null) {
    if (lead.employee_count_min >= minEmployees || (lead.employee_count_max !== null && lead.employee_count_max >= minEmployees)) {
      score += 15;
      reasons.push(`medewerkers >= ${minEmployees}`);
    } else {
      score -= 15;
      reasons.push(`medewerkers < ${minEmployees}`);
    }
  }

  return {
    score: Math.max(0, Math.min(100, score)),
    reason: reasons.join('; ') || 'basisgegevens gevonden',
  };
}

function emailPatternHint(pattern, website) {
  const raw = String(pattern || '').trim();
  if (!raw || !website) {
    return '';
  }

  try {
    const domain = new URL(website).hostname.replace(/^www\./, '');
    const local = raw.split('@')[0] || 'voornaam.achternaam';
    return `${local}@${domain}`;
  } catch {
    return '';
  }
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

function buildLeadFromPage({ sourceName, url, html, config, criteria }) {
  const text = stripTags(html);
  const emails = extractEmails(text);
  const phones = extractPhones(text);
  const links = extractLinks(html, url);
  const companySelector = selectorConfig(config, ['detail', 'company_name'], 'h1, title');
  const descriptionSelector = selectorConfig(config, ['detail', 'description'], 'meta[name="description"], main, body');
  const company = extractBySelector(html, companySelector.selector, titleFromHtml(html)) || sourceName || new URL(url).hostname.replace(/^www\./, '');
  const description = (extractBySelector(html, descriptionSelector.selector, metaDescriptionFromHtml(html)) || text).slice(0, 700);
  const employeeRange = extractEmployeeRange(text);
  const branches = findMatchingTerms(criteria.branches, `${company} ${description}`.toLowerCase());
  const enrichmentLinks = classifyEnrichmentLinks(links);
  const emailHint = emailPatternHint(criteria.email_pattern_example, url);
  const scored = scoreLead({
    company_name: company,
    website: url,
    email: emails[0] || '',
    phone: phones[0] || '',
    description,
    industry: branches[0] || '',
    employee_count_min: employeeRange.min,
    employee_count_max: employeeRange.max,
  }, criteria);

  return {
    company_name: company,
    website: url,
    email: emails[0] || '',
    phone: phones[0] || '',
    description,
    industry: branches[0] || '',
    employee_count_text: employeeRange.text,
    employee_count_min: employeeRange.min,
    employee_count_max: employeeRange.max,
    criteria_score: scored.score,
    criteria_reason: emailHint ? `${scored.reason}; e-mailpatroon hint: ${emailHint}` : scored.reason,
    enrichment_links: enrichmentLinks,
    source_url: url,
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
  const baseHost = new URL(baseUrl).hostname.replace(/^www\./, '');
  const links = filterLinks(extractLinks(first.body, baseUrl), config, baseHost)
    .slice(0, Math.max(0, maxPages - 1));

  leads.push(buildLeadFromPage({
    sourceName: payload.source_name,
    url: first.url,
    html: first.body,
    config,
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
          config,
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
