/**
 * The one place AgentRunner touches Electron: pushing review updates and
 * output chunks to the renderer. Kept out of agent-runner.js so the runner
 * imports without Electron and tests hand it a sink instead.
 */
function createRendererNotifier() {
  const { BrowserWindow } = require('electron');
  const send = (channel, payload) => {
    const windows = BrowserWindow.getAllWindows();
    if (windows.length > 0 && !windows[0].isDestroyed()) {
      windows[0].webContents.send(channel, payload);
    }
  };
  return {
    update: (_key, payload) => send('review-update', payload),
    chunk: (_key, payload) => send('review-output', payload),
  };
}

module.exports = { createRendererNotifier };
