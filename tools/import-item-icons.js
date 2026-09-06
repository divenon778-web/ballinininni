#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PUBLIC_MEDIA = path.join(ROOT, 'public', '__external', 'cms-media.bloxflip.com', 'media');
const CATALOG_FILE = path.join(ROOT, 'data', 'item-catalog.json');
const htmlFile = path.resolve(process.argv[2] || path.join(ROOT, 'icons.html'));
const ALLOWED_HOST = 'cms-media.bloxflip.com';
const DATA_FILES = [
  'data/cases-seed.json',
  'data/community-cases-seed.json',
  'data/public-cases-docs.json',
  'data/community-cases-docs.json'
].map(file => path.join(ROOT, file));

function decodeHtml(value) {
  return String(value)
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&#([0-9]+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function slugify(value) {
  const slug = String(value).normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return slug || 'item';
}

function parseValue(value) {
  const n = Number(String(value).replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : 0;
}

function rarityFor(value) {
  if (value >= 100000) return 'blue';
  if (value >= 25000) return 'purple';
  if (value >= 5000) return 'pink';
  if (value >= 1000) return 'gold';
  if (value >= 100) return 'orange';
  return 'red';
}

function sourceInfo(source) {
  const url = new URL(decodeHtml(source));
  if (url.protocol !== 'https:' || url.hostname !== ALLOWED_HOST || !url.pathname.startsWith('/media/')) {
    throw new Error(`Unsupported asset URL: ${source}`);
  }
  // One saved card contains a stray encoded quote in front of an otherwise
  // valid filename. The same image also occurs later with the correct URL.
  const relative = decodeURIComponent(url.pathname.slice('/media/'.length)).replace(/^"+/, '');
  if (!relative || relative.includes('/') || relative === '.' || relative === '..') {
    throw new Error(`Unsafe asset filename: ${relative}`);
  }
  return {
    source: `https://${ALLOWED_HOST}/media/${encodeURIComponent(relative)}`,
    filename: relative,
    localUrl: `/__external/${ALLOWED_HOST}/media/${encodeURIComponent(relative)}`
  };
}

function parseItems(html) {
  const cards = [];
  const cardRe = /<img draggable="false" alt="Slot preview" src="([^"]+)"[^>]*>[\s\S]*?<p class="[^"]*caseTitle[^"]*">([\s\S]*?)<\/p>[\s\S]*?<h3 class="[^"]*caseSubtitle[^"]*">\s*([^<]+)/g;
  let match;
  while ((match = cardRe.exec(html))) {
    const media = sourceInfo(match[1]);
    const name = decodeHtml(match[2].replace(/<[^>]+>/g, '')).trim() || 'Item';
    const value = parseValue(decodeHtml(match[3]));
    const hash = crypto.createHash('sha256').update(`${media.source}\0${name}\0${value}`).digest('hex').slice(0, 16);
    cards.push({
      id: `local-item-${hash}`,
      slug: `${slugify(name)}-${hash.slice(0, 8)}`,
      name,
      value,
      rarity: rarityFor(value),
      icon: { url: media.localUrl },
      image: media.localUrl,
      filename: media.filename,
      _source: media.source
    });
  }
  if (!cards.length) throw new Error('No item cards were found in the supplied HTML');
  return cards;
}

function addProjectMedia(targets, value) {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) return value.forEach(item => addProjectMedia(targets, item));
  for (const child of Object.values(value)) {
    if (typeof child === 'string' && child.includes(`${ALLOWED_HOST}/media/`)) {
      const raw = child.slice(child.indexOf('/media/') + '/media/'.length);
      const filename = decodeURIComponent(raw.split(/[?#]/)[0]);
      if (!filename || filename.includes('/')) continue;
      const encoded = encodeURIComponent(filename).replace(/%2F/gi, '/');
      targets.set(filename, `https://${ALLOWED_HOST}/media/${encoded}`);
    } else addProjectMedia(targets, child);
  }
}

function validImage(buffer) {
  if (!buffer || buffer.length < 12) return false;
  const png = buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const jpeg = buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  const webp = buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP';
  return png || jpeg || webp;
}

async function fetchAsset(url, filename) {
  const destination = path.join(PUBLIC_MEDIA, filename);
  try {
    if (validImage(fs.readFileSync(destination))) return 'skipped';
  } catch {}

  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 45000);
    try {
      const response = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': 'BloxFlip-Local-Asset-Importer/1.0' } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const size = Number(response.headers.get('content-length') || 0);
      if (size > 12 * 1024 * 1024) throw new Error('asset exceeds 12 MiB');
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length > 12 * 1024 * 1024 || !validImage(buffer)) throw new Error('invalid image response');
      const temporary = `${destination}.part-${process.pid}`;
      fs.writeFileSync(temporary, buffer);
      fs.renameSync(temporary, destination);
      return 'downloaded';
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise(resolve => setTimeout(resolve, attempt * 500));
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`${filename}: ${lastError?.message || lastError}`);
}

async function main() {
  if (!fs.existsSync(htmlFile)) throw new Error(`Input HTML not found: ${htmlFile}`);
  fs.mkdirSync(PUBLIC_MEDIA, { recursive: true });
  const items = parseItems(fs.readFileSync(htmlFile, 'utf8'));
  const targets = new Map(items.map(item => [item.filename, item._source]));
  for (const file of DATA_FILES) {
    if (!fs.existsSync(file)) continue;
    addProjectMedia(targets, JSON.parse(fs.readFileSync(file, 'utf8')));
  }

  const queue = [...targets.entries()];
  let cursor = 0, downloaded = 0, skipped = 0;
  const errors = [];
  const workers = Array.from({ length: 16 }, async () => {
    while (cursor < queue.length) {
      const [filename, url] = queue[cursor++];
      try {
        const result = await fetchAsset(url, filename);
        if (result === 'downloaded') downloaded++; else skipped++;
        const complete = downloaded + skipped + errors.length;
        if (complete % 50 === 0 || complete === queue.length) {
          process.stdout.write(`\rAssets: ${complete}/${queue.length} (downloaded ${downloaded}, existing ${skipped}, errors ${errors.length})`);
        }
      } catch (error) {
        errors.push(error.message);
      }
    }
  });
  await Promise.all(workers);
  process.stdout.write('\n');

  const catalog = items.map(({ _source, filename, ...item }) => item);
  const temporary = `${CATALOG_FILE}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(catalog, null, 2)}\n`);
  fs.renameSync(temporary, CATALOG_FILE);
  console.log(`Catalog: ${catalog.length} items (${new Set(catalog.map(item => item.image)).size} unique images)`);
  if (errors.length) {
    console.error(errors.join('\n'));
    process.exitCode = 1;
  }
}

main().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
