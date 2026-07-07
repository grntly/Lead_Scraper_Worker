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

function normalizeSourceType(value) {
  const type = String(value || '').toLowerCase().replace(/[^a-z0-9_/-]+/g, '_');
  if (['ranking', 'directory', 'industry_page', 'list', 'listing'].includes(type)) {
    return type;
  }

  return type || 'website';
}

function sourceTypeIsListing(sourceType) {
  return ['ranking', 'directory', 'industry_page', 'list', 'listing'].includes(normalizeSourceType(sourceType));
}

function sourceTypeIsSingleWebsite(sourceType) {
  return ['website', 'company_website', 'company'].includes(normalizeSourceType(sourceType));
}

function extractCells(rowHtml) {
  const cells = [];
  const regex = /<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi;
  let match;

  while ((match = regex.exec(String(rowHtml || ''))) !== null) {
    const cellHtml = match[1];
    const linkMatch = cellHtml.match(/<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
    cells.push({
      text: stripTags(cellHtml),
      link: linkMatch ? linkMatch[1] : '',
      linkText: linkMatch ? stripTags(linkMatch[2]) : '',
    });
  }

  return cells;
}

function extractTableRows(html, baseUrl) {
  const rows = [];
  const regex = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let match;

  while ((match = regex.exec(String(html || ''))) !== null) {
    const cells = extractCells(match[1]);
    if (cells.length < 2) {
      continue;
    }

    const companyCell = cells.find((cell) => {
      const text = cell.text.trim();
      return text !== ''
        && !/^(bedrijfsnaam|company|organisatie|naam|2022|2023|score|rank|positie)$/i.test(text)
        && !/^\d+$/.test(text)
        && !/^\d+([.,]\d+)?%$/.test(text);
    });

    if (!companyCell) {
      continue;
    }

    const rankCell = cells.find((cell) => /^\d+$/.test(cell.text.trim()));
    const scoreCell = cells.find((cell) => /^\d+([.,]\d+)?%$/.test(cell.text.trim()));
    let sourceUrl = baseUrl;

    if (companyCell.link) {
      try {
        sourceUrl = new URL(companyCell.link, baseUrl).toString();
      } catch {
        sourceUrl = baseUrl;
      }
    }

    rows.push({
      company_name: companyCell.linkText || companyCell.text,
      source_url: sourceUrl,
      rank: rankCell ? Number(rankCell.text.trim()) : null,
      table_score_text: scoreCell ? scoreCell.text.trim() : '',
      raw_cells: cells.map((cell) => cell.text),
    });
  }

  return rows.filter((row, index, all) => {
    const key = row.company_name.toLowerCase();
    return key !== '' && all.findIndex((candidate) => candidate.company_name.toLowerCase() === key) === index;
  });
}

function cleanCompanyCandidateText(text) {
  return stripTags(text)
    .replace(/^\s*(?:#?\d{1,4}|[A-Z])\s*[\).:-]\s*/i, '')
    .replace(/\b(?:bekijk|lees meer|read more|website|contact|profiel|details|meer info)\b.*$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 191);
}

function looksLikeCompanyName(text) {
  const value = String(text || '').trim();
  if (value.length < 2 || value.length > 90) {
    return false;
  }

  if (/@|https?:|www\.|\d{2}[-/]\d{2}[-/]\d{2,4}|\b(home|menu|login|privacy|cookies|contact|nieuws|blog|vacatures|over ons|about|read more|lees meer|download|pdf)\b/i.test(value)) {
    return false;
  }

  if (/^\d+$|^\d+([.,]\d+)?%$/.test(value)) {
    return false;
  }

  const words = value.split(/\s+/).filter(Boolean);
  return words.length <= 7 && /[a-zA-ZÀ-ÖØ-öø-ÿ]/.test(value);
}

function pushListCandidate(candidates, candidate, baseUrl) {
  const companyName = cleanCompanyCandidateText(candidate.company_name || candidate.text || '');
  if (!looksLikeCompanyName(companyName)) {
    return;
  }

  let sourceUrl = candidate.source_url || baseUrl;
  if (sourceUrl) {
    try {
      sourceUrl = new URL(sourceUrl, baseUrl).toString();
    } catch {
      sourceUrl = baseUrl;
    }
  }

  candidates.push({
    company_name: companyName,
    source_url: sourceUrl || baseUrl,
    rank: candidate.rank || null,
    raw_text: candidate.raw_text || companyName,
  });
}

function extractListCompanyCandidates(html, baseUrl) {
  const candidates = [];
  const blocks = [
    /<li\b[^>]*>([\s\S]*?)<\/li>/gi,
    /<h[2-4]\b[^>]*>([\s\S]*?)<\/h[2-4]>/gi,
    /<article\b[^>]*>([\s\S]*?)<\/article>/gi,
  ];

  for (const regex of blocks) {
    let match;
    while ((match = regex.exec(String(html || ''))) !== null) {
      const blockHtml = match[1];
      const linkMatch = blockHtml.match(/<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
      const text = linkMatch ? stripTags(linkMatch[2]) : stripTags(blockHtml);
      const rankMatch = stripTags(blockHtml).match(/^\s*(\d{1,4})[\).:-]?\s+/);
      pushListCandidate(candidates, {
        company_name: text,
        source_url: linkMatch ? linkMatch[1] : baseUrl,
        rank: rankMatch ? Number(rankMatch[1]) : null,
        raw_text: stripTags(blockHtml),
      }, baseUrl);
    }
  }

  for (const link of extractLinks(html, baseUrl)) {
    pushListCandidate(candidates, {
      company_name: link.text,
      source_url: link.url,
      raw_text: link.text,
    }, baseUrl);
  }

  return candidates.filter((row, index, all) => {
    const key = row.company_name.toLowerCase();
    return key !== '' && all.findIndex((candidate) => candidate.company_name.toLowerCase() === key) === index;
  });
}

function pageLooksLikeListing(html, sourceType) {
  if (sourceTypeIsListing(sourceType)) {
    return true;
  }

  const text = `${titleFromHtml(html)} ${firstTagText(html, 'h1')} ${stripTags(html).slice(0, 4000)}`.toLowerCase();
  if (/\b(top\s*\d+|ranking|ranglijst|bedrijvenlijst|gids|directory|ledenlijst|deelnemers|winnaars|gazellen|award|awards)\b/.test(text)) {
    return true;
  }

  return extractListCompanyCandidates(html, 'https://example.com/').length >= 12;
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

function isSkippableResearchUrl(url) {
  return /\.(pdf|zip|rar|7z|jpg|jpeg|png|gif|webp|svg|mp4|mp3|avi|mov)(\?|#|$)/i.test(String(url || ''));
}

function isSocialOrDirectoryHost(host) {
  return /(^|\.)((linkedin|facebook|instagram|twitter|x|youtube|tiktok)\.com|google\.[a-z.]+|bing\.com|kvk\.nl)$/i.test(host);
}

function hostWithoutWww(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

function urlsPointToSamePage(first, second) {
  try {
    const firstUrl = new URL(first);
    const secondUrl = new URL(second);
    firstUrl.hash = '';
    secondUrl.hash = '';
    return firstUrl.toString().replace(/\/$/, '') === secondUrl.toString().replace(/\/$/, '');
  } catch {
    return false;
  }
}

function discoverCompanyWebsite(links, sourceHost) {
  const candidates = [];

  for (const link of links) {
    if (!/^https?:\/\//i.test(link.url) || isSkippableResearchUrl(link.url)) {
      continue;
    }

    const host = hostWithoutWww(link.url);
    if (!host || host === sourceHost || isSocialOrDirectoryHost(host)) {
      continue;
    }

    const haystack = `${link.text} ${link.url}`.toLowerCase();
    let score = 10;
    if (/website|site|homepage|bezoek|visit|www\./i.test(haystack)) score += 30;
    if (/contact|over-ons|about|team|directie|management/i.test(haystack)) score += 10;

    candidates.push({ url: link.url, score });
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates.length ? candidates[0].url : '';
}

function companyDomainCandidates(companyName) {
  const normalized = String(companyName || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' en ')
    .replace(/\b(bv|b\.v|nv|n\.v|holding|groep|group|agency|solutions|technologies|technology|software|consulting|consultants|services)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  const parts = normalized.split(/\s+/).filter(Boolean);
  if (!parts.length) {
    return [];
  }

  const compact = parts.join('');
  const dashed = parts.join('-');
  const names = [...new Set([compact, dashed, parts[0]])].filter((name) => name.length >= 3);
  const tlds = ['nl', 'com', 'eu', 'io'];
  const urls = [];

  for (const name of names) {
    for (const tld of tlds) {
      urls.push(`https://${name}.${tld}/`);
    }
  }

  return urls.slice(0, 12);
}

function pageMatchesCompany(page, companyName) {
  const tokens = String(companyName || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length >= 4);
  if (!tokens.length) {
    return false;
  }

  const haystack = `${page.url} ${titleFromHtml(page.body)} ${metaDescriptionFromHtml(page.body)} ${stripTags(page.body).slice(0, 2000)}`.toLowerCase();
  return tokens.some((token) => haystack.includes(token));
}

function researchLinkScore(link) {
  const haystack = `${link.text} ${link.url}`.toLowerCase();
  let score = 0;

  if (/contact|contacteer|kontakt/.test(haystack)) score += 40;
  if (/over-ons|over_ons|about|wie-zijn-wij|wie_zijn_wij|organisatie|company|bedrijf|ons-verhaal|our-story/.test(haystack)) score += 35;
  if (/team|mensen|people|medewerkers|directie|management|bestuur|leadership|founder|ceo|cfo|cto|eigenaar|oprichter|partners|adviesraad/.test(haystack)) score += 55;
  if (/vacature|werken-bij|werkenbij|career|careers|jobs/.test(haystack)) score += 18;
  if (/diensten|services|solutions|oplossingen|expertise|cases|portfolio|projecten/.test(haystack)) score += 12;
  if (/privacy|voorwaarden|terms|cookie|login|account|cart|winkelwagen/.test(haystack)) score -= 50;

  return score;
}

function candidateResearchLinks(links, websiteUrl, limit = 5) {
  const websiteHost = hostWithoutWww(websiteUrl);
  const candidates = [];

  for (const link of links) {
    if (!/^https?:\/\//i.test(link.url) || isSkippableResearchUrl(link.url)) {
      continue;
    }

    if (hostWithoutWww(link.url) !== websiteHost) {
      continue;
    }

    const score = researchLinkScore(link);
    if (score <= 0) {
      continue;
    }

    candidates.push({ url: link.url, text: link.text, score });
  }

  return candidates
    .filter((link, index, all) => all.findIndex((candidate) => candidate.url === link.url) === index)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

function normalizedCrawlUrl(url) {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    if ((parsed.pathname === '/' || parsed.pathname === '') && parsed.search === '') {
      return parsed.origin + '/';
    }
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return '';
  }
}

function websiteCrawlCandidates(links, websiteUrl, seenUrls = new Set(), limit = 80) {
  const websiteHost = hostWithoutWww(websiteUrl);
  const candidates = [];

  for (const link of links) {
    if (!/^https?:\/\//i.test(link.url) || isSkippableResearchUrl(link.url)) {
      continue;
    }

    if (hostWithoutWww(link.url) !== websiteHost) {
      continue;
    }

    const normalized = normalizedCrawlUrl(link.url);
    if (!normalized || seenUrls.has(normalized)) {
      continue;
    }

    const haystack = `${link.text} ${link.url}`.toLowerCase();
    if (/privacy|voorwaarden|terms|cookie|login|account|cart|winkelwagen|checkout|wp-json|feed|sitemap|tag\/|category\//.test(haystack)) {
      continue;
    }

    const score = researchLinkScore(link);
    candidates.push({
      url: normalized,
      text: link.text,
      score: score > 0 ? score : 1,
    });
  }

  return candidates
    .filter((link, index, all) => all.findIndex((candidate) => candidate.url === link.url) === index)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

function emailGuessesForName(name, domain, pattern = '') {
  const parts = String(name || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z\s-]/g, ' ')
    .split(/[\s-]+/)
    .filter(Boolean);

  if (parts.length < 2 || !domain) {
    return [];
  }

  const first = parts[0];
  const last = parts[parts.length - 1];
  const localPattern = String(pattern || '').split('@')[0].toLowerCase();
  const guesses = [];

  if (localPattern.includes('voornaam') || localPattern.includes('firstname') || localPattern.includes('first')) {
    guesses.push(`${first}.${last}@${domain}`);
  }

  guesses.push(`${first}.${last}@${domain}`);
  guesses.push(`${first}@${domain}`);
  guesses.push(`${first[0]}${last}@${domain}`);

  return [...new Set(guesses)];
}

function extractManagementContacts(text, domain, emailPattern = '') {
  const roles = [
    'ceo', 'cfo', 'cto', 'coo', 'chief executive officer', 'chief financial officer', 'chief technology officer',
    'directeur', 'algemeen directeur', 'commercieel directeur', 'financieel directeur', 'technisch directeur',
    'founder', 'co-founder', 'oprichter', 'mede-oprichter', 'eigenaar', 'owner', 'partner',
    'managing director', 'directie', 'bestuurder'
  ];
  const rolePattern = roles.map((role) => role.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const lines = String(text || '')
    .split(/[.\n\r;|]+/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line.length >= 8 && line.length <= 220);
  const contacts = [];

  for (const line of lines) {
    if (!new RegExp(rolePattern, 'i').test(line)) {
      continue;
    }

    const role = (line.match(new RegExp(rolePattern, 'i')) || [''])[0];
    const names = line.match(/\b[A-ZÀ-ÖØ-Þ][a-zà-öø-ÿ'’-]+(?:\s+(?:van|de|den|der|het|ter|ten|op|aan|du|la|le|von|of))?(?:\s+[A-ZÀ-ÖØ-Þ][a-zà-öø-ÿ'’-]+){1,3}\b/g) || [];

    for (const name of names) {
      if (new RegExp(rolePattern, 'i').test(name)) {
        continue;
      }

      const emailGuesses = emailGuessesForName(name, domain, emailPattern);
      contacts.push({
        name,
        role,
        source_text: line,
        email_guess: emailGuesses[0] || '',
      });
    }
  }

  return contacts
    .filter((contact, index, all) => all.findIndex((candidate) => candidate.name.toLowerCase() === contact.name.toLowerCase() && candidate.role.toLowerCase() === contact.role.toLowerCase()) === index)
    .slice(0, 8);
}

function extractRoleSignals(text, domain, emailPattern = '') {
  const roleWords = [
    'ceo', 'cfo', 'cto', 'coo', 'directeur', 'algemeen directeur', 'commercieel directeur',
    'financieel directeur', 'technisch directeur', 'managing director', 'founder', 'co-founder',
    'oprichter', 'mede-oprichter', 'eigenaar', 'partner', 'directie', 'management', 'bestuur'
  ];
  const rolePattern = roleWords.map((role) => role.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const chunks = String(text || '')
    .split(/\n|\r| {2,}|[•|]/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line.length >= 5 && line.length <= 180 && new RegExp(rolePattern, 'i').test(line));
  const signals = [];

  for (const chunk of chunks) {
    const role = (chunk.match(new RegExp(rolePattern, 'i')) || [''])[0];
    const names = chunk.match(/\b[A-ZÀ-ÖØ-Þ][a-zà-öø-ÿ'’-]{2,}(?:\s+(?:van|de|den|der|het|ter|ten|op|aan|du|la|le|von|of))?(?:\s+[A-ZÀ-ÖØ-Þ][a-zà-öø-ÿ'’-]{2,}){0,3}\b/g) || [];
    const likelyName = names.find((name) => !new RegExp(rolePattern, 'i').test(name)) || '';
    const guesses = likelyName ? emailGuessesForName(likelyName, domain, emailPattern) : [];

    signals.push({
      name: likelyName,
      role,
      source_text: chunk,
      email_guess: guesses[0] || '',
    });
  }

  return signals
    .filter((signal, index, all) => {
      const key = `${signal.name}|${signal.role}|${signal.source_text}`.toLowerCase();
      return signal.role && all.findIndex((candidate) => `${candidate.name}|${candidate.role}|${candidate.source_text}`.toLowerCase() === key) === index;
    })
    .slice(0, 10);
}

async function fetchResearchPage(url, timeoutSeconds, fetched, errors, pageCache = null, options = {}) {
  try {
    await assertPublicUrl(url);
    if (pageCache && pageCache.has(url)) {
      return pageCache.get(url);
    }

    const page = await fetchHtml(url, timeoutSeconds);
    if (!fetched.includes(page.url)) {
      fetched.push(page.url);
    }
    if (pageCache) {
      pageCache.set(url, page);
      pageCache.set(page.url, page);
    }
    if (!page.ok) {
      if (options.silent !== true) {
        errors.push(`HTTP ${page.status}: ${url}`);
      }
      return null;
    }
    return page;
  } catch (error) {
    if (options.silent !== true) {
      errors.push(fetchErrorMessage(error, url));
    }
    return null;
  }
}

async function discoverWebsiteByCompanyName(companyName, timeoutSeconds, fetched, errors, pageCache) {
  for (const url of companyDomainCandidates(companyName)) {
    const page = await fetchResearchPage(url, timeoutSeconds, fetched, errors, pageCache, { silent: true });
    if (page && pageMatchesCompany(page, companyName)) {
      return page.url;
    }
  }

  return '';
}

function duckDuckGoResultUrls(html) {
  const urls = [];
  const hrefRegex = /<a\b[^>]*href=["']([^"']+)["'][^>]*>/gi;
  let match;

  while ((match = hrefRegex.exec(String(html || ''))) !== null) {
    let href = decodeEntities(match[1]);
    try {
      const parsed = new URL(href, 'https://duckduckgo.com/');
      const redirected = parsed.searchParams.get('uddg');
      if (redirected) {
        href = redirected;
      } else {
        href = parsed.toString();
      }
    } catch {
      continue;
    }

    if (!/^https?:\/\//i.test(href) || isSkippableResearchUrl(href)) {
      continue;
    }

    const host = hostWithoutWww(href);
    if (!host || isSocialOrDirectoryHost(host) || /duckduckgo\.com$/i.test(host)) {
      continue;
    }

    urls.push(href);
  }

  return urls.filter((url, index, all) => all.findIndex((candidate) => candidate === url) === index).slice(0, 8);
}

async function discoverWebsiteBySearch(companyName, timeoutSeconds, fetched, errors, pageCache, options = {}) {
  if (options.enabled === false) {
    return '';
  }

  const query = encodeURIComponent(`"${companyName}" bedrijf website`);
  const searchUrl = `https://duckduckgo.com/html/?q=${query}`;
  const searchPage = await fetchResearchPage(searchUrl, timeoutSeconds, fetched, errors, pageCache, { silent: true });
  if (!searchPage) {
    return '';
  }

  const resultUrls = duckDuckGoResultUrls(searchPage.body);
  for (const url of resultUrls.slice(0, 5)) {
    const page = await fetchResearchPage(url, timeoutSeconds, fetched, errors, pageCache, { silent: true });
    if (page && pageMatchesCompany(page, companyName)) {
      return page.url;
    }
  }

  return '';
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

function buildLeadFromTableRow({ row, sourceName, pageUrl, criteria }) {
  const descriptionParts = [];
  if (row.rank) {
    descriptionParts.push(`Ranking positie ${row.rank}`);
  }
  if (row.table_score_text) {
    descriptionParts.push(`Score ${row.table_score_text}`);
  }
  descriptionParts.push(`Gevonden in ${sourceName || 'publieke ranking'}.`);

  const scoreNumber = row.table_score_text
    ? Number(String(row.table_score_text).replace('%', '').replace(',', '.'))
    : NaN;
  const baseScore = Number.isFinite(scoreNumber) ? Math.round(Math.max(0, Math.min(100, scoreNumber))) : null;
  const haystack = `${row.company_name} ${descriptionParts.join(' ')}`.toLowerCase();
  const matchedBranches = findMatchingTerms(criteria.branches, haystack);
  const matchedKeywords = findMatchingTerms(criteria.keywords, haystack);
  const excluded = findMatchingTerms(criteria.exclude_keywords, haystack);
  let criteriaScore = baseScore !== null ? baseScore : 60;
  const reasons = [];

  if (row.rank) reasons.push(`ranking positie ${row.rank}`);
  if (row.table_score_text) reasons.push(`ranking score ${row.table_score_text}`);
  if (matchedBranches.length) {
    criteriaScore += Math.min(10, matchedBranches.length * 5);
    reasons.push(`branche-match: ${matchedBranches.join(', ')}`);
  }
  if (matchedKeywords.length) {
    criteriaScore += Math.min(10, matchedKeywords.length * 5);
    reasons.push(`keywords: ${matchedKeywords.join(', ')}`);
  }
  if (excluded.length) {
    criteriaScore -= 30;
    reasons.push(`uitsluiting: ${excluded.join(', ')}`);
  }

  criteriaScore = Math.max(0, Math.min(100, criteriaScore));

  return {
    company_name: row.company_name,
    website: '',
    industry: matchedBranches[0] || 'ICT / software',
    description: descriptionParts.join('; '),
    criteria_score: criteriaScore,
    criteria_reason: reasons.join('; ') || 'gevonden in rankingtabel',
    enrichment_links: row.source_url && row.source_url !== pageUrl
      ? [{ link_type: 'source', url: row.source_url, title: row.company_name }]
      : [],
    source_url: row.source_url || pageUrl,
    raw_payload: row,
    needs_website_discovery: true,
    status: 'new',
  };
}

function buildLeadFromListingCandidate({ row, sourceName, pageUrl, criteria }) {
  const descriptionParts = [];
  if (row.rank) {
    descriptionParts.push(`Lijstpositie ${row.rank}`);
  }
  descriptionParts.push(`Gevonden in ${sourceName || 'publieke bedrijvenlijst'}.`);

  const haystack = `${row.company_name} ${row.raw_text || ''} ${descriptionParts.join(' ')}`.toLowerCase();
  const matchedBranches = findMatchingTerms(criteria.branches, haystack);
  const matchedKeywords = findMatchingTerms(criteria.keywords, haystack);
  const excluded = findMatchingTerms(criteria.exclude_keywords, haystack);
  let criteriaScore = 55;
  const reasons = [];

  if (row.rank) reasons.push(`lijstpositie ${row.rank}`);
  if (matchedBranches.length) {
    criteriaScore += Math.min(15, matchedBranches.length * 5);
    reasons.push(`branche-match: ${matchedBranches.join(', ')}`);
  }
  if (matchedKeywords.length) {
    criteriaScore += Math.min(15, matchedKeywords.length * 5);
    reasons.push(`keywords: ${matchedKeywords.join(', ')}`);
  }
  if (excluded.length) {
    criteriaScore -= 30;
    reasons.push(`uitsluiting: ${excluded.join(', ')}`);
  }

  return {
    company_name: row.company_name,
    website: '',
    industry: matchedBranches[0] || '',
    description: descriptionParts.join('; '),
    criteria_score: Math.max(0, Math.min(100, criteriaScore)),
    criteria_reason: reasons.join('; ') || 'gevonden in bedrijvenlijst',
    enrichment_links: row.source_url && row.source_url !== pageUrl
      ? [{ link_type: 'source', url: row.source_url, title: row.company_name }]
      : [],
    source_url: row.source_url || pageUrl,
    raw_payload: row,
    needs_website_discovery: true,
    status: 'new',
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

function fetchErrorMessage(error, url) {
  const code = error && (error.code || (error.cause && error.cause.code));
  if (code === 'CERT_HAS_EXPIRED') {
    return `SSL-certificaat is verlopen voor ${url}. Deze bron kan pas veilig worden gescraped nadat het certificaat is vernieuwd.`;
  }

  if (code) {
    return `${code}: ${url}`;
  }

  return `${error && error.message ? error.message : String(error)}: ${url}`;
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

async function enrichLeadWithWaterfall({ lead, payload, config, criteria, timeoutSeconds, fetched, errors, onProgress, pageCache }) {
  const sourceHost = hostWithoutWww(payload.list_url);
  const listUrl = payload.list_url || '';
  const researchPages = [];
  const allLinks = [];
  const allTexts = [];
  const emailPattern = criteria.email_pattern_example || '';
  const websiteCrawlMaxPages = clampNumber(config.website_crawl_max_pages || criteria.website_crawl_max_pages, 50, 1, 100);

  async function addPage(url, linkType, title) {
    if (!url || researchPages.some((page) => page.url === url)) {
      return null;
    }

    const page = await fetchResearchPage(url, timeoutSeconds, fetched, errors, pageCache);
    if (!page) {
      return null;
    }

    const text = stripTags(page.body);
    const links = extractLinks(page.body, page.url);
    researchPages.push({ url: page.url, link_type: linkType, title: title || titleFromHtml(page.body) || linkType, text });
    allTexts.push(text);
    allLinks.push(...links);
    return { page, text, links };
  }

  const sourceUrlIsListPage = lead.source_url && listUrl && urlsPointToSamePage(lead.source_url, listUrl);
  if (lead.source_url && !sourceUrlIsListPage) {
    await addPage(lead.source_url, 'source', lead.company_name);
  }

  let website = lead.website || '';
  if (!website || lead.needs_website_discovery) {
    website = discoverCompanyWebsite(allLinks, sourceHost) || website;
    if (!website) {
      website = await discoverWebsiteByCompanyName(lead.company_name, timeoutSeconds, fetched, errors, pageCache);
    }
    if (!website) {
      website = await discoverWebsiteBySearch(lead.company_name, timeoutSeconds, fetched, errors, pageCache, {
        enabled: config.enable_search_discovery !== false,
      });
    }
  }

  if (website) {
    const websitePage = await addPage(website, 'website', lead.company_name);
    if (websitePage) {
      const seenUrls = new Set(researchPages.map((page) => normalizedCrawlUrl(page.url)).filter(Boolean));
      const queue = websiteCrawlCandidates(websitePage.links, websitePage.page.url, seenUrls, websiteCrawlMaxPages);

      while (queue.length > 0 && researchPages.length < websiteCrawlMaxPages) {
        const link = queue.shift();
        const normalized = normalizedCrawlUrl(link.url);
        if (!normalized || seenUrls.has(normalized)) {
          continue;
        }

        seenUrls.add(normalized);
        const crawled = await addPage(link.url, link.score >= 40 ? 'research' : 'website', link.text || 'website');
        if (crawled) {
          const nextLinks = websiteCrawlCandidates(crawled.links, websitePage.page.url, seenUrls, websiteCrawlMaxPages);
          for (const nextLink of nextLinks) {
            if (queue.length >= websiteCrawlMaxPages * 2) {
              break;
            }
            queue.push(nextLink);
          }

          queue.sort((a, b) => b.score - a.score);
        }

        if (researchPages.length % 5 === 0) {
          await onProgress(`Website crawl onderzoekt ${lead.company_name}: ${researchPages.length}/${websiteCrawlMaxPages} pagina's bekeken.`);
        }
      }
    }
  }

  if (researchPages.length === 0) {
    return lead;
  }

  const combinedText = allTexts.join('\n').slice(0, 120000);
  const emails = extractEmails(combinedText);
  const phones = extractPhones(combinedText);
  const employeeRange = extractEmployeeRange(combinedText);
  const branches = findMatchingTerms(criteria.branches, `${lead.company_name} ${combinedText}`.toLowerCase());
  const domain = website ? hostWithoutWww(website) : '';
  const managementContacts = [
    ...extractManagementContacts(combinedText, domain, emailPattern),
    ...extractRoleSignals(combinedText, domain, emailPattern),
  ].filter((contact, index, all) => {
    const key = `${contact.name}|${contact.role}|${contact.source_text}`.toLowerCase();
    return all.findIndex((candidate) => `${candidate.name}|${candidate.role}|${candidate.source_text}`.toLowerCase() === key) === index;
  }).slice(0, 12);
  const emailGuesses = [
    ...managementContacts.map((contact) => contact.email_guess).filter(Boolean),
    ...(website ? [`info@${hostWithoutWww(website)}`, `sales@${hostWithoutWww(website)}`] : []),
  ].filter((email, index, all) => email && all.indexOf(email) === index).slice(0, 10);
  const enrichmentLinks = [
    ...(Array.isArray(lead.enrichment_links) ? lead.enrichment_links : []),
    ...classifyEnrichmentLinks(allLinks),
    ...researchPages.map((page) => ({
      link_type: page.link_type,
      url: page.url,
      title: page.title,
    })),
  ].filter((link, index, all) => link.url && all.findIndex((candidate) => candidate.url === link.url) === index).slice(0, 80);
  const researchPageSummaries = researchPages.map((page) => {
    const pageText = page.text || '';
    return {
      url: page.url,
      title: page.title,
      link_type: page.link_type,
      excerpt: pageText.slice(0, 900),
      emails: extractEmails(pageText).slice(0, 5),
      phones: extractPhones(pageText).slice(0, 5),
    };
  });
  const socialLinks = classifyEnrichmentLinks(allLinks)
    .filter((link) => ['linkedin', 'social'].includes(link.link_type))
    .slice(0, 20);
  const detectedKeywords = [
    ...findMatchingTerms(criteria.keywords, combinedText.toLowerCase()),
    ...findMatchingTerms(criteria.branches, combinedText.toLowerCase()),
  ].filter((term, index, all) => all.indexOf(term) === index).slice(0, 30);

  const descriptionParts = [
    lead.description,
    combinedText.slice(0, 700),
  ].filter(Boolean);
  const researchSummary = [
    `Waterfall: ${researchPages.length} pagina's onderzocht.`,
    website ? `Bedrijfswebsite: ${website}.` : '',
    detectedKeywords.length ? `Gevonden thema's/keywords: ${detectedKeywords.slice(0, 10).join(', ')}.` : '',
    managementContacts.length ? `Mogelijke leiding/contactpersonen: ${managementContacts.map((contact) => `${contact.name} (${contact.role})`).join(', ')}.` : '',
    emails.length ? `Publieke e-mails gevonden: ${emails.slice(0, 3).join(', ')}.` : '',
    phones.length ? `Publieke telefoons gevonden: ${phones.slice(0, 3).join(', ')}.` : '',
  ].filter(Boolean).join(' ');

  const enriched = {
    ...lead,
    website: website || lead.website,
    email: lead.email || emails[0] || '',
    phone: lead.phone || phones[0] || '',
    industry: lead.industry || branches[0] || '',
    description: descriptionParts.join('\n\n').slice(0, 1800),
    employee_count_text: lead.employee_count_text || employeeRange.text,
    employee_count_min: lead.employee_count_min ?? employeeRange.min,
    employee_count_max: lead.employee_count_max ?? employeeRange.max,
    enrichment_links: enrichmentLinks,
    research_pages: researchPageSummaries,
    all_emails: emails.slice(0, 30),
    all_phones: phones.slice(0, 30),
    social_links: socialLinks,
    detected_keywords: detectedKeywords,
    management_contacts: managementContacts,
    email_guesses: emailGuesses,
    research_summary: researchSummary,
    research_pages_count: researchPages.length,
    website_crawl_max_pages: websiteCrawlMaxPages,
  };

  const scored = scoreLead(enriched, criteria);
  const emailHint = website ? emailPatternHint(emailPattern, website) : '';
  enriched.criteria_score = scored.score;
  enriched.criteria_reason = [scored.reason, emailHint ? `e-mailpatroon hint: ${emailHint}` : '', managementContacts.length ? 'leiding/contactpersoon-signalen gevonden' : '']
    .filter(Boolean)
    .join('; ');

  return enriched;
}

export async function runLeadScrape(payload, onProgress = async () => {}) {
  const config = parseJson(payload.config_json);
  const criteria = parseJson(payload.criteria_json);
  const sourceType = normalizeSourceType(payload.source_type || config.source_type || 'website');
  const maxPages = clampNumber(payload.max_pages, 5, 1, 20);
  const timeoutSeconds = clampNumber(payload.timeout_seconds, 30, 5, 120);
  const startUrl = await assertPublicUrl(payload.list_url);
  const fetched = [];
  const leads = [];
  const errors = [];
  const pageCache = new Map();

  async function progress(message) {
    await onProgress({
      message,
      stats: {
        pages_fetched: fetched.length,
        items_found: leads.length,
        errors_count: errors.length,
      },
    });
  }

  let first;
  try {
    first = await fetchHtml(startUrl.toString(), timeoutSeconds);
  } catch (error) {
    const message = fetchErrorMessage(error, startUrl.toString());
    return {
      success: false,
      message,
      stats: {
        pages_fetched: fetched.length,
        items_found: 0,
        errors_count: 1,
      },
      leads: [],
      run_items: [{
        detail_url: startUrl.toString(),
        raw_title: payload.source_name || startUrl.hostname,
        status: 'failed',
        error_text: message,
      }],
    };
  }
  fetched.push(first.url);
  pageCache.set(startUrl.toString(), first);
  pageCache.set(first.url, first);
  await progress(sourceTypeIsSingleWebsite(sourceType)
    ? 'Bedrijfswebsite opgehaald. De website wordt nu als één lead onderzocht.'
    : 'Lijstpagina opgehaald. Links en bedrijven worden nu geanalyseerd.');

  if (!first.ok) {
    return {
      success: false,
      message: `${sourceTypeIsSingleWebsite(sourceType) ? 'Website' : 'Lijstpagina'} gaf HTTP ${first.status}.`,
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
  const isSingleWebsiteSource = sourceTypeIsSingleWebsite(sourceType);
  const tableRows = isSingleWebsiteSource ? [] : extractTableRows(first.body, first.url);
  const listingLike = !isSingleWebsiteSource && pageLooksLikeListing(first.body, sourceType);
  const listRows = listingLike ? extractListCompanyCandidates(first.body, first.url) : [];
  const sourceRows = tableRows.length > 0 ? tableRows : listRows;

  if (isSingleWebsiteSource) {
    leads.push(buildLeadFromPage({
      sourceName: payload.source_name,
      url: first.url,
      html: first.body,
      config,
      criteria,
    }));
    await progress('Bedrijfswebsite als één lead aangemaakt. Interne pagina\'s worden aan deze lead toegevoegd.');
  } else if (sourceRows.length > 0) {
    for (const row of sourceRows.slice(0, 150)) {
      const builder = tableRows.length > 0 ? buildLeadFromTableRow : buildLeadFromListingCandidate;
      leads.push(builder({
        row,
        sourceName: payload.source_name,
        pageUrl: first.url,
        criteria,
      }));
    }
    await progress(`${leads.length} kandidaat-leads uit ${tableRows.length > 0 ? 'tabel' : 'lijst'} gevonden.`);
  } else {
    const links = filterLinks(extractLinks(first.body, baseUrl), config, baseHost)
      .slice(0, Math.max(0, maxPages - 1));

    leads.push(buildLeadFromPage({
      sourceName: payload.source_name,
      url: first.url,
      html: first.body,
      config,
      criteria,
    }));
    await progress('Hoofdpagina verwerkt. Detailpagina\'s worden nu opgehaald.');

    for (const link of links) {
      try {
        await assertPublicUrl(link.url);
        const page = await fetchHtml(link.url, timeoutSeconds);
        if (!fetched.includes(page.url)) {
          fetched.push(page.url);
        }
        pageCache.set(link.url, page);
        pageCache.set(page.url, page);
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
        errors.push(fetchErrorMessage(error, link.url));
      }

      await progress(`${fetched.length} pagina's opgehaald, ${leads.length} kandidaat-leads gevonden.`);
    }
  }

  const researchLimit = clampNumber(
    config.max_research_leads || criteria.max_research_leads,
    Math.min(leads.length, 25),
    1,
    75
  );
  for (let index = 0; index < Math.min(leads.length, researchLimit); index++) {
    leads[index] = await enrichLeadWithWaterfall({
      lead: leads[index],
      payload,
      config,
      criteria,
      timeoutSeconds,
      fetched,
      errors,
      onProgress: progress,
      pageCache,
    });
    await progress(`Waterfall verrijking: ${index + 1}/${Math.min(leads.length, researchLimit)} bedrijven onderzocht.`);
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
    run_items: errors.map((error) => ({
      status: 'failed',
      error_text: error,
    })),
    config_used: {
      ...config,
      source_type: sourceType,
      detected_as_listing: listingLike,
    },
  };
}
