/**
 * PatStore — Secure PAT storage using OS keychain.
 *
 * macOS  → Keychain
 * Windows → Credential Manager
 * Linux  → libsecret / GNOME Keyring
 *
 * Falls back to electron-store if keytar is unavailable or errors out.
 * The fallback is less secure (encrypted JSON on disk) but ensures
 * the PAT persists across restarts.
 */

let keytar;
try {
  keytar = require('keytar');
} catch (err) {
  console.warn('[LGTM] keytar not available, will use fallback storage:', err.message);
  keytar = null;
}

const ElectronStore = require('electron-store');

const SERVICE_NAME = 'com.lgtm.azuredevops';
const ACCOUNT_NAME = 'pat';

// Fallback store — encrypted at rest via electron-store's encryptionKey
const fallbackStore = new ElectronStore({
  name: 'lgtm-secure',
  encryptionKey: 'lgtm-v1-obfuscation-key',
});

class PatStore {
  async get() {
    // Try keytar first
    if (keytar) {
      try {
        const pat = await keytar.getPassword(SERVICE_NAME, ACCOUNT_NAME);
        if (pat) {
          console.log('[LGTM] PAT loaded from OS keychain.');
          return pat;
        }
      } catch (err) {
        console.warn('[LGTM] keytar.getPassword failed:', err.message);
      }
    }

    // Fallback to encrypted store
    const fallback = fallbackStore.get('pat');
    if (fallback) {
      console.log('[LGTM] PAT loaded from fallback encrypted store.');
      return fallback;
    }

    console.log('[LGTM] No stored PAT found.');
    return null;
  }

  async set(pat) {
    // Write to both so we have a fallback
    if (keytar) {
      try {
        await keytar.setPassword(SERVICE_NAME, ACCOUNT_NAME, pat);
        console.log('[LGTM] PAT saved to OS keychain.');
      } catch (err) {
        console.warn('[LGTM] keytar.setPassword failed:', err.message);
      }
    }
    fallbackStore.set('pat', pat);
    console.log('[LGTM] PAT saved to fallback encrypted store.');
  }

  async delete() {
    if (keytar) {
      try {
        await keytar.deletePassword(SERVICE_NAME, ACCOUNT_NAME);
      } catch {}
    }
    fallbackStore.delete('pat');
    console.log('[LGTM] PAT cleared from all stores.');
  }
}

module.exports = { PatStore };
