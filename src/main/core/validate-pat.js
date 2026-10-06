/**
 * validateConnection — prove a token works against a git service by listing
 * what it can see (projects on Azure DevOps, owners on GitHub), and turn
 * every way that can fail into a sentence the user can act on.
 * `validatePat` is the Azure DevOps-only form the first version shipped.
 *
 * Two error shapes reach us and both are mapped:
 *   - axios (`err.response.status`) from the raw-HTTP helpers, and
 *   - azure-devops-node-api / typed-rest-client (`err.statusCode`).
 * The SDK also has two silent failure modes that are NOT errors:
 *   - a 404 on the projects call resolves to `null` (typed-rest-client
 *     maps NotFound to a null result), and
 *   - a wrong org URL or an expired PAT answered with a sign-in page makes
 *     the SDK's route discovery fail with "Failed to find api location".
 * Both used to surface as "PAT valid but no projects found" or a stack
 * trace; now they say what to check.
 */

const { parseOrgUrl } = require('./org-url');

function statusOf(err) {
  if (!err) return undefined;
  if (typeof err.statusCode === 'number') return err.statusCode;
  if (err.response && typeof err.response.status === 'number') return err.response.status;
  return undefined;
}

/**
 * Map a thrown error to the message the renderer shows, for any provider.
 * `provider` is a registry entry (label, urlLabel, scopes); without one the
 * Azure DevOps wording is used. Always returns a string; never rethrows.
 */
function describeConnectionError(err, { url, provider } = {}) {
  const status = statusOf(err);
  const message = (err && err.message) || String(err);
  if (provider && provider.id !== 'azure-devops') {
    if (status === 404) {
      return `404 Not Found — check the ${provider.urlLabel.toLowerCase()} (${url}).`;
    }
    if (status === 401 || status === 403) {
      return `${status} — the ${provider.label} token was rejected. Make sure it hasn't expired and has these scopes: ${provider.scopes.join(', ')}.`;
    }
    if (/timed out/i.test(message)) {
      return `${message}. ${provider.label} at ${url} did not answer in time — check the URL and your network.`;
    }
    return message;
  }
  return describeValidationError(err, url);
}

/**
 * The Azure DevOps wording. Always returns a string; never rethrows.
 */
function describeValidationError(err, orgUrl) {
  const parsed = parseOrgUrl(orgUrl);
  const status = statusOf(err);
  const message = (err && err.message) || String(err);

  if (status === 404) {
    return `404 Not Found — API call to ${parsed.orgUrl}/_apis/projects failed. Check your org URL.`;
  }
  if (status === 401 || status === 403) {
    return `${status} — PAT was rejected. Make sure it hasn't expired and has Code (Read) scope.`;
  }
  if (status === 203) {
    return `Azure DevOps answered with a sign-in page instead of the API (203). The PAT was rejected — check that it hasn't expired — or ${parsed.orgUrl} is not an Azure DevOps org URL.`;
  }
  if (/Failed to find api location|Failed to retrieve resource areas|Could not find information for resource area/i.test(message)) {
    return `${parsed.orgUrl}/_apis did not answer like Azure DevOps. Check the org URL (it should look like https://dev.azure.com/<org>) and that the PAT hasn't expired.`;
  }
  if (/timed out/i.test(message)) {
    return `${message}. Azure DevOps at ${parsed.orgUrl} did not answer in time — check the URL and your network.`;
  }
  return message;
}

/**
 * @param {object} opts
 * @param {string} opts.pat
 * @param {string} opts.orgUrl                         - as typed by the user
 * @param {(pat, orgUrl) => { getProjects(): Promise }} opts.createClient
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<{ success: true, projects: string[], filterNote: string }
 *                 | { success: false, error: string }>}
 */
async function validatePat({ pat, orgUrl, createClient, timeoutMs = 20000 }) {
  return validateConnection({ token: pat, url: orgUrl, createClient, timeoutMs });
}

/**
 * @param {object} opts
 * @param {string} opts.token
 * @param {string} opts.url                              - as typed by the user
 * @param {() => { getProjects(): Promise }} opts.createClient - returns the provider client
 * @param {object} [opts.provider]                       - registry entry; Azure DevOps when absent
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<{ success: true, projects: string[], filterNote: string }
 *                 | { success: false, error: string }>}
 */
async function validateConnection({ token, url, createClient, provider = null, timeoutMs = 20000 }) {
  const isAdo = !provider || provider.id === 'azure-devops';
  const parsed = isAdo ? parseOrgUrl(url) : { orgUrl: (url || '').trim(), project: null };
  if (!parsed.orgUrl || !/^https?:\/\//i.test(parsed.orgUrl)) {
    const example = isAdo ? 'https://dev.azure.com/<org>' : 'https://github.com/<owner>';
    return { success: false, error: `"${url}" is not a URL. Enter the ${isAdo ? 'org URL' : (provider.urlLabel || 'service URL')}, e.g. ${example}.` };
  }
  if (!token) {
    return { success: false, error: 'Enter a Personal Access Token.' };
  }

  const noun = isAdo ? 'projects' : `${provider.groupNoun || 'owner'}s`;
  try {
    const client = createClient(token, url);
    const projects = await withTimeout(client.getProjects(), timeoutMs, 'getProjects');
    if (projects == null) {
      // typed-rest-client turns a 404 (and a non-JSON body such as a
      // sign-in page) into a null result rather than an error.
      return { success: false, error: describeConnectionError({ statusCode: 404 }, { url, provider }) };
    }
    if (projects.length === 0) {
      return { success: false, error: isAdo ? 'PAT valid but no projects found.' : `Token accepted but nothing to list — no ${noun} visible.` };
    }
    return {
      success: true,
      projects: projects.map((p) => p.name),
      filterNote: parsed.project ? ` Filtered to project "${parsed.project}".` : '',
    };
  } catch (err) {
    return { success: false, error: describeConnectionError(err, { url, provider }) };
  }
}

/**
 * Race a promise against a timeout so an IPC answer always comes back in
 * bounded time, even if the SDK hangs on DNS or a stuck proxy.
 */
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

module.exports = { validatePat, validateConnection, describeValidationError, describeConnectionError, withTimeout };
