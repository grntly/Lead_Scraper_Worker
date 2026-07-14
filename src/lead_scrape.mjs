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

function htmlToReadableLines(html) {
  return decodeEntities(String(html || '')
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/\s*(p|div|section|article|li|tr|td|th|h[1-6])\s*>/gi, '\n')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' '))
    .split(/\n+/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

const NON_COMPANY_LABELS = new Set([
  'home',
  'contact',
  'login',
  'privacy',
  'privacy policy',
  'cookies',
  'cookiebeleid',
  'voorwaarden',
  'algemene voorwaarden',
  'nieuws',
  'blog',
  'vacatures',
  'werken bij',
  'over ons',
  'about',
  'read more',
  'lees meer',
  'download',
  'downloads',
  'nationaal',
  'internationaal',
  'analyse',
  'rente en valuta',
  'derivaten',
  'boeken',
]);

const NON_PERSON_WORDS = [
  'privacy', 'policy', 'cookie', 'cookies', 'terms', 'voorwaarden', 'disclaimer',
  'digitaal', 'paspoort', 'tool', 'maak', 'product', 'informatie', 'oktober',
  'november', 'december', 'januari', 'februari', 'maart', 'april', 'mei', 'juni',
  'juli', 'augustus', 'september', 'service', 'services', 'sales', 'support',
  'contact', 'nieuwsbrief', 'download', 'downloads', 'routebeschrijving',
  'updates', 'bedrijfscertificaat', 'home', 'macroscope',
];

const RELEVANT_CONTACT_ROLES = [
  'ceo', 'cfo', 'cto', 'coo', 'chief executive officer', 'chief financial officer', 'chief technology officer',
  'directeur', 'algemeen directeur', 'commercieel directeur', 'financieel directeur', 'technisch directeur',
  'managing director', 'founder', 'co-founder', 'oprichter', 'mede-oprichter', 'eigenaar', 'owner',
  'partner', 'directie', 'management', 'bestuur', 'bestuurder',
  'sales director', 'sales manager', 'accountmanager', 'account manager', 'business development',
  'commercieel manager', 'marketing manager', 'head of sales', 'head of marketing',
  'hr manager', 'recruiter', 'recruitment', 'people manager', 'operations manager',
  'finance manager', 'controller', 'subsidieadviseur', 'subsidie consultant', 'subsidieconsultant',
  'consultant', 'adviseur',
];

const GENERIC_CONTACT_LOCALS = new Set([
  'info', 'sales', 'support', 'admin', 'contact', 'hello', 'hoi', 'mail', 'office',
  'noreply', 'no-reply', 'privacy', 'marketing', 'facturen', 'invoice', 'debiteuren',
]);

const rolePatternSource = RELEVANT_CONTACT_ROLES
  .map((role) => role.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  .join('|');

function relevantRolePattern(flags = 'i') {
  return new RegExp(rolePatternSource, flags);
}

function normalizeLooseLabel(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' en ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanCompanyName(value, fallback = '') {
  let name = stripTags(value || fallback)
    .replace(/\s+/g, ' ')
    .trim();

  if (name.includes('|')) {
    const parts = name.split('|').map((part) => part.trim()).filter(Boolean);
    const useful = parts.find((part) => !NON_COMPANY_LABELS.has(normalizeLooseLabel(part)));
    name = useful || parts[parts.length - 1] || name;
  }

  name = name
    .replace(/^\s*(?:home|welkom|startpagina)\s*[-–|:]\s*/i, '')
    .replace(/\s*[-–|:]\s*(?:home|welkom|privacy policy|privacy|contact)\s*$/i, '')
    .replace(/\b(?:b\.?\s*v\.?|n\.?\s*v\.?)\b/gi, (match) => match.replace(/\s+/g, '').toUpperCase())
    .trim();

  return name.slice(0, 191);
}

function titleFromHtml(html) {
  const match = String(html || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? cleanCompanyName(match[1]) : '';
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

function removeContactNoise(text) {
  return String(text || '')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, ' ')
    .replace(/(?:\+31|0031|0)[\d\s().-]{8,}/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const NL_PROVINCE_BY_POSTCODE_PREFIX = [
  { min: 1000, max: 1299, province: 'Noord-Holland' },
  { min: 1300, max: 1379, province: 'Flevoland' },
  { min: 1380, max: 1384, province: 'Noord-Holland' },
  { min: 1385, max: 3899, province: 'Utrecht' },
  { min: 3900, max: 3999, province: 'Utrecht' },
  { min: 4000, max: 4119, province: 'Gelderland' },
  { min: 4120, max: 4129, province: 'Utrecht' },
  { min: 4130, max: 5339, province: 'Gelderland' },
  { min: 5340, max: 5765, province: 'Noord-Brabant' },
  { min: 5766, max: 5817, province: 'Limburg' },
  { min: 5820, max: 5846, province: 'Noord-Brabant' },
  { min: 5850, max: 6019, province: 'Limburg' },
  { min: 6020, max: 6029, province: 'Noord-Brabant' },
  { min: 6030, max: 6499, province: 'Limburg' },
  { min: 6500, max: 7439, province: 'Gelderland' },
  { min: 7440, max: 7739, province: 'Overijssel' },
  { min: 7740, max: 7799, province: 'Drenthe' },
  { min: 7800, max: 7959, province: 'Drenthe' },
  { min: 7960, max: 7999, province: 'Overijssel' },
  { min: 8000, max: 8049, province: 'Overijssel' },
  { min: 8050, max: 8054, province: 'Gelderland' },
  { min: 8055, max: 8069, province: 'Overijssel' },
  { min: 8070, max: 8099, province: 'Gelderland' },
  { min: 8100, max: 8159, province: 'Overijssel' },
  { min: 8160, max: 8199, province: 'Gelderland' },
  { min: 8200, max: 8259, province: 'Flevoland' },
  { min: 8260, max: 8299, province: 'Overijssel' },
  { min: 8300, max: 8329, province: 'Flevoland' },
  { min: 8330, max: 8359, province: 'Overijssel' },
  { min: 8360, max: 8389, province: 'Drenthe' },
  { min: 8390, max: 9299, province: 'Friesland' },
  { min: 9300, max: 9349, province: 'Drenthe' },
  { min: 9350, max: 9399, province: 'Groningen' },
  { min: 9400, max: 9499, province: 'Drenthe' },
  { min: 9500, max: 9999, province: 'Groningen' },
];

function provinceFromDutchPostcode(postcode) {
  const prefix = Number(String(postcode || '').replace(/\D/g, '').slice(0, 4));
  if (!Number.isFinite(prefix)) {
    return '';
  }

  const match = NL_PROVINCE_BY_POSTCODE_PREFIX.find((range) => prefix >= range.min && prefix <= range.max);
  return match ? match.province : '';
}

function provinceFromDutchCity(city) {
  const normalized = String(city || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z\s-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const cityMap = {
    amsterdam: 'Noord-Holland',
    rotterdam: 'Zuid-Holland',
    'den haag': 'Zuid-Holland',
    's gravenhage': 'Zuid-Holland',
    utrecht: 'Utrecht',
    eindhoven: 'Noord-Brabant',
    tilburg: 'Noord-Brabant',
    breda: 'Noord-Brabant',
    groningen: 'Groningen',
    almere: 'Flevoland',
    nijmegen: 'Gelderland',
    arnhem: 'Gelderland',
    haarlem: 'Noord-Holland',
    enschede: 'Overijssel',
    amersfoort: 'Utrecht',
    apeldoorn: 'Gelderland',
    's hertogenbosch': 'Noord-Brabant',
    'den bosch': 'Noord-Brabant',
    zwolle: 'Overijssel',
    leiden: 'Zuid-Holland',
    maastricht: 'Limburg',
    dordrecht: 'Zuid-Holland',
    leeuwarden: 'Friesland',
  };

  return cityMap[normalized] || '';
}

function cleanLocationPart(value) {
  return String(value || '')
    .replace(/\b(?:nederland|the netherlands|tel(?:efoon)?|phone|mail|email|e-mail|adres|address)\b/gi, ' ')
    .replace(/^[^\p{L}\d]+|[^\p{L}\d]+$/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function looksLikeDutchCity(value) {
  const city = cleanLocationPart(value);
  if (city.length < 2 || city.length > 45) {
    return false;
  }

  const normalized = normalizeLooseLabel(city);
  if (NON_COMPANY_LABELS.has(normalized)) {
    return false;
  }

  if (/\b(routebeschrijving|updates|bedrijfscertificaat|privacy|policy|cookie|login|contact|home|b\.?v\.?|n\.?v\.?|holding|groep|group|software|finance|stream)\b/i.test(city)) {
    return false;
  }

  return /^[\p{L}'’.\-\s]+$/u.test(city);
}

function extractLocationData(text) {
  const normalized = String(text || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const result = {
    address: '',
    postcode: '',
    city: '',
    province: '',
    country: '',
  };

  const postcodePattern = /\b([1-9][0-9]{3})\s*([A-Z]{2})\b/gi;
  let match;

  while ((match = postcodePattern.exec(normalized)) !== null) {
    const before = removeContactNoise(normalized.slice(Math.max(0, match.index - 90), match.index));
    const after = removeContactNoise(normalized.slice(postcodePattern.lastIndex, postcodePattern.lastIndex + 70));
    const streetMatch = before.match(/([A-ZÀ-ÖØ-Þ][\p{L}'’.\-\s]{2,70}?\s+\d{1,5}\s*[A-Z]?(?:\s*[-/]\s*\d{1,5}\s*[A-Z]?)?)\s*,?\s*$/u);
    const cityMatch = after.match(/^\s*,?\s*([A-ZÀ-ÖØ-Þ][\p{L}'’.\-\s]{1,50})(?=\s*(?:[:;,|•\-]|Nederland|The Netherlands|Tel|Telefoon|Phone|Mail|E-mail|Email|$))/u);

    result.postcode = `${match[1]} ${match[2].toUpperCase()}`;
    const city = cityMatch ? cleanLocationPart(cityMatch[1]) : '';
    result.city = looksLikeDutchCity(city) ? city : result.city;
    result.address = streetMatch ? cleanLocationPart(`${streetMatch[1]}, ${result.postcode}${result.city ? ` ${result.city}` : ''}`) : result.address;
    result.province = provinceFromDutchCity(result.city) || provinceFromDutchPostcode(result.postcode);
    result.country = result.country || 'Nederland';

    if (result.city) {
      break;
    }
  }

  return result;
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

function extractHrefContactData(html) {
  const emails = [];
  const phones = [];
  const regex = /<a\s+[^>]*href=["']([^"']+)["'][^>]*>/gi;
  let match;

  while ((match = regex.exec(String(html || ''))) !== null) {
    const href = decodeEntities(match[1]).trim();
    if (/^mailto:/i.test(href)) {
      const email = href.replace(/^mailto:/i, '').split('?')[0].trim().toLowerCase();
      if (email) emails.push(email);
    }
    if (/^tel:/i.test(href)) {
      const phone = href.replace(/^tel:/i, '').replace(/\s+/g, ' ').trim();
      if (phone) phones.push(phone);
    }
  }

  return {
    emails: extractEmails(emails.join(' ')),
    phones: [...new Set(phones)],
  };
}

function jsonLdObjectsFromHtml(html) {
  const objects = [];
  const regex = /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;

  function pushObject(value) {
    if (!value) return;
    if (Array.isArray(value)) {
      value.forEach(pushObject);
      return;
    }
    if (typeof value !== 'object') return;
    if (Array.isArray(value['@graph'])) {
      value['@graph'].forEach(pushObject);
    }
    objects.push(value);
  }

  while ((match = regex.exec(String(html || ''))) !== null) {
    try {
      pushObject(JSON.parse(decodeEntities(match[1]).trim()));
    } catch {
      // Ignore invalid schema payloads.
    }
  }

  return objects;
}

function schemaValue(value) {
  if (Array.isArray(value)) {
    return schemaValue(value[0]);
  }
  if (value && typeof value === 'object') {
    return value.name || value.url || value['@id'] || '';
  }
  return String(value || '').trim();
}

function organizationDataFromHtml(html) {
  const orgTypes = new Set(['organization', 'localbusiness', 'corporation', 'professionalservice', 'store']);
  const result = {
    name: '',
    website: '',
    email: '',
    phone: '',
    description: '',
    address: '',
    city: '',
    postcode: '',
    country: '',
    same_as: [],
  };

  for (const object of jsonLdObjectsFromHtml(html)) {
    const rawTypes = Array.isArray(object['@type']) ? object['@type'] : [object['@type']];
    const types = rawTypes.map((type) => String(type || '').toLowerCase());
    if (!types.some((type) => orgTypes.has(type))) {
      continue;
    }

    result.name ||= cleanCompanyName(schemaValue(object.name));
    result.website ||= schemaValue(object.url);
    result.email ||= schemaValue(object.email);
    result.phone ||= schemaValue(object.telephone);
    result.description ||= schemaValue(object.description);

    const address = object.address && typeof object.address === 'object' ? object.address : {};
    const street = schemaValue(address.streetAddress);
    result.city ||= schemaValue(address.addressLocality);
    result.postcode ||= schemaValue(address.postalCode);
    result.country ||= schemaValue(address.addressCountry);
    result.address ||= [street, result.postcode, result.city].filter(Boolean).join(' ');

    const sameAs = Array.isArray(object.sameAs) ? object.sameAs : [object.sameAs];
    for (const link of sameAs) {
      const url = schemaValue(link);
      if (/^https?:\/\//i.test(url)) {
        result.same_as.push({ url, text: result.name || 'sameAs' });
      }
    }
  }

  result.same_as = result.same_as.filter((link, index, all) => all.findIndex((candidate) => normalizedLinkKey(candidate.url) === normalizedLinkKey(link.url)) === index);
  return result;
}

function personDataFromHtml(html, domain, emailPattern = '') {
  const people = [];

  for (const object of jsonLdObjectsFromHtml(html)) {
    const rawTypes = Array.isArray(object['@type']) ? object['@type'] : [object['@type']];
    const types = rawTypes.map((type) => String(type || '').toLowerCase());
    if (!types.includes('person')) {
      continue;
    }

    const name = cleanContactName(schemaValue(object.name));
    if (!looksLikePersonName(name)) {
      continue;
    }

    const role = schemaValue(object.jobTitle) || schemaValue(object.roleName) || '';
    const email = schemaValue(object.email).replace(/^mailto:/i, '').toLowerCase();
    const phone = schemaValue(object.telephone);
    const sameAs = Array.isArray(object.sameAs) ? object.sameAs : [object.sameAs];
    const linkedinUrl = sameAs.map(schemaValue).find((url) => isLikelyLinkedInPersonUrl(url)) || '';
    const guesses = emailGuessesForName(name, domain, emailPattern);

    people.push({
      name,
      role,
      source_text: [name, role].filter(Boolean).join(' - '),
      email_guess: email || guesses[0] || '',
      phone,
      linkedin_url: linkedinUrl,
      source_type: 'schema_person',
      relevance_score: contactRelevanceScore({ name, role, email_guess: email || guesses[0] || '', linkedin_url: linkedinUrl }),
    });
  }

  return people;
}

function normalizeSourceType(value) {
  const type = String(value || '').toLowerCase().replace(/[^a-z0-9_/-]+/g, '_');
  if (['ranking', 'directory', 'industry_page', 'list', 'listing', 'company_list'].includes(type)) {
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

function sourceTypeIsCompanyList(sourceType) {
  return normalizeSourceType(sourceType) === 'company_list';
}

function companyNamesFromConfig(config = {}) {
  const rawNames = Array.isArray(config.company_names)
    ? config.company_names
    : String(config.company_names || '')
      .split(/\r\n|\r|\n|;/);

  return rawNames
    .map((name) => cleanCompanyName(name))
    .filter((name) => looksLikeCompanyName(name))
    .filter((name, index, all) => all.findIndex((candidate) => normalizeLooseLabel(candidate) === normalizeLooseLabel(name)) === index)
    .slice(0, 250);
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
  return cleanCompanyName(text)
    .replace(/^\s*(?:#?\d{1,4}|[A-Z])\s*[\).:-]\s*/i, '')
    .replace(/\b(?:bekijk|lees meer|read more|website|contact|profiel|details|meer info)\b.*$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 191);
}

function looksLikeCompanyName(text) {
  const value = cleanCompanyName(text);
  const normalized = normalizeLooseLabel(value);
  if (value.length < 2 || value.length > 90) {
    return false;
  }

  if (NON_COMPANY_LABELS.has(normalized)) {
    return false;
  }

  if (/@|https?:|www\.|\d{2}[-/]\d{2}[-/]\d{2,4}|\b(home|menu|login|privacy|cookies|contact|nieuws|blog|vacatures|over ons|about|read more|lees meer|download|pdf|rss|instagram|facebook|linkedin|twitter|youtube)\b/i.test(value)) {
    return false;
  }

  if (/^\d+$|^\d+([.,]\d+)?%$/.test(value)) {
    return false;
  }

  const words = value.split(/\s+/).filter(Boolean);
  if (words.length > 7 || words.every((word) => word.length <= 2)) {
    return false;
  }

  return /[a-zA-ZÀ-ÖØ-öø-ÿ]/.test(value);
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
  const value = removeContactNoise(text).toLowerCase();
  const employeeWord = '(?:medewerkers|werknemers|personeel|employees|fte)';
  const range = value.match(new RegExp(`(\\d{1,5})\\s*[-–]\\s*(\\d{1,5})\\s*${employeeWord}`, 'i'));
  if (range) {
    return {
      text: range[0],
      min: Number(range[1]),
      max: Number(range[2]),
    };
  }

  const minimum = value.match(new RegExp(`(?:meer dan|over|at least|minimaal)\\s*(\\d{1,5})\\s*${employeeWord}`, 'i'));
  if (minimum) {
    return {
      text: minimum[0],
      min: Number(minimum[1]),
      max: null,
    };
  }

  const single = value.match(new RegExp(`(\\d{1,5})\\s*${employeeWord}`, 'i'));
  if (single) {
    return {
      text: single[0],
      min: Number(single[1]),
      max: Number(single[1]),
    };
  }

  return { text: '', min: null, max: null };
}

function extractSAndOEmployees(text) {
  const value = removeContactNoise(text);
  const patterns = [
    /\b(?:s&o|wbs[o0]|speur-?\s*en\s*ontwikkelingswerk|r&d)\b.{0,80}?\b(\d{1,5})\s*(?:medewerkers|werknemers|fte|employees)\b/i,
    /\b(\d{1,5})\s*(?:medewerkers|werknemers|fte|employees)\b.{0,80}?\b(?:s&o|wbs[o0]|speur-?\s*en\s*ontwikkelingswerk|r&d)\b/i,
  ];

  for (const pattern of patterns) {
    const match = value.match(pattern);
    if (match) {
      return match[0].replace(/\s+/g, ' ').trim().slice(0, 191);
    }
  }

  return '';
}

function extractPotentialOpportunities(text, criteria = {}) {
  const haystack = String(text || '').toLowerCase();
  const opportunities = [];
  const checks = [
    ['WBSO / S&O', /\b(wbso|s&o|speur-?\s*en\s*ontwikkelingswerk|r&d|research\s*&\s*development)\b/i],
    ['Innovatiebox', /\b(innovatiebox|patent|octrooi|intellectual property|ip)\b/i],
    ['Subsidie innovatieproject', /\b(innovatie|ontwikkeling|prototype|pilot|proof of concept|technologie)\b/i],
    ['Duurzaamheid / energie', /\b(duurzaam|energie|co2|circular|circulair|emissie|klimaat)\b/i],
    ['Digitalisering', /\b(software|saas|cloud|data|ai|kunstmatige intelligentie|automatisering|platform)\b/i],
  ];

  for (const [label, pattern] of checks) {
    if (pattern.test(haystack)) {
      opportunities.push(label);
    }
  }

  const criteriaTerms = [
    ...(Array.isArray(criteria.keywords) ? criteria.keywords : []),
    ...(Array.isArray(criteria.branches) ? criteria.branches : []),
  ];
  for (const term of criteriaTerms) {
    const clean = String(term || '').trim();
    if (clean && haystack.includes(clean.toLowerCase())) {
      opportunities.push(clean);
    }
  }

  return [...new Set(opportunities)].slice(0, 10);
}

function findMatchingTerms(terms, haystack) {
  return (Array.isArray(terms) ? terms : [])
    .map((term) => String(term || '').trim())
    .filter(Boolean)
    .filter((term) => haystack.includes(term.toLowerCase()));
}

function normalizedLinkKey(url) {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    parsed.protocol = parsed.protocol.toLowerCase();
    parsed.hostname = parsed.hostname.replace(/^www\./i, '').toLowerCase();
    parsed.pathname = parsed.pathname.replace(/\/$/, '');
    return parsed.toString();
  } catch {
    return String(url || '').trim().toLowerCase().replace(/\/$/, '');
  }
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

  return mapped
    .filter((link, index, all) => all.findIndex((candidate) => normalizedLinkKey(candidate.url) === normalizedLinkKey(link.url)) === index)
    .slice(0, 20);
}

function isLikelyLinkedInCompanyUrl(url) {
  return /linkedin\.com\/(?:company|school|showcase)\//i.test(String(url || ''));
}

function isLikelyLinkedInPersonUrl(url) {
  return /linkedin\.com\/(?:in|pub)\//i.test(String(url || ''));
}

function linkedinCompanyLinks(links, companyName = '') {
  const companyKey = normalizeLooseLabel(companyName);
  return links
    .filter((link) => isLikelyLinkedInCompanyUrl(link.url))
    .filter((link) => {
      if (!companyKey) return true;
      const haystack = normalizeLooseLabel(`${link.text || ''} ${link.url || ''}`);
      const companyParts = companyKey.split(' ').filter((part) => part.length >= 4);
      return companyParts.length === 0 || companyParts.some((part) => haystack.includes(part));
    })
    .map((link) => ({
      link_type: 'linkedin',
      url: link.url,
      title: link.text || `${companyName} LinkedIn`,
    }))
    .filter((link, index, all) => all.findIndex((candidate) => normalizedLinkKey(candidate.url) === normalizedLinkKey(link.url)) === index)
    .slice(0, 5);
}

function knownResearchPathUrls(websiteUrl) {
  if (!websiteUrl) {
    return [];
  }

  let origin = '';
  try {
    origin = new URL(websiteUrl).origin;
  } catch {
    return [];
  }

  const paths = [
    '/contact',
    '/contact/',
    '/over-ons',
    '/over-ons/',
    '/over',
    '/over/',
    '/wie-zijn-wij',
    '/wie-zijn-wij/',
    '/about',
    '/about/',
    '/team',
    '/team/',
    '/mensen',
    '/directie',
    '/management',
    '/leadership',
    '/werken-bij',
    '/werken-bij/',
    '/vacatures',
    '/careers',
    '/jobs',
  ];

  return paths.map((path) => `${origin}${path}`);
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

function looksLikePersonName(name) {
  const cleaned = cleanContactName(name);
  const normalized = normalizeLooseLabel(cleaned);
  const parts = cleaned.split(/\s+/).filter(Boolean);

  if (cleaned.length < 5 || cleaned.length > 60 || parts.length < 2 || parts.length > 4) {
    return false;
  }

  if (NON_COMPANY_LABELS.has(normalized)) {
    return false;
  }

  if (NON_PERSON_WORDS.some((word) => new RegExp(`\\b${escapeRegExp(word)}\\b`, 'i').test(cleaned))) {
    return false;
  }

  const initialsOrShort = parts.filter((part) => /^[A-Z]\.?$/i.test(part) || part.length <= 1).length;
  if (initialsOrShort === parts.length) {
    return false;
  }

  return parts.every((part) => /^(?:van|de|den|der|het|ter|ten|op|aan|du|la|le|von|of|[A-ZÀ-ÖØ-Þ][a-zà-öø-ÿ'’-]{1,})$/u.test(part));
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

function cleanContactName(name) {
  const raw = String(name || '').trim();
  if (!raw) {
    return '';
  }

  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    decoded = raw;
  }

  return decoded
    .replace(/\s+/g, ' ')
    .replace(/\b([a-z])([A-ZÀ-ÖØ-Þ])/g, '$1 $2')
    .trim();
}

function normalizeContactNameKey(name) {
  return cleanContactName(name)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

function isGenericContactLabel(contact) {
  const name = cleanContactName(contact.name || '').toLowerCase();
  const role = String(contact.role || '').toLowerCase();
  const email = String(contact.email_guess || '').toLowerCase();
  const local = email.replace(/@.+$/, '').replace(/[._-]+/g, ' ');

  if (!name && !email) {
    return true;
  }

  if (name && !looksLikePersonName(name)) {
    return true;
  }

  const exactGenericTerms = [
    'nieuwsbrief',
    'personeel subsidies',
  ];

  if (GENERIC_CONTACT_LOCALS.has(name) || GENERIC_CONTACT_LOCALS.has(local) || exactGenericTerms.includes(name) || exactGenericTerms.includes(local)) {
    return true;
  }

  return ['load more', 'read more', 'all downloads']
    .some((term) => name.includes(term) || local.includes(term) || role.includes(term));
}

function contactRelevanceScore(contact) {
  const role = String(contact.role || '').toLowerCase();
  const source = String(contact.source_text || '').toLowerCase();
  const email = String(contact.email_guess || contact.email || '').trim();
  let score = 0;

  if (looksLikePersonName(contact.name || '')) score += 25;
  if (email && !GENERIC_CONTACT_LOCALS.has(email.replace(/@.+$/, '').replace(/[._-]+/g, ' '))) score += 18;
  if (contact.phone) score += 8;
  if (contact.linkedin_url) score += 15;
  if (relevantRolePattern('i').test(`${role} ${source}`)) score += 30;
  if (/\b(ceo|cfo|cto|directeur|founder|oprichter|eigenaar|owner|partner|bestuurder)\b/i.test(`${role} ${source}`)) score += 15;
  if (/\b(stage|student|junior|stagiair|assistant|secretaresse)\b/i.test(`${role} ${source}`)) score -= 15;

  return Math.max(0, Math.min(100, score));
}

function uniqueManagementContacts(contacts, limit = 10) {
  const unique = [];
  const seen = new Set();

  for (const contact of contacts) {
    if (!contact || isGenericContactLabel(contact)) {
      continue;
    }

    const cleaned = {
      ...contact,
      name: cleanContactName(contact.name || ''),
      role: String(contact.role || '').trim(),
      source_text: String(contact.source_text || '').trim(),
      email_guess: String(contact.email_guess || '').trim().toLowerCase(),
      phone: String(contact.phone || '').trim(),
      linkedin_url: String(contact.linkedin_url || '').trim(),
      source_type: String(contact.source_type || '').trim(),
    };
    cleaned.relevance_score = Number.isFinite(Number(contact.relevance_score))
      ? Number(contact.relevance_score)
      : contactRelevanceScore(cleaned);

    if (cleaned.relevance_score < 35) {
      continue;
    }

    const nameKey = normalizeContactNameKey(cleaned.name);
    const key = cleaned.email_guess || nameKey;

    if (!key || seen.has(key)) {
      continue;
    }

    seen.add(key);
    unique.push(cleaned);
    if (unique.length >= limit) {
      break;
    }
  }

  return unique.sort((a, b) => (b.relevance_score || 0) - (a.relevance_score || 0));
}

function bestEmailForContact(contact, emails) {
  const cleanedName = cleanContactName(contact.name || '');
  const parts = cleanedName
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]+/g, ' ')
    .split(/[\s-]+/)
    .filter(Boolean);
  const first = parts[0] || '';
  const last = parts.length > 1 ? parts[parts.length - 1] : '';
  const nameKey = normalizeContactNameKey(cleanedName);

  for (const email of emails) {
    const normalizedEmail = String(email || '').trim().toLowerCase();
    const local = normalizedEmail.replace(/@.+$/, '');
    const localKey = normalizeContactNameKey(local.replace(/[._-]+/g, ' '));

    if (!normalizedEmail || !localKey) {
      continue;
    }

    if ((first && local === first)
      || (nameKey && localKey.includes(nameKey))
      || (first && last && localKey.includes(first) && localKey.includes(last))) {
      return normalizedEmail;
    }
  }

  return String(contact.email_guess || '').trim().toLowerCase();
}

function contactsFromEmails(emails, domain) {
  return emails
    .map((email) => String(email || '').trim().toLowerCase())
    .filter((email) => email.endsWith(`@${domain}`))
    .map((email) => {
      const local = email.replace(/@.+$/, '');
      if (/^(info|sales|support|admin|contact|hello|hoi|mail|office|noreply|no-reply)$/.test(local)) {
        return null;
      }

      const parts = local.split(/[._-]+/).filter((part) => part.length >= 2);
      if (!parts.length) {
        return null;
      }

      const name = parts.map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(' ');
      return {
        name,
        role: '',
        source_text: email,
        email_guess: email,
      };
    })
    .filter(Boolean);
}

function nameFromEmailLocal(local) {
  const parts = String(local || '')
    .split(/[._-]+/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 2);

  if (parts.length < 2) {
    return '';
  }

  return parts.map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(' ');
}

function nearbyEmailForLine(line, emails) {
  const direct = extractEmails(line)[0] || '';
  if (direct) {
    return direct;
  }

  const normalized = normalizeLooseLabel(line);
  for (const email of emails) {
    const local = String(email || '').replace(/@.+$/, '').replace(/[._-]+/g, ' ');
    if (local && normalized.includes(normalizeLooseLabel(local))) {
      return email;
    }
  }

  return '';
}

function extractRelevantContactsFromText(text, domain, emailPattern = '') {
  const rolePattern = relevantRolePattern('i');
  const lines = String(text || '')
    .split(/\n|\r|[;|•]/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line.length >= 5 && line.length <= 260);
  const emails = extractEmails(text);
  const contacts = [];

  for (let index = 0; index < lines.length; index++) {
    const windowText = [lines[index - 1] || '', lines[index], lines[index + 1] || '']
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (!rolePattern.test(windowText) && !extractEmails(windowText).length) {
      continue;
    }

    const role = (windowText.match(rolePattern) || [''])[0];
    const names = windowText.match(/\b[A-ZÀ-ÖØ-Þ][a-zà-öø-ÿ'’-]{2,}(?:\s+(?:van|de|den|der|het|ter|ten|op|aan|du|la|le|von|of))?(?:\s+[A-ZÀ-ÖØ-Þ][a-zà-öø-ÿ'’-]{2,}){1,3}\b/g) || [];
    const email = nearbyEmailForLine(windowText, emails);
    const fallbackName = email ? nameFromEmailLocal(email.replace(/@.+$/, '')) : '';

    for (const rawName of [...names, fallbackName].filter(Boolean)) {
      const name = cleanContactName(rawName);
      if (!looksLikePersonName(name) || rolePattern.test(name)) {
        continue;
      }

      const guesses = emailGuessesForName(name, domain, emailPattern);
      contacts.push({
        name,
        role,
        source_text: windowText,
        email_guess: email || guesses[0] || '',
        phone: extractPhones(windowText)[0] || '',
        source_type: role ? 'role_context' : 'email_context',
        relevance_score: contactRelevanceScore({ name, role, source_text: windowText, email_guess: email || guesses[0] || '' }),
      });
    }
  }

  return uniqueManagementContacts(contacts, 20);
}

function contactsFromLinkedInPersonLinks(links, companyName = '') {
  const contacts = [];

  for (const link of links) {
    if (!isLikelyLinkedInPersonUrl(link.url)) {
      continue;
    }

    const linkText = cleanContactName(link.text || '');
    let name = looksLikePersonName(linkText) ? linkText : '';

    if (!name) {
      const match = String(link.url || '').match(/linkedin\.com\/(?:in|pub)\/([^/?#]+)/i);
      if (match) {
        const slugName = cleanContactName(rawurldecodeSafe(match[1]).replace(/[-_]+/g, ' '));
        if (looksLikePersonName(slugName)) {
          name = slugName;
        }
      }
    }

    if (!name) {
      continue;
    }

    contacts.push({
      name,
      role: '',
      source_text: `${companyName} LinkedIn person`,
      email_guess: '',
      linkedin_url: link.url,
      source_type: 'linkedin_person',
      relevance_score: contactRelevanceScore({ name, linkedin_url: link.url, source_text: companyName }),
    });
  }

  return uniqueManagementContacts(contacts, 20);
}

function rawurldecodeSafe(value) {
  try {
    return decodeURIComponent(String(value || ''));
  } catch {
    return String(value || '');
  }
}

function personNameFromUrl(url) {
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split('/').filter(Boolean);
    const slug = parts[parts.length - 1] || '';
    const context = parts.slice(0, -1).join('/');

    if (!/(medewerker|medewerkers|team|people|persoon|author|blog)/i.test(context) || !slug) {
      return '';
    }

    const name = cleanContactName(rawurldecodeSafe(slug).replace(/[-_]+/g, ' '));
    return looksLikePersonName(name) ? name : '';
  } catch {
    return '';
  }
}

function personNameFromPage(url, html, readableText) {
  const urlName = personNameFromUrl(url);
  if (urlName) {
    return urlName;
  }

  const introMatch = String(readableText || '').match(/\b(?:mijn naam is|ik ben|meet the team:?)\s+([A-ZÀ-ÖØ-Þ][\p{L}'’-]+(?:\s+[A-ZÀ-ÖØ-Þ][\p{L}'’-]+){1,3})/iu);
  if (introMatch && looksLikePersonName(introMatch[1])) {
    return cleanContactName(introMatch[1]);
  }

  const title = titleFromHtml(html)
    .replace(/\s*[-–|:]\s*.*$/g, '')
    .trim();
  return looksLikePersonName(title) ? cleanContactName(title) : '';
}

function profilePhoneFromText(text) {
  const value = String(text || '');
  const direct = value.match(/telefoon(?:nummer)?\s*:?\s*((?:\+31|0031|0)[\d\s().-]{8,})/i);
  if (direct) {
    return direct[1].replace(/\s+/g, ' ').trim();
  }

  const phones = extractPhones(value);
  const mobile = phones.find((phone) => /(?:\+31|0031|0)\s*6/i.test(phone.replace(/[().-]/g, ' ')));
  return mobile || phones[0] || '';
}

function roleFromProfileText(text) {
  const rolePattern = relevantRolePattern('i');
  const lines = String(text || '')
    .split(/\n|\r|[.!?]/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  for (const line of lines) {
    const match = line.match(rolePattern);
    if (match) {
      return match[0];
    }
  }

  return '';
}

function contactsFromProfilePage({ url, html, readableText, links, domain, emailPattern, companyName }) {
  const name = personNameFromPage(url, html, readableText);
  if (!name) {
    return [];
  }

  const pageEmails = extractEmails(readableText);
  const guesses = emailGuessesForName(name, domain, emailPattern);
  const email = bestEmailForContact({ name, email_guess: guesses[0] || '' }, pageEmails);
  const linkedin = (links || []).find((link) => isLikelyLinkedInPersonUrl(link.url));
  const phone = profilePhoneFromText(readableText);
  const role = roleFromProfileText(readableText);

  return uniqueManagementContacts([{
    name,
    role,
    source_text: `${companyName || ''} ${url} ${String(readableText || '').slice(0, 300)}`.trim(),
    email_guess: email,
    phone,
    linkedin_url: linkedin ? linkedin.url : '',
    source_type: 'person_profile',
    relevance_score: contactRelevanceScore({
      name,
      role,
      email_guess: email,
      phone,
      linkedin_url: linkedin ? linkedin.url : '',
      source_text: readableText,
    }),
  }], 1);
}

function mergeContactDetails(contacts) {
  const merged = [];
  const seen = new Map();

  for (const contact of contacts) {
    if (!contact || isGenericContactLabel(contact)) {
      continue;
    }

    const cleaned = {
      ...contact,
      name: cleanContactName(contact.name || ''),
      role: String(contact.role || '').trim(),
      email_guess: String(contact.email_guess || contact.email || '').trim().toLowerCase(),
      phone: String(contact.phone || '').trim(),
      linkedin_url: String(contact.linkedin_url || '').trim(),
      source_text: String(contact.source_text || '').trim(),
      source_type: String(contact.source_type || '').trim(),
    };
    cleaned.relevance_score = Number.isFinite(Number(contact.relevance_score))
      ? Number(contact.relevance_score)
      : contactRelevanceScore(cleaned);

    const nameKey = normalizeContactNameKey(cleaned.name);
    const emailKey = cleaned.email_guess;
    const key = emailKey || nameKey;
    if (!key) {
      continue;
    }

    const existingIndex = seen.has(key)
      ? seen.get(key)
      : merged.findIndex((item) => {
        const itemNameKey = normalizeContactNameKey(item.name);
        return nameKey && itemNameKey && (itemNameKey === nameKey || itemNameKey.includes(nameKey) || nameKey.includes(itemNameKey));
      });

    if (existingIndex >= 0) {
      const existing = merged[existingIndex];
      existing.role ||= cleaned.role;
      existing.email_guess ||= cleaned.email_guess;
      existing.phone ||= cleaned.phone;
      existing.linkedin_url ||= cleaned.linkedin_url;
      existing.source_type ||= cleaned.source_type;
      existing.source_text = [existing.source_text, cleaned.source_text].filter(Boolean).join(' | ').slice(0, 800);
      existing.relevance_score = Math.max(existing.relevance_score || 0, cleaned.relevance_score || 0);
      seen.set(existing.email_guess || normalizeContactNameKey(existing.name), existingIndex);
      continue;
    }

    seen.set(key, merged.length);
    merged.push(cleaned);
  }

  return uniqueManagementContacts(merged, 20);
}

function extractManagementContacts(text, domain, emailPattern = '') {
  const rolePattern = rolePatternSource;
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
      const cleanedName = cleanContactName(name);
      if (new RegExp(rolePattern, 'i').test(cleanedName)) {
        continue;
      }
      if (!looksLikePersonName(cleanedName)) {
        continue;
      }

      const emailGuesses = emailGuessesForName(cleanedName, domain, emailPattern);
      contacts.push({
        name: cleanedName,
        role,
        source_text: line,
        email_guess: emailGuesses[0] || '',
      });
    }
  }

  return uniqueManagementContacts(contacts, 8);
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
    const likelyName = cleanContactName(names.find((name) => !new RegExp(rolePattern, 'i').test(name) && looksLikePersonName(name)) || '');
    const guesses = likelyName ? emailGuessesForName(likelyName, domain, emailPattern) : [];

    if (!likelyName) {
      continue;
    }

    signals.push({
      name: likelyName,
      role,
      source_text: chunk,
      email_guess: guesses[0] || '',
    });
  }

  return uniqueManagementContacts(signals, 10);
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

function searchResultUrlsFromHtml(html, baseUrl) {
  const urls = [];
  const hrefRegex = /<a\b[^>]*href=["']([^"']+)["'][^>]*>/gi;
  let match;

  while ((match = hrefRegex.exec(String(html || ''))) !== null) {
    let href = decodeEntities(match[1]);
    try {
      const parsed = new URL(href, baseUrl);
      const redirected = parsed.searchParams.get('uddg') || parsed.searchParams.get('q') || parsed.searchParams.get('url');
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
    if (!host || /(^|\.)((duckduckgo|google|bing)\.[a-z.]+)$/i.test(host)) {
      continue;
    }

    urls.push(href);
  }

  return urls.filter((url, index, all) => all.findIndex((candidate) => candidate === url) === index).slice(0, 8);
}

async function searchResultUrls(query, timeoutSeconds, fetched, errors, pageCache, options = {}) {
  if (options.enabled === false) {
    return [];
  }

  const encodedQuery = encodeURIComponent(query);
  const searchUrls = [
    `https://www.google.com/search?q=${encodedQuery}&num=10`,
    `https://duckduckgo.com/html/?q=${encodedQuery}`,
    `https://www.bing.com/search?q=${encodedQuery}`,
  ];
  const results = [];

  for (const searchUrl of searchUrls) {
    const searchPage = await fetchResearchPage(searchUrl, timeoutSeconds, fetched, errors, pageCache, { silent: true });
    if (!searchPage) {
      continue;
    }

    for (const url of searchResultUrlsFromHtml(searchPage.body, searchUrl)) {
      if (!results.includes(url)) {
        results.push(url);
      }
    }

    if (results.length >= (options.limit || 8)) {
      break;
    }
  }

  return results.slice(0, options.limit || 8);
}

async function discoverWebsiteBySearch(companyName, timeoutSeconds, fetched, errors, pageCache, options = {}) {
  if (options.enabled === false) {
    return '';
  }

  const resultUrls = await searchResultUrls(`"${companyName}" bedrijf website`, timeoutSeconds, fetched, errors, pageCache, {
    enabled: options.enabled,
    limit: 8,
  });
  for (const url of resultUrls.slice(0, 5)) {
    if (isSocialOrDirectoryHost(hostWithoutWww(url))) {
      continue;
    }

    const page = await fetchResearchPage(url, timeoutSeconds, fetched, errors, pageCache, { silent: true });
    if (page && pageMatchesCompany(page, companyName)) {
      return page.url;
    }
  }

  return '';
}

async function discoverSocialLinksBySearch(companyName, timeoutSeconds, fetched, errors, pageCache, options = {}) {
  if (options.enabled === false) {
    return [];
  }

  const queries = [
    `site:linkedin.com/company "${companyName}"`,
    `site:linkedin.com/school "${companyName}"`,
    `"${companyName}" LinkedIn company`,
    `"${companyName}" Facebook Instagram`,
  ];
  const links = [];

  for (const query of queries) {
    const resultUrls = await searchResultUrls(query, timeoutSeconds, fetched, errors, pageCache, {
      enabled: options.enabled,
      limit: 6,
    });

    for (const url of resultUrls) {
      const haystack = url.toLowerCase();
      if (!/(linkedin\.com|facebook\.com|instagram\.com|x\.com|twitter\.com|youtube\.com|tiktok\.com)/.test(haystack)) {
        continue;
      }
      if (/linkedin\.com\//i.test(haystack) && !isLikelyLinkedInCompanyUrl(url)) {
        continue;
      }

      links.push({
        url,
        text: companyName,
      });
    }
  }

  return [
    ...linkedinCompanyLinks(links, companyName),
    ...classifyEnrichmentLinks(links).filter((link) => !/linkedin\.com/i.test(link.url)),
  ].filter((link, index, all) => all.findIndex((candidate) => normalizedLinkKey(candidate.url) === normalizedLinkKey(link.url)) === index);
}

async function discoverPersonLinkedInUrl(personName, companyName, timeoutSeconds, fetched, errors, pageCache, options = {}) {
  if (options.enabled === false || !personName) {
    return '';
  }

  const resultUrls = await searchResultUrls(`"${personName}" "${companyName}" LinkedIn`, timeoutSeconds, fetched, errors, pageCache, {
    enabled: options.enabled,
    limit: 5,
  });
  const personKey = normalizeContactNameKey(personName);

  for (const url of resultUrls) {
    const match = String(url).match(/linkedin\.com\/(?:in|pub)\/([^/?#]+)/i);
    if (!match) {
      continue;
    }

    const slugKey = normalizeContactNameKey(match[1].replace(/[-_]+/g, ' '));
    if (!personKey || !slugKey || slugKey.includes(personKey) || personKey.includes(slugKey)) {
      return url;
    }
  }

  return '';
}

function scoreLead(lead, criteria) {
  let score = 25;
  const reasons = [];
  const contacts = Array.isArray(lead.management_contacts) ? lead.management_contacts : [];
  const opportunities = Array.isArray(lead.potential_opportunities) ? lead.potential_opportunities : [];
  const links = Array.isArray(lead.social_links) ? lead.social_links : (Array.isArray(lead.enrichment_links) ? lead.enrichment_links : []);
  const haystack = [
    lead.company_name,
    lead.description,
    lead.industry,
    lead.city || '',
    lead.province || '',
    lead.address || '',
    opportunities.join(' '),
    contacts.map((contact) => `${contact.name || ''} ${contact.role || ''} ${contact.source_text || ''}`).join(' '),
  ].join(' ').toLowerCase();

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
  if (lead.city || lead.address) {
    score += 5;
    reasons.push('locatie/adres gevonden');
  }
  if (links.some((link) => /linkedin\.com\/(?:company|school|showcase)\//i.test(String(link.url || '')))) {
    score += 10;
    reasons.push('LinkedIn bedrijfspagina gevonden');
  }
  if (contacts.length > 0) {
    score += Math.min(20, contacts.length * 6);
    reasons.push(`${contacts.length} relevante contactpersoon-signalen`);
  }
  if (opportunities.length > 0) {
    score += Math.min(12, opportunities.length * 4);
    reasons.push(`kansen: ${opportunities.slice(0, 3).join(', ')}`);
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
  if (minEmployees > 0 && lead.employee_count_min !== null && lead.employee_count_min !== undefined) {
    if (lead.employee_count_min >= minEmployees || (lead.employee_count_max !== null && lead.employee_count_max >= minEmployees)) {
      score += 15;
      reasons.push(`medewerkers >= ${minEmployees}`);
    } else {
      score -= 15;
      reasons.push(`medewerkers < ${minEmployees}`);
    }
  }

  if (lead.employee_count_min === null || lead.employee_count_min === undefined) {
    reasons.push('medewerkers onbekend');
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
    industry: inferIndustry(`${row.company_name} ${descriptionParts.join(' ')}`, criteria) || matchedBranches[0] || '',
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

function buildLeadFromCompanyName({ companyName, sourceName, criteria }) {
  const haystack = `${companyName} ${sourceName || ''}`.toLowerCase();
  const matchedBranches = findMatchingTerms(criteria.branches, haystack);
  const matchedKeywords = findMatchingTerms(criteria.keywords, haystack);
  const excluded = findMatchingTerms(criteria.exclude_keywords, haystack);
  let criteriaScore = 45;
  const reasons = ['bedrijfsnaam uit handmatige lijst'];

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
    company_name: companyName,
    website: '',
    industry: matchedBranches[0] || '',
    description: `Bedrijf aangeleverd via ${sourceName || 'handmatige bedrijfsnamenlijst'}.`,
    criteria_score: Math.max(0, Math.min(100, criteriaScore)),
    criteria_reason: reasons.join('; '),
    enrichment_links: [],
    source_url: '',
    raw_payload: { company_name: companyName, source_type: 'company_list' },
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

function runItemFromErrorMessage(error) {
  const value = String(error || '');
  const urlMatch = value.match(/https?:\/\/\S+/);
  const httpMatch = value.match(/HTTP\s+(\d{3})/i);

  return {
    detail_url: urlMatch ? urlMatch[0] : '',
    raw_title: urlMatch ? urlMatch[0] : 'Scraper fout',
    status: 'failed',
    http_code: httpMatch ? Number(httpMatch[1]) : null,
    error_text: value,
  };
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function cleanBusinessDescriptionText(text, companyName = '') {
  const companyWords = String(companyName || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length >= 4);
  const businessWords = /\b(subsidie|subsidies|innovatie|software|ontwikkeling|diensten|service|bedrijf|organisatie|oplossingen|advies|consultancy|cloud|data|security|saas|branche|technologie|projecten|klanten|markt|expertise)\b/i;
  const navWords = /\b(home|menu|blog|werken bij|contact|mijn hsl|over ons|algemene voorwaarden|privacy|cookies|login|nieuwsbrief|read more|lees meer)\b/i;
  const navWordsGlobal = /\b(home|menu|blog|werken bij|contact|mijn hsl|over ons|algemene voorwaarden|privacy|cookies|login|nieuwsbrief|read more|lees meer)\b/gi;
  let prepared = String(text || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^(?:home|subsidies|diensten|over ons|blog|werken bij|contact|mijn hsl)\b(?:\s+|$)/i, '')
    .replace(/^(?:home|subsidies|diensten|over ons|blog|werken bij|contact|mijn hsl)\b(?:\s+|$)/i, '')
    .replace(/^(?:home|subsidies|diensten|over ons|blog|werken bij|contact|mijn hsl)\b(?:\s+|$)/i, '')
    .replace(/^(?:home|subsidies|diensten|over ons|blog|werken bij|contact|mijn hsl)\b(?:\s+|$)/i, '')
    .replace(/^(?:home|subsidies|diensten|over ons|blog|werken bij|contact|mijn hsl)\b(?:\s+|$)/i, '')
    .replace(/^(?:home|subsidies|diensten|over ons|blog|werken bij|contact|mijn hsl)\b(?:\s+|$)/i, '')
    .replace(/^(?:home|subsidies|diensten|over ons|blog|werken bij|contact|mijn hsl)\b(?:\s+|$)/i, '')
    .replace(/^(?:home|subsidies|diensten|over ons|blog|werken bij|contact|mijn hsl)\b(?:\s+|$)/i, '');

  const companyPattern = escapeRegExp(companyName);
  if (companyPattern) {
    prepared = prepared.replace(new RegExp(`^(?:${companyPattern}\\s*){1,3}`, 'i'), '');
  }

  const chunks = prepared
    .split(/(?<=[.!?])\s+|(?:\s{2,})|[|•]/)
    .map((chunk) => removeContactNoise(chunk).trim())
    .filter((chunk) => chunk.length >= 45 && chunk.length <= 360)
    .filter((chunk) => !/^home\b/i.test(chunk))
    .filter((chunk) => {
      const lower = chunk.toLowerCase();
      const navHits = (lower.match(navWordsGlobal) || []).length;
      const businessHit = businessWords.test(chunk) || companyWords.some((word) => lower.includes(word));
      return businessHit && navHits <= 2;
    });

  const unique = [];
  for (const chunk of chunks) {
    const key = chunk.toLowerCase().replace(/[^a-z0-9]+/g, ' ').slice(0, 120);
    if (!unique.some((item) => item.key === key || item.text.includes(chunk) || chunk.includes(item.text))) {
      unique.push({ key, text: chunk });
    }
    if (unique.length >= 3) {
      break;
    }
  }

  return unique.map((item) => item.text).join(' ').slice(0, 900);
}

function businessDescriptionFromHtml(html, text, companyName) {
  const meta = metaDescriptionFromHtml(html);
  const cleanedMeta = cleanBusinessDescriptionText(meta, companyName);
  if (cleanedMeta) {
    return cleanedMeta;
  }

  return cleanBusinessDescriptionText(text, companyName) || meta || String(text || '').slice(0, 700);
}

function inferIndustry(text, criteria = {}) {
  const haystack = normalizeLooseLabel(text);
  const prioritized = [
    ['Subsidieadvies / consultancy', /\b(subsidie|subsidies|wbso|s o|innovatiebox|subsidieadvies|subsidieadviseur|subsidieconsultant|formule naar innovatie)\b/i],
    ['Consultancy / advies', /\b(consultancy|advies|adviseur|consultant|begeleiding|sparren)\b/i],
    ['Duurzaamheid / energie', /\b(duurzaam|verduurzaming|energie|co2|circular|circulair|klimaat)\b/i],
    ['ICT / software', /\b(software|saas|cloud|cybersecurity|ict|it|data|erp|platform)\b/i],
    ['Maakindustrie', /\b(maakindustrie|productie|machinebouw|techniek|hardware|fysieke ontwikkeling)\b/i],
  ];

  for (const [label, pattern] of prioritized) {
    if (pattern.test(haystack)) {
      return label;
    }
  }

  const branches = findMatchingTerms(criteria.branches, haystack);
  return branches[0] || '';
}

function buildLeadFromPage({ sourceName, url, html, config, criteria }) {
  const text = stripTags(html);
  const hrefContact = extractHrefContactData(html);
  const schemaOrg = organizationDataFromHtml(html);
  const emails = [...new Set([...extractEmails(text), ...hrefContact.emails, ...extractEmails(schemaOrg.email)])];
  const phones = [...new Set([...extractPhones(text), ...hrefContact.phones, ...extractPhones(schemaOrg.phone)])];
  const location = extractLocationData(text);
  const links = extractLinks(html, url);
  const companySelector = selectorConfig(config, ['detail', 'company_name'], 'h1, title');
  const company = cleanCompanyName(schemaOrg.name || extractBySelector(html, companySelector.selector, titleFromHtml(html)) || sourceName || new URL(url).hostname.replace(/^www\./, ''));
  const description = cleanBusinessDescriptionText(schemaOrg.description, company) || businessDescriptionFromHtml(html, text, company);
  const employeeRange = extractEmployeeRange(text);
  const sAndOEmployees = extractSAndOEmployees(text);
  const potentialOpportunities = extractPotentialOpportunities(text, criteria);
  const industry = inferIndustry(`${company} ${description} ${text.slice(0, 6000)}`, criteria);
  const socialLinks = [
    ...linkedinCompanyLinks([...links, ...schemaOrg.same_as], company),
    ...classifyEnrichmentLinks([...links, ...schemaOrg.same_as]).filter((link) => ['linkedin', 'social'].includes(link.link_type)),
  ].filter((link, index, all) => all.findIndex((candidate) => normalizedLinkKey(candidate.url) === normalizedLinkKey(link.url)) === index);
  const emailHint = emailPatternHint(criteria.email_pattern_example, url);
  const scored = scoreLead({
    company_name: company,
    website: url,
    email: emails[0] || '',
    phone: phones[0] || '',
    address: location.address,
    city: location.city,
    province: location.province,
    country: location.country,
    description,
    industry,
    employee_count_min: employeeRange.min,
    employee_count_max: employeeRange.max,
  }, criteria);

  return {
    company_name: company,
    website: url,
    email: emails[0] || '',
    phone: phones[0] || '',
    address: schemaOrg.address || location.address,
    postcode: schemaOrg.postcode || location.postcode,
    city: schemaOrg.city || location.city,
    province: location.province,
    country: schemaOrg.country || location.country,
    description,
    industry,
    employee_count_text: employeeRange.text,
    employee_count_min: employeeRange.min,
    employee_count_max: employeeRange.max,
    s_and_o_employees: sAndOEmployees,
    potential_opportunities: potentialOpportunities,
    criteria_score: scored.score,
    criteria_reason: emailHint ? `${scored.reason}; e-mailpatroon hint: ${emailHint}` : scored.reason,
    enrichment_links: socialLinks,
    social_links: socialLinks,
    source_url: url,
    status: 'new',
  };
}

function leadQualityReason(lead) {
  const companyName = cleanCompanyName(lead.company_name || '');
  if (!looksLikeCompanyName(companyName)) {
    return 'bedrijfsnaam lijkt navigatie, categorie of ruis';
  }

  const websiteHost = lead.website ? hostWithoutWww(lead.website) : '';
  const sourceHost = lead.source_url ? hostWithoutWww(lead.source_url) : '';
  const hasUsefulContact = Boolean(lead.email || lead.phone || lead.city || lead.province || lead.address);
  const hasUsefulContext = Boolean(lead.website || lead.description || lead.industry || (Array.isArray(lead.enrichment_links) && lead.enrichment_links.length));

  if (!hasUsefulContext && !hasUsefulContact) {
    return 'te weinig bruikbare bedrijfsgegevens gevonden';
  }

  if (websiteHost && sourceHost && websiteHost === sourceHost && NON_COMPANY_LABELS.has(normalizeLooseLabel(companyName))) {
    return 'bronmenu-item op hetzelfde domein';
  }

  return '';
}

function normalizeLeadForOutput(lead) {
  const cleaned = {
    ...lead,
    company_name: cleanCompanyName(lead.company_name || ''),
  };

  if (cleaned.city && !looksLikeDutchCity(cleaned.city)) {
    cleaned.city = '';
  }

  if (Array.isArray(cleaned.management_contacts)) {
    cleaned.management_contacts = uniqueManagementContacts(cleaned.management_contacts, 12);
  }

  return cleaned;
}

async function enrichLeadWithWaterfall({ lead, payload, config, criteria, timeoutSeconds, fetched, errors, onProgress, pageCache }) {
  const sourceHost = hostWithoutWww(payload.list_url);
  const listUrl = payload.list_url || '';
  const researchPages = [];
  const allLinks = [];
  const allTexts = [];
  const allPageContacts = [];
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
    const readableLines = htmlToReadableLines(page.body);
    const links = extractLinks(page.body, page.url);
    const hrefContact = extractHrefContactData(page.body);
    const schemaOrg = organizationDataFromHtml(page.body);
    const pageDomain = hostWithoutWww(website || page.url);
    const schemaPeople = personDataFromHtml(page.body, pageDomain, emailPattern);
    const profileContacts = contactsFromProfilePage({
      url: page.url,
      html: page.body,
      readableText: readableLines || text,
      links,
      domain: pageDomain,
      emailPattern,
      companyName: lead.company_name,
    });
    const schemaText = [
      schemaOrg.name,
      schemaOrg.email,
      schemaOrg.phone,
      schemaOrg.address,
      schemaOrg.city,
      schemaOrg.postcode,
      schemaOrg.country,
      schemaOrg.description,
    ].filter(Boolean).join(' ');
    researchPages.push({ url: page.url, link_type: linkType, title: title || titleFromHtml(page.body) || linkType, text: readableLines || text });
    allTexts.push([readableLines, text, schemaText, hrefContact.emails.join(' '), hrefContact.phones.join(' ')].filter(Boolean).join('\n'));
    allLinks.push(...links, ...schemaOrg.same_as);
    allLinks.push(...schemaPeople.filter((person) => person.linkedin_url).map((person) => ({
      url: person.linkedin_url,
      text: person.name,
    })));
    for (const person of schemaPeople) {
      allTexts.push(`${person.name} ${person.role} ${person.email_guess} ${person.phone} ${person.linkedin_url}`.trim());
    }
    allPageContacts.push(...schemaPeople, ...profileContacts);
    return { page, text, links };
  }

  const sourceUrlIsListPage = lead.source_url && listUrl && urlsPointToSamePage(lead.source_url, listUrl);
  if (lead.source_url && !sourceUrlIsListPage) {
    await addPage(lead.source_url, 'source', lead.company_name);
  }

  let website = lead.website || '';
  if (!website || lead.needs_website_discovery) {
    await onProgress(`Waterfall ${lead.company_name}: bedrijfswebsite zoeken via bronlinks, domeinkandidaten en zoekresultaten.`);
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
    await onProgress(`Waterfall ${lead.company_name}: website gevonden (${website}). Contact-, over-ons-, team- en werken-bij-pagina's worden onderzocht.`);
    const websitePage = await addPage(website, 'website', lead.company_name);
    if (websitePage) {
      const seenUrls = new Set(researchPages.map((page) => normalizedCrawlUrl(page.url)).filter(Boolean));
      const queue = websiteCrawlCandidates(websitePage.links, websitePage.page.url, seenUrls, websiteCrawlMaxPages);
      for (const fixedUrl of knownResearchPathUrls(websitePage.page.url)) {
        const normalized = normalizedCrawlUrl(fixedUrl);
        if (normalized && !seenUrls.has(normalized) && !queue.some((link) => link.url === normalized)) {
          queue.push({ url: normalized, text: normalized, score: 45 });
        }
      }

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
  const location = extractLocationData(combinedText);
  const employeeRange = extractEmployeeRange(combinedText);
  const sAndOEmployees = extractSAndOEmployees(combinedText);
  const potentialOpportunities = extractPotentialOpportunities(`${lead.description || ''}\n${combinedText}`, criteria);
  const inferredIndustry = inferIndustry(`${lead.company_name} ${lead.description || ''} ${combinedText}`, criteria);
  const domain = website ? hostWithoutWww(website) : '';
  let managementContacts = mergeContactDetails([
    ...allPageContacts,
    ...extractRelevantContactsFromText(combinedText, domain, emailPattern),
    ...extractManagementContacts(combinedText, domain, emailPattern),
    ...extractRoleSignals(combinedText, domain, emailPattern),
    ...contactsFromEmails(emails, domain),
    ...contactsFromLinkedInPersonLinks(allLinks, lead.company_name),
  ]);
  managementContacts = managementContacts.map((contact) => ({
    ...contact,
    email_guess: bestEmailForContact(contact, emails) || contact.email_guess,
  }));
  managementContacts = managementContacts.map((contact) => ({
    ...contact,
    relevance_score: contactRelevanceScore(contact),
  }));
  managementContacts = mergeContactDetails(managementContacts).slice(0, 12);

  const searchEnabled = config.enable_search_discovery !== false;
  await onProgress(`Waterfall ${lead.company_name}: LinkedIn bedrijfspagina en publieke persoonsprofielen zoeken.`);
  const searchedSocialLinks = await discoverSocialLinksBySearch(lead.company_name, timeoutSeconds, fetched, errors, pageCache, {
    enabled: searchEnabled,
  });
  for (let index = 0; index < Math.min(managementContacts.length, 8); index++) {
    if (managementContacts[index].linkedin_url) {
      continue;
    }

    const linkedinUrl = await discoverPersonLinkedInUrl(managementContacts[index].name, lead.company_name, timeoutSeconds, fetched, errors, pageCache, {
      enabled: searchEnabled,
    });
    if (linkedinUrl) {
      managementContacts[index].linkedin_url = linkedinUrl;
    }
  }

  const emailGuesses = [
    ...managementContacts.map((contact) => contact.email_guess).filter(Boolean),
    ...(website ? [`info@${hostWithoutWww(website)}`, `sales@${hostWithoutWww(website)}`] : []),
  ].filter((email, index, all) => email && all.indexOf(email) === index).slice(0, 12);
  const classifiedLinks = [
    ...classifyEnrichmentLinks(allLinks),
    ...searchedSocialLinks,
  ];
  const socialLinks = [
    ...(Array.isArray(lead.enrichment_links) ? lead.enrichment_links : []),
    ...classifiedLinks,
  ]
    .filter((link) => ['linkedin', 'social'].includes(link.link_type))
    .filter((link) => !/linkedin\.com\/(in|pub)\//i.test(link.url))
    .filter((link, index, all) => link.url && all.findIndex((candidate) => normalizedLinkKey(candidate.url) === normalizedLinkKey(link.url)) === index)
    .slice(0, 20);
  const enrichmentLinks = socialLinks;
  const descriptionParts = [
    cleanBusinessDescriptionText(lead.description, lead.company_name),
    cleanBusinessDescriptionText(combinedText, lead.company_name),
  ].filter(Boolean).filter((part, index, all) => all.findIndex((candidate) => candidate.toLowerCase() === part.toLowerCase()) === index);

  const enriched = {
    ...lead,
    website: website || lead.website,
    email: lead.email || emails[0] || '',
    phone: lead.phone || phones[0] || '',
    address: lead.address || location.address || '',
    postcode: lead.postcode || location.postcode || '',
    city: lead.city || location.city || '',
    province: lead.province || location.province || '',
    country: lead.country || location.country || '',
    industry: inferredIndustry || lead.industry || '',
    description: descriptionParts.join('\n\n').slice(0, 1800) || lead.description,
    employee_count_text: lead.employee_count_text || employeeRange.text,
    employee_count_min: lead.employee_count_min ?? employeeRange.min,
    employee_count_max: lead.employee_count_max ?? employeeRange.max,
    s_and_o_employees: lead.s_and_o_employees || sAndOEmployees,
    potential_opportunities: Array.isArray(lead.potential_opportunities) && lead.potential_opportunities.length
      ? lead.potential_opportunities
      : potentialOpportunities,
    enrichment_links: enrichmentLinks,
    all_emails: emails.slice(0, 30),
    all_phones: phones.slice(0, 30),
    social_links: socialLinks,
    management_contacts: managementContacts,
    email_guesses: emailGuesses,
    research_pages_count: researchPages.length,
    website_crawl_max_pages: websiteCrawlMaxPages,
  };

  const scored = scoreLead(enriched, criteria);
  const emailHint = website ? emailPatternHint(emailPattern, website) : '';
  enriched.criteria_score = scored.score;
  enriched.criteria_reason = [
    scored.reason,
    emailHint ? `e-mailpatroon hint: ${emailHint}` : '',
    managementContacts.length ? 'leiding/contactpersoon-signalen gevonden' : '',
    socialLinks.some((link) => /linkedin\.com/i.test(link.url)) ? 'LinkedIn bedrijfspagina gevonden' : '',
  ]
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
  const fetched = [];
  const leads = [];
  const errors = [];
  let reportedErrorCount = 0;
  const pageCache = new Map();

  function pendingErrorRunItems() {
    const newErrors = errors.slice(reportedErrorCount);
    reportedErrorCount = errors.length;
    return newErrors.map((error) => runItemFromErrorMessage(error));
  }

  async function progress(message, extra = {}) {
    const cleanExtra = { ...extra };
    if (Array.isArray(cleanExtra.leads)) {
      cleanExtra.leads = cleanExtra.leads
        .map((lead) => normalizeLeadForOutput(lead))
        .filter((lead) => leadQualityReason(lead) === '');
    }

    await onProgress({
      message,
      stats: {
        pages_fetched: fetched.length,
        items_found: leads.length,
        errors_count: errors.length,
      },
      ...cleanExtra,
    });
  }

  let listingLike = false;

  if (sourceTypeIsCompanyList(sourceType)) {
    const companyNames = companyNamesFromConfig(config);
    if (companyNames.length === 0) {
      return {
        success: false,
        message: 'Geen bruikbare bedrijfsnamen gevonden in deze bron.',
        stats: {
          pages_fetched: 0,
          items_found: 0,
          errors_count: 1,
        },
        leads: [],
        run_items: [{
          raw_title: payload.source_name || 'Bedrijfsnamenlijst',
          status: 'failed',
          error_text: 'Vul minimaal één bedrijfsnaam in.',
        }],
      };
    }

    for (const companyName of companyNames) {
      leads.push(buildLeadFromCompanyName({
        companyName,
        sourceName: payload.source_name,
        criteria,
      }));
    }

    await progress(`${leads.length} bedrijfsnamen uit de lijst geladen. Per bedrijf wordt nu website, socials en contactinformatie gezocht.`, {
      leads: leads.slice(),
    });
  } else {
    const startUrl = await assertPublicUrl(payload.list_url);
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
      const message = `${sourceTypeIsSingleWebsite(sourceType) ? 'Website' : 'Lijstpagina'} gaf HTTP ${first.status}.`;
      return {
        success: false,
        message,
        stats: {
          pages_fetched: 1,
          items_found: 0,
          errors_count: 1,
        },
        leads: [],
        run_items: [{
          detail_url: first.url,
          raw_title: payload.source_name || first.url,
          status: 'failed',
          http_code: first.status,
          error_text: message,
        }],
      };
    }

    const baseUrl = payload.base_url || startUrl.toString();
    const baseHost = new URL(baseUrl).hostname.replace(/^www\./, '');
    const isSingleWebsiteSource = sourceTypeIsSingleWebsite(sourceType);
    const tableRows = isSingleWebsiteSource ? [] : extractTableRows(first.body, first.url);
    listingLike = !isSingleWebsiteSource && pageLooksLikeListing(first.body, sourceType);
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
      await progress('Bedrijfswebsite als één lead aangemaakt. Interne pagina\'s worden aan deze lead toegevoegd.', {
        leads: leads.slice(),
      });
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
      await progress(`${leads.length} kandidaat-leads uit ${tableRows.length > 0 ? 'tabel' : 'lijst'} gevonden. Ze worden alvast opgeslagen voordat de verrijking start.`, {
        leads: leads.slice(),
      });
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
      await progress('Hoofdpagina verwerkt. De eerste kandidaat-lead wordt alvast opgeslagen.', {
        leads: leads.slice(),
      });

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

        await progress(`${fetched.length} pagina's opgehaald, ${leads.length} kandidaat-leads gevonden.`, {
          leads: leads.slice(),
          run_items: pendingErrorRunItems(),
        });
      }
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
    await progress(`Waterfall verrijking: ${index + 1}/${Math.min(leads.length, researchLimit)} bedrijven onderzocht.`, {
      leads: [leads[index]],
      run_items: pendingErrorRunItems(),
    });
  }

  const cleanedLeads = leads
    .map((lead) => normalizeLeadForOutput(lead))
    .filter((lead) => leadQualityReason(lead) === '');

  const uniqueLeads = cleanedLeads.filter((lead, index, all) => {
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
    run_items: errors.map((error) => runItemFromErrorMessage(error)),
    config_used: {
      ...config,
      source_type: sourceType,
      detected_as_listing: listingLike,
    },
  };
}
