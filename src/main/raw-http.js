/**
 * The one axios adapter the provider registry's `quickValidate` expects:
 * `http(req)` resolves with `{ status, headers, data }` and never throws on
 * a status code, so the caller inspects 203/401/403 itself. Network errors
 * (DNS, refused, timeout) still reject with axios's `code`.
 *
 * Kept out of main.js so the startup token check can be exercised against
 * a fake server without Electron.
 */
const axios = require('axios');

async function rawHttp(req) {
  const res = await axios.request({
    method: req.method || 'GET',
    url: req.url,
    headers: req.headers,
    data: req.data,
    timeout: req.timeout || 10000,
    maxRedirects: req.maxRedirects === undefined ? 5 : req.maxRedirects,
    validateStatus: () => true,
  });
  return { status: res.status, headers: res.headers || {}, data: res.data };
}

module.exports = { rawHttp };
