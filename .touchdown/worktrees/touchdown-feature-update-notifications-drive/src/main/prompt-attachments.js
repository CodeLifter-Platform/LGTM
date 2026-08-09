/**
 * prompt-attachments — Pulls inline images out of Azure DevOps HTML
 * blobs (work item descriptions, repro steps, PR descriptions, comment
 * threads), downloads the ones hosted on the user's DevOps org, and
 * returns a substitution map so the caller can replace `<img>` tags with
 * filesystem-relative markers the agent can `Read`.
 *
 * Why this exists: agents that support vision (Claude, GPT-4o, etc.)
 * can interpret screenshots — but only if the image is on local disk.
 * Inline DevOps images live behind PAT-authenticated URLs the agent
 * can't fetch on its own, so we materialize them at clone time.
 *
 * Security: only URLs whose hostname matches the configured DevOps org
 * get downloaded. External CDNs (imgur, Slack files, screenshots
 * pasted from a public URL) are left as plain links — sending the PAT
 * to an arbitrary host would leak it.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ATTACHMENT_DIR_NAME = '.lgtm-attachments';

// Browsers and DevOps render inline images via <img src="...">. We also
// catch a couple of less-common variants (markdown ![alt](url) inside
// HTML, raw <a href="...">image attachment</a>) but keep the surface
// small to avoid false positives on, e.g., logos in email signatures.
const IMG_TAG_RE = /<img\b[^>]*?\bsrc\s*=\s*(['"])([^'"]+)\1[^>]*>/gi;
const IMG_ALT_RE = /\balt\s*=\s*(['"])([^'"]*)\1/i;

const EXT_BY_MIME = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'image/bmp': '.bmp',
};

function guessExtFromUrl(url) {
  try {
    const u = new URL(url);
    const fileName = u.searchParams.get('fileName') || u.searchParams.get('filename');
    const fromQuery = fileName && path.extname(fileName);
    if (fromQuery) return fromQuery.toLowerCase();
    const fromPath = path.extname(u.pathname);
    if (fromPath) return fromPath.toLowerCase();
  } catch { /* ignore */ }
  return '';
}

/**
 * Find all <img> tags in `html`, return [{ tag, url, alt }] in source
 * order. `tag` is the full original substring so the caller can do an
 * exact replace.
 */
function extractImageRefs(html) {
  if (!html || typeof html !== 'string') return [];
  const refs = [];
  let m;
  IMG_TAG_RE.lastIndex = 0;
  while ((m = IMG_TAG_RE.exec(html)) !== null) {
    const tag = m[0];
    const url = m[2];
    const altMatch = tag.match(IMG_ALT_RE);
    refs.push({ tag, url, alt: altMatch ? altMatch[2] : '' });
  }
  return refs;
}

/**
 * Decide whether a given image URL is hosted by the user's DevOps org.
 * Anything else (data: URIs, public CDNs, on-prem servers we don't
 * have creds for) gets skipped to avoid leaking the PAT.
 */
function isDevopsHostedUrl(url, orgHost) {
  if (!orgHost) return false;
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
    const host = u.hostname.toLowerCase();
    const org = orgHost.toLowerCase();
    // Match exact host OR subdomain (e.g. dev.azure.com matches
    // foo.dev.azure.com). On-prem TFS often uses a single internal host.
    return host === org || host.endsWith(`.${org}`);
  } catch {
    return false;
  }
}

/**
 * Download every DevOps-hosted image referenced in any of `htmlBlobs`
 * into `<clonePath>/.lgtm-attachments/`. Returns:
 *   {
 *     dir: absolute path to attachments dir,
 *     downloaded: [{ originalUrl, alt, relPath, absPath, bytes, contentType }],
 *     skipped: [{ originalUrl, reason }],
 *     substitutions: Map<originalTag, replacementMarker>,
 *   }
 *
 * The caller can then string-replace each substitution in the original
 * HTML before stripping tags, so the agent ends up seeing
 * `[image: .lgtm-attachments/img-001.png — "Login screen"]` inline
 * where the screenshot used to be.
 */
