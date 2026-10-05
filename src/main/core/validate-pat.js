/**
 * validatePat — prove a PAT works against an org by listing its projects,
 * and turn every way that can fail into a sentence the user can act on.
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
 * Map a thrown error to the message the renderer shows. Always returns a
 * string; never rethrows.
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
  const parsed = parseOrgUrl(orgUrl);
  if (!parsed.orgUrl || !/^https?:\/\//i.test(parsed.orgUrl)) {
    return { success: false, error: `"${orgUrl}" is not a URL. Enter the org URL, e.g. https://dev.azure.com/<org>.` };
  }
  if (!pat) {
    return { success: false, error: 'Enter a Personal Access Token.' };
  }

  try {
    const client = createClient(pat, orgUrl);
    const projects = await withTimeout(client.getProjects(), timeoutMs, 'getProjects');
    if (projects == null) {
      // typed-rest-client turns a 404 (and a non-JSON body such as a
      // sign-in page) into a null result rather than an error.
      return { success: false, error: describeValidationError({ statusCode: 404 }, orgUrl) };
    }
    if (projects.length === 0) {
      return { success: false, error: 'PAT valid but no projects found.' };
    }
    return {
      success: true,
      projects: projects.map((p) => p.name),
      filterNote: parsed.project ? ` Filtered to project "${parsed.project}".` : '',
    };
  } catch (err) {
    return { success: false, error: describeValidationError(err, orgUrl) };
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

module.exports = { validatePat, describeValidationError, withTimeout };
