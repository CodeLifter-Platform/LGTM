/**
 * PatStore — Secure PAT storage using OS keychain.
 *
 * macOS  → Keychain
 * Windows → Credential Manager
 * Linux  → libsecret / GNOME Keyring
 *
 * Relies on the `keytar` npm package which wraps native APIs.
 */

const keytar = require('keytar');

const SERVICE_NAME = 'com.lgtm.azuredevops';
const ACCOUNT_NAME = 'pat';

class PatStore {
  async get() {
    try {
      return await keytar.getPassword(SERVICE_NAME, ACCOUNT_NAME);
    } catch {
      return null;
    }
  }

  async set(pat) {
    await keytar.setPassword(SERVICE_NAME, ACCOUNT_NAME, pat);
  }

  async delete() {
    try {
      await keytar.deletePassword(SERVICE_NAME, ACCOUNT_NAME);
    } catch {
      // noop if nothing stored
    }
  }
}

module.exports = { PatStore };
