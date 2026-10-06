const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  extractImageRefs, isProviderHostedUrl, isDevopsHostedUrl, downloadInlineImages, applySubstitutions, renderImagesSection,
} = require('../../src/main/prompt-attachments');

test('extractImageRefs finds HTML <img> tags and markdown images', () => {
  const html = '<p>See <img src="https://dev.azure.com/acme/_apis/wit/attachments/1?fileName=a.png" alt="Login"> and</p>';
  const md = 'Before ![screen](https://github.com/user-attachments/assets/abc "title") after ![](https://i.imgur.com/x.png)';
  assert.deepEqual(extractImageRefs(html).map((r) => [r.url, r.alt]), [['https://dev.azure.com/acme/_apis/wit/attachments/1?fileName=a.png', 'Login']]);
  assert.deepEqual(extractImageRefs(md).map((r) => [r.url, r.alt]), [['https://github.com/user-attachments/assets/abc', 'screen'], ['https://i.imgur.com/x.png', '']]);
  assert.deepEqual(extractImageRefs(''), []);
  assert.deepEqual(extractImageRefs(null), []);
});

test('isProviderHostedUrl: exact host or subdomain of an allowed host, https/http only', () => {
  assert.equal(isProviderHostedUrl('https://dev.azure.com/acme/x.png', ['dev.azure.com']), true);
  assert.equal(isProviderHostedUrl('https://foo.dev.azure.com/x.png', 'dev.azure.com'), true);
  assert.equal(isProviderHostedUrl('https://user-images.githubusercontent.com/1/x.png', ['github.com', 'githubusercontent.com']), true);
  assert.equal(isProviderHostedUrl('https://i.imgur.com/x.png', ['github.com', 'githubusercontent.com']), false);
  assert.equal(isProviderHostedUrl('https://evilgithub.com/x.png', ['github.com']), false, 'suffix without a dot is not a subdomain');
  assert.equal(isProviderHostedUrl('data:image/png;base64,AAAA', ['github.com']), false);
  assert.equal(isProviderHostedUrl('https://github.com/x.png', []), false);
  assert.equal(isDevopsHostedUrl('https://dev.azure.com/x.png', 'dev.azure.com'), true, 'back-compat alias');
});

test('downloadInlineImages sends the token only to the provider host, dedupes, and substitutes markers', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lgtm-att-'));
  const fetched = [];
  const client = {
    attachmentHosts: ['github.com', 'githubusercontent.com'],
    async downloadAttachment(url, dest) {
      fetched.push(url);
      fs.writeFileSync(dest, Buffer.from('png'));
      return { contentType: 'image/png', bytes: 3 };
    },
  };
  const body = '![a](https://github.com/user-attachments/assets/1) ![b](https://github.com/user-attachments/assets/1) ![c](https://i.imgur.com/evil.png)';
  const result = await downloadInlineImages([body], { client, clonePath: dir });
  assert.deepEqual(fetched, ['https://github.com/user-attachments/assets/1'], 'one fetch for the duplicate, none for the foreign host');
  assert.equal(result.downloaded.length, 1);
  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0].reason, /not hosted/);
  assert.equal(result.substitutions.size, 2, 'both references to the same image are substituted');
  const subbed = applySubstitutions(body, result.substitutions);
  assert.ok(!subbed.includes('user-attachments'), 'image URLs replaced by local markers');
  assert.ok(subbed.includes('i.imgur.com'), 'foreign image left as a plain link');
  assert.match(renderImagesSection(result.downloaded), /\.lgtm-attachments\/img-001-/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('downloadInlineImages: a client whose download throws is recorded as skipped, not fatal', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lgtm-att-'));
  const client = { orgHost: 'dev.azure.com', async downloadAttachment() { throw new Error('403'); } };
  const result = await downloadInlineImages(['<img src="https://dev.azure.com/a.png">'], { devopsClient: client, clonePath: dir });
  assert.equal(result.downloaded.length, 0);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].reason, '403');
  fs.rmSync(dir, { recursive: true, force: true });
});
