/**
 * Pure parsing and text utility functions for the router.
 * No mutable state, no side effects.
 */

import type { ToolName, ParsedInput } from '../types/runtime.js';

// ─── Watch & converse helpers ────────────────────────────────────────────────

export function detectMentions(text: string): ToolName[] {
  const mentions: ToolName[] = [];
  if (/@claude\b/i.test(text)) mentions.push('claude');
  if (/@codex\b/i.test(text)) mentions.push('codex');
  return mentions;
}

// ─── Input parsing ───────────────────────────────────────────────────────────

export function parseInput(input: string | null | undefined): ParsedInput {
  if (!input) return { type: 'empty' };

  if (input === '/help') return { type: 'help' };
  if (input === '/quit' || input === '/exit') return { type: 'quit' };
  if (input === '/detach') return { type: 'detach' };
  if (input === '/destroy') return { type: 'destroy' };
  if (input === '/clear') return { type: 'clear' };
  if (input === '/watch') return { type: 'watch' };
  if (input === '/stop') return { type: 'stop' };
  if (input === '/status') return { type: 'status' };
  if (input === '/debug') return { type: 'debug', full: false };
  if (input === '/debug full') return { type: 'debug', full: true };

  if (input.startsWith('/send-debug ')) {
    const rest = input.slice(12).trim();
    const match = rest.match(/^(claude|codex)(?:\s+(.*))?$/);
    if (match) {
      return { type: 'send-debug', target: match[1], note: match[2] || null };
    }
    return { type: 'send-debug-error' };
  }

  if (input.startsWith('/rebind ')) {
    const target = input.slice(8).trim();
    return { type: 'rebind', target };
  }

  if (input.startsWith('/focus ')) {
    const target = input.slice(7).trim();
    return { type: 'focus', target };
  }

  if (input.startsWith('/snap ')) {
    const parts = input.slice(6).trim().split(/\s+/);
    return { type: 'snap', target: parts[0], lines: parseInt(parts[1]) || 40 };
  }

  if (input.startsWith('/converse ')) {
    const rest = input.slice(10).trim();
    const match = rest.match(/^(\d+)\s+(.+)/);
    if (match) {
      return { type: 'converse', maxRounds: parseInt(match[1]), topic: match[2] };
    }
    return { type: 'converse', maxRounds: 10, topic: rest };
  }

  if (input.startsWith('@relay ')) {
    const match = input.match(/@relay\s+(claude|codex)\s*>\s*(claude|codex)(?:\s+([\s\S]*))?/);
    if (match) {
      return { type: 'relay', from: match[1], to: match[2], prompt: match[3] || null };
    }
    return { type: 'relay_error' };
  }

  const bothMatch = input.match(/^@both[\s,:.!?;-]\s*([\s\S]*)/);
  if (bothMatch) return { type: 'both', msg: bothMatch[1] };

  const claudeMatch = input.match(/^@claude[\s,:.!?;-]\s*([\s\S]*)/);
  if (claudeMatch) return { type: 'claude', msg: claudeMatch[1] };

  const codexMatch = input.match(/^@codex[\s,:.!?;-]\s*([\s\S]*)/);
  if (codexMatch) return { type: 'codex', msg: codexMatch[1] };

  if (input.startsWith('/')) return { type: 'unknown_command' };
  return { type: 'no_target' };
}
