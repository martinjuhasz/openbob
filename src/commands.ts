// Centralized command parsing for cross-channel command normalization.
// Each channel uses its platform-native prefix (Telegram: /, Matrix: !)
// but the orchestrator works with normalized Command values.

import { Command } from './types.js';

/**
 * Parse a raw message into a normalized Command, regardless of prefix.
 * Accepts both `/cmd` and `!cmd` so each channel can use its native syntax.
 * Some commands accept an argument (e.g. `/switch <sessionId>`).
 * Returns null if the message is not a recognized orchestrator command.
 */
export function parseCommand(text: string): Command | null {
  const trimmed = text.trim();
  const match = trimmed.match(/^[/!](\w+)(?:\s+(.+))?$/);
  if (!match) return null;
  const cmd = match[1].toLowerCase();
  const arg = match[2]?.trim();
  if (cmd === 'new' || cmd === 'reset') return { type: 'new' };
  if (cmd === 'stop') return { type: 'stop' };
  if (cmd === 'restart') return { type: 'restart' };
  if (cmd === 'sessions') return { type: 'sessions' };
  if (cmd === 'switch') return arg ? { type: 'switch', arg } : null;
  return null;
}
