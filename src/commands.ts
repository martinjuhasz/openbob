// Centralized command parsing for cross-channel command normalization.
// Each channel uses its platform-native prefix (Telegram: /, Matrix: !)
// but the orchestrator works with normalized Command values.

import { Command } from './types.js';

/**
 * Parse a raw message into a normalized Command, regardless of prefix.
 * Accepts both `/reset` and `!reset` so each channel can use its native syntax.
 * Returns null if the message is not a recognized orchestrator command.
 */
export function parseCommand(text: string): Command | null {
  const trimmed = text.trim();
  const match = trimmed.match(/^[/!](\w+)$/);
  if (!match) return null;
  const cmd = match[1].toLowerCase();
  if (cmd === 'reset') return 'reset';
  return null;
}