async function downloadInlineImages(htmlBlobs, { devopsClient, clonePath, logger }) {
  const log = logger || (() => {});
  const dir = path.join(clonePath, ATTACHMENT_DIR_NAME);
  const downloaded = [];
  const skipped = [];
  const substitutions = new Map();

  // Collect refs across all blobs, dedupe by URL so we don't pay twice
  // for the same screenshot referenced from description + repro.
  const seenUrls = new Map(); // url → downloaded entry (or null if skipped/in-flight)
  const allRefs = [];
  for (const blob of htmlBlobs) {
    for (const ref of extractImageRefs(blob)) allRefs.push(ref);
  }
  if (allRefs.length === 0) {
    return { dir, downloaded, skipped, substitutions };
  }

  fs.mkdirSync(dir, { recursive: true });

  let counter = 0;
  for (const ref of allRefs) {
    const cached = seenUrls.get(ref.url);
    if (cached) {
      // Same URL appeared again — reuse the same local file in the
      // substitution so two <img> tags pointing at the same screenshot
      // both resolve.
      substitutions.set(ref.tag, renderMarker(cached.relPath, ref.alt || cached.alt));
      continue;
    }
    if (cached === null) {
      // Already known to be unreachable; skip.
      continue;
    }

    if (!isDevopsHostedUrl(ref.url, devopsClient.orgHost)) {
      skipped.push({ originalUrl: ref.url, reason: 'not hosted on DevOps org' });
      seenUrls.set(ref.url, null);
      continue;
    }

    counter += 1;
    const indexed = String(counter).padStart(3, '0');
    // We don't know the extension until after the GET, so write to a
    // temp name and rename once the Content-Type comes back.
    const tmpName = `img-${indexed}.bin`;
    const tmpPath = path.join(dir, tmpName);

    try {
      const result = await devopsClient.downloadAttachment(ref.url, tmpPath);
      const ext = (EXT_BY_MIME[result.contentType.split(';')[0].trim()] || guessExtFromUrl(ref.url) || '.bin');
      const finalName = `img-${indexed}-${shortHash(ref.url)}${ext}`;
      const finalPath = path.join(dir, finalName);
      fs.renameSync(tmpPath, finalPath);
      const relPath = `${ATTACHMENT_DIR_NAME}/${finalName}`;
      const entry = {
        originalUrl: ref.url,
        alt: ref.alt,
        relPath,
        absPath: finalPath,
        bytes: result.bytes,
        contentType: result.contentType,
      };
      downloaded.push(entry);
      seenUrls.set(ref.url, entry);
      substitutions.set(ref.tag, renderMarker(relPath, ref.alt));
      log(`downloaded ${relPath} (${result.bytes} bytes, ${result.contentType})`);
    } catch (err) {
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
      skipped.push({ originalUrl: ref.url, reason: err.message });
      seenUrls.set(ref.url, null);
      log(`failed to download ${ref.url}: ${err.message}`);
    }
  }

  return { dir, downloaded, skipped, substitutions };
}

function shortHash(s) {
  return crypto.createHash('sha1').update(s).digest('hex').slice(0, 8);
}

function renderMarker(relPath, alt) {
  return alt
    ? `[image: ${relPath} — "${alt.replace(/"/g, "'")}"]`
    : `[image: ${relPath}]`;
}

/**
 * Apply the substitution map to an HTML blob in-place. Tags whose URL
 * we couldn't download are left as-is (the strip-html pass downstream
 * will discard them, leaving the alt text or nothing).
 */
function applySubstitutions(html, substitutions) {
  if (!html || substitutions.size === 0) return html;
  let out = html;
  for (const [tag, marker] of substitutions) {
    out = out.split(tag).join(marker);
  }
  return out;
}

/**
 * Render a "Downloaded Images" section the caller can append to the
 * dispatched prompt so the agent sees an explicit catalog (with alt
 * text) of every image available on disk.
 */
function renderImagesSection(downloaded) {
  if (!downloaded || downloaded.length === 0) return '';
  const lines = [
    'The following images were attached to this work item / PR and have',
    'been downloaded into the repo at the paths below. Use your file-read',
    'or vision tools to inspect them when relevant — they often contain',
    'screenshots, error messages, or design mockups that the text alone',
    'does not convey.',
    '',
  ];
  for (const img of downloaded) {
    const alt = img.alt ? ` — "${img.alt}"` : '';
    lines.push(`- \`${img.relPath}\`${alt}`);
  }
  return lines.join('\n');
}

module.exports = {
  ATTACHMENT_DIR_NAME,
  extractImageRefs,
  isDevopsHostedUrl,
  downloadInlineImages,
  applySubstitutions,
  renderImagesSection,
};
