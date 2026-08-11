// TokenManager — caches and refreshes ADO Entra tokens.
//
// Uses @azure/identity's DefaultAzureCredential, which transparently picks up:
//   - az login session (local dev)
//   - VS Code Azure account
//   - Managed Identity / Workload Identity in Azure
//   - AZURE_CLIENT_ID/AZURE_CLIENT_SECRET/AZURE_TENANT_ID env vars in CI
//
// You don't need to configure anything for local dev as long as you've run
// `az login`.

const { DefaultAzureCredential } = require('@azure/identity');

// The Azure DevOps resource ID — constant, do not change
const ADO_RESOURCE_ID = '499b84ac-1321-427f-aa17-267ca6975798';
const ADO_SCOPE = `${ADO_RESOURCE_ID}/.default`;

// Refresh tokens with at least this much remaining lifetime
const REFRESH_BEFORE_MS = 5 * 60 * 1000; // 5 minutes

class TokenManager {
  constructor(opts = {}) {
    this.credential = opts.credential || new DefaultAzureCredential();
    this._cached = null;
  }

  /**
   * Get a valid ADO bearer token. Refreshes if expiry is within REFRESH_BEFORE_MS.
   * @returns {Promise<string>}
   */
  async getAdoToken() {
    if (this._isFresh(this._cached)) {
      return this._cached.token;
    }
    const result = await this.credential.getToken(ADO_SCOPE);
    if (!result || !result.token) {
      throw new Error(
        'Failed to acquire ADO token. Are you logged in? Try: az login',
      );
    }
    this._cached = result;
    return result.token;
  }

  _isFresh(cached) {
    if (!cached || !cached.token || !cached.expiresOnTimestamp) return false;
    return cached.expiresOnTimestamp > Date.now() + REFRESH_BEFORE_MS;
  }
}

module.exports = { TokenManager };
