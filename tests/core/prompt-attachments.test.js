'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  extractImageRefs, isDevopsHostedUrl, downloadInlineImages, applySubstitutions, renderImagesSection,
} = require('../../src/main/prompt-attachments');
const { tempDir } = require('../helpers/fakes');

test('Only_URLs_on_the_configured_org_host_or_its_subdomains_are_trusted_with_the_PAT', () => {
  const org = 'dev.azure.com';
  assert.equal(isDevopsHostedUrl('https://dev.azure.com/o/_apis/wit/attachments/1', org), true);
  assert.equal(isDevopsHostedUrl('https://o.dev.azure.com/x.png', org), true);
  assert.equal(isDevopsHostedUrl('https://DEV.AZURE.COM/x.png', org), true);
  assert.equal(isDevopsHostedUrl('https://evil-dev.azure.com/x.png', org), false);
  assert.equal(isDevopsHostedUrl('https://dev.azure.com.evil.example/x.png', org), false);
  assert.equal(isDevopsHostedUrl('https://i.imgur.com/x.png', org), false);
  assert.equal(isDevopsHostedUrl('data:image/png;base64,AAAA', org), false);
  assert.equal(isDevopsHostedUrl('ftp://dev.azure.com/x.png', org), false);
  assert.equal(isDevopsHostedUrl('not a url', org), false);
  assert.equal(isDevopsHostedUrl('https://dev.azure.com/x.png', ''), false);
});

test('Image_tags_are_extracted_with_their_alt_text_in_source_order', () => {
  const refs = extractImageRefs('<p>a</p><img alt="one" src="https://h/1.png"><IMG SRC=\'https://h/2.png\' alt=\'two\'/>');
  assert.deepEqual(refs.map((r) => [r.url, r.alt]), [['https://h/1.png', 'one'], ['https://h/2.png', 'two']]);
  assert.deepEqual(extractImageRefs(null), []);
});

function fakeClient(orgHost, { fail = [] } = {}) {
  const calls = [];
  return {
    calls,
    orgHost,
    async downloadAttachment(url, destPath) {
      calls.push(url);
      if (fail.includes(url)) throw new Error('403 Forbidden');
      fs.writeFileSync(destPath, Buffer.from('png-bytes'));
      return { contentType: 'image/png; charset=binary', bytes: 9 };
    },
  };
}

test('Off_org_images_are_never_downloaded_and_are_listed_as_skipped', async () => {
  const client = fakeClient('dev.azure.com');
  const clone = tempDir();
  const html = '<img src="https://i.imgur.com/leak.png"><img src="https://dev.azure.com/o/_apis/wit/attachments/9?fileName=shot.png">';
  const result = await downloadInlineImages([html], { devopsClient: client, clonePath: clone });
  assert.deepEqual(client.calls, ['https://dev.azure.com/o/_apis/wit/attachments/9?fileName=shot.png']);
  assert.deepEqual(result.skipped, [{ originalUrl: 'https://i.imgur.com/leak.png', reason: 'not hosted by the connected service' }]);
  assert.equal(result.downloaded.length, 1);
  assert.ok(result.downloaded[0].relPath.startsWith('.lgtm-attachments/img-001-'));
  assert.ok(result.downloaded[0].relPath.endsWith('.png'));
  assert.ok(fs.existsSync(result.downloaded[0].absPath));
});

test('The_same_URL_referenced_twice_is_downloaded_once_and_both_tags_are_substituted', async () => {
  const client = fakeClient('dev.azure.com');
  const clone = tempDir();
  const url = 'https://dev.azure.com/o/_apis/wit/attachments/1?fileName=a.png';
  const desc = `<img src="${url}" alt="login">`;
  const repro = `<img alt="again" src="${url}">`;
  const result = await downloadInlineImages([desc, repro], { devopsClient: client, clonePath: clone });
  assert.equal(client.calls.length, 1);
  assert.equal(result.substitutions.size, 2);
  const stripped = applySubstitutions(desc + repro, result.substitutions);
  assert.match(stripped, /\[image: \.lgtm-attachments\/img-001-[0-9a-f]{8}\.png — "login"\]\[image: \.lgtm-attachments\/img-001-[0-9a-f]{8}\.png — "again"\]/);
});

test('A_download_that_fails_is_reported_as_skipped_with_the_reason_and_leaves_no_temp_file', async () => {
  const url = 'https://dev.azure.com/o/_apis/wit/attachments/2';
  const client = fakeClient('dev.azure.com', { fail: [url] });
  const clone = tempDir();
  const result = await downloadInlineImages([`<img src="${url}">`], { devopsClient: client, clonePath: clone });
  assert.deepEqual(result.downloaded, []);
  assert.deepEqual(result.skipped, [{ originalUrl: url, reason: '403 Forbidden' }]);
  assert.deepEqual(fs.readdirSync(result.dir), []);
});

test('No_images_means_no_attachments_directory_and_an_empty_result', async () => {
  const clone = tempDir();
  const result = await downloadInlineImages(['<p>plain</p>', ''], { devopsClient: fakeClient('dev.azure.com'), clonePath: clone });
  assert.deepEqual(result.downloaded, []);
  assert.equal(fs.existsSync(path.join(clone, '.lgtm-attachments')), false);
  assert.equal(renderImagesSection(result.downloaded), '');
});

test('The_images_section_lists_each_relative_path_with_its_alt_text', () => {
  const section = renderImagesSection([{ relPath: '.lgtm-attachments/a.png', alt: 'shot' }, { relPath: '.lgtm-attachments/b.png', alt: '' }]);
  assert.ok(section.includes('- `.lgtm-attachments/a.png` — "shot"'));
  assert.ok(section.includes('- `.lgtm-attachments/b.png`\n') || section.endsWith('- `.lgtm-attachments/b.png`'));
});
