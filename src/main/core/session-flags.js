/**
 * Inject the agent-specific session-continuity flags on top of the args
 * buildCommand handed back. Returns a fresh array; never touches the
 * registry's defaults.
 *
 * Claude split: `--session-id <uuid>` CREATES a session with that ID and
 * refuses if one already exists ("session ID is already in use"). To
 * continue, use `--resume <uuid>`. So turn 1 creates, turns 2+ resume.
 *
 * Auggie has no session id: `--continue` picks the most recent session in
 * the cwd (which we own), so it is added from turn 2 on.
 *
 * @param {string} agentId
 * @param {string[]} args
 * @param {{ sessionId: string|null, firstTurn: boolean }} session
 */
function applySessionFlags(agentId, args, { sessionId = null, firstTurn = true } = {}) {
  const out = [...args];
  if (agentId === 'claude' && sessionId) {
    out.push(firstTurn ? '--session-id' : '--resume', sessionId);
  } else if (agentId === 'augment' && !firstTurn) {
    out.push('--continue');
  }
  return out;
}

module.exports = { applySessionFlags };
