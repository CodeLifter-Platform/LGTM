/**
 * Strip non-serializable members (functions) before crossing the IPC
 * boundary. Electron's structured-clone serialization throws on any
 * function value, which silently rejects the renderer's promise and
 * leaves dropdowns/settings stuck. Drop everything that's a function
 * so adding new ones (next agent driver, etc.) doesn't relapse this.
 */
function serializeAgents(agentList) {
  return agentList.map((agent) => {
    const out = {};
    for (const [k, v] of Object.entries(agent)) {
      if (typeof v !== 'function') out[k] = v;
    }
    return out;
  });
}

module.exports = { serializeAgents };
