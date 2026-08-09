// Per-run MCP config generator.
// Writes a temporary mcp.json that the agent CLI will load. Restricts ADO MCP
// to the toolset domains the mode needs.
//
// The token comes from env (ADO_MCP_AUTH_TOKEN). The MCP server reads it
// when --authentication envvar is passed.

const fs = require('fs');
const path = require('path');

async function writeMcpConfig({ runId, org, workingDir, domains }) {
  const configDir = `/cache/mcp-configs`;
  fs.mkdirSync(configDir, { recursive: true });
  const configPath = path.join(configDir, `${runId}.json`);

  const config = {
    mcpServers: {
      ado: {
        command: 'mcp-server-azuredevops',
        args: [
          org,
          '--authentication', 'envvar',
          '-d', ...domains,
        ],
        env: {
          // Forwarded from the container env. The MCP server reads
          // ADO_MCP_AUTH_TOKEN itself; we just ensure it's exposed.
          ADO_MCP_AUTH_TOKEN: process.env.ADO_MCP_AUTH_TOKEN,
        },
      },
    },
  };

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  return configPath;
}

module.exports = { writeMcpConfig };
