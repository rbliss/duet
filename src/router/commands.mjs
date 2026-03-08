/**
 * Pure parsing and text utility functions for the router.
 * No mutable state, no side effects.
 *
 * @typedef {import('../types/runtime.js').ToolName} ToolName
 * @typedef {import('../types/runtime.js').ParsedInput} ParsedInput
 */

// ─── Watch & converse helpers ────────────────────────────────────────────────

/**
 * Extract new content by diffing baseline vs current using prefix/suffix matching.
 * @param {string} baseline
 * @param {string} current
 * @returns {string}
 */
export function getNewContent(baseline, current) {
  if (!baseline) return current;
  if (baseline === current) return '';

  const baseLines = baseline.split('\n');
  const currLines = current.split('\n');

  let prefixLen = 0;
  const maxPrefix = Math.min(baseLines.length, currLines.length);
  while (prefixLen < maxPrefix && baseLines[prefixLen] === currLines[prefixLen]) {
    prefixLen++;
  }

  let suffixLen = 0;
  const maxSuffix = Math.min(baseLines.length - prefixLen, currLines.length - prefixLen);
  while (suffixLen < maxSuffix &&
         baseLines[baseLines.length - 1 - suffixLen] === currLines[currLines.length - 1 - suffixLen]) {
    suffixLen++;
  }

  if (prefixLen > 0 || suffixLen > 0) {
    const inserted = currLines.slice(prefixLen, currLines.length - suffixLen);
    const result = inserted.filter(/** @param {string} l */ l => l.trim()).join('\n').trim();
    if (result) return result;
  }

  const baseSet = new Set(baseLines.map(/** @param {string} l */ l => l.trim()).filter(Boolean));
  const newLines = currLines.filter(/** @param {string} l */ l => l.trim() && !baseSet.has(l.trim()));
  return newLines.join('\n');
}

/**
 * Detect @claude and @codex mentions in text.
 * @param {string} text
 * @returns {ToolName[]}
 */
export function detectMentions(text) {
  /** @type {ToolName[]} */
  const mentions = [];
  if (/@claude\b/i.test(text)) mentions.push('claude');
  if (/@codex\b/i.test(text)) mentions.push('codex');
  return mentions;
}

const BOX_CHARS = /[─│╭╮╰╯┌┐└┘├┤┬┴┼╔╗╚╝║═▔▁█▓▒░]/g;
const SPINNER = /^\s*[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏◐◑◒◓⣾⣽⣻⢿⡿⣟⣯⣷]\s*/;

/**
 * Clean captured pane text by removing box-drawing, spinners, and status hints.
 * @param {string | null | undefined} text
 * @returns {string}
 */
export function cleanCapture(text) {
  if (!text) return '';
  return text
    .split('\n')
    .filter(/** @param {string} line */ line => {
      const trimmed = line.trim();
      if (!trimmed) return false;
      const withoutBox = trimmed.replace(BOX_CHARS, '').trim();
      if (withoutBox.length < 3) return false;
      if (SPINNER.test(trimmed)) return false;
      if (/^[⏎↩]?\s*(to send|to interrupt|\/help|\/compact|ESC to|Ctrl[+-])/i.test(trimmed)) return false;
      if (/^(Claude Code|Codex)\s*(v[\d.]|$)/i.test(trimmed)) return false;
      if (/^[$>]\s*$/.test(trimmed)) return false;
      return true;
    })
    .map(/** @param {string} line */ line => line.replace(/^[\s│║▏]+/, '').replace(/[\s│║▕]+$/, '').trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

// ─── Input parsing ───────────────────────────────────────────────────────────

/**
 * Parse router input into a typed command object.
 * @param {string | null | undefined} input
 * @returns {ParsedInput}
 */
export function parseInput(input) {
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
    const match = input.match(/@relay\s+(claude|codex)\s*>\s*(claude|codex)(?:\s+(.*))?/);
    if (match) {
      return { type: 'relay', from: match[1], to: match[2], prompt: match[3] || null };
    }
    return { type: 'relay_error' };
  }

  const bothMatch = input.match(/^@both[\s,:.!?;-]\s*(.*)/);
  if (bothMatch) return { type: 'both', msg: bothMatch[1] };

  const claudeMatch = input.match(/^@claude[\s,:.!?;-]\s*(.*)/);
  if (claudeMatch) return { type: 'claude', msg: claudeMatch[1] };

  const codexMatch = input.match(/^@codex[\s,:.!?;-]\s*(.*)/);
  if (codexMatch) return { type: 'codex', msg: codexMatch[1] };

  if (input.startsWith('/')) return { type: 'unknown_command' };
  return { type: 'no_target' };
}
