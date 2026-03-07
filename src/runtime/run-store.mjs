import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

let DUET_RUN_DIR = process.env.DUET_RUN_DIR || null;

export function setRunDir(dir) { DUET_RUN_DIR = dir; }

export function updateRunJson(updates) {
  const runDir = DUET_RUN_DIR;
  if (!runDir) return;
  const path = join(runDir, 'run.json');
  try {
    let data = {};
    if (existsSync(path)) {
      data = JSON.parse(readFileSync(path, 'utf8'));
    }
    for (const [key, value] of Object.entries(updates)) {
      if (key.includes('.')) {
        const [parent, child] = key.split('.', 2);
        if (!data[parent] || typeof data[parent] !== 'object') data[parent] = {};
        data[parent][child] = value;
      } else {
        data[key] = value;
      }
    }
    writeFileSync(path, JSON.stringify(data, null, 2));
  } catch {}
}
