import type { Rule } from '../config.js';
import type { VtsHotkey } from './vtube-studio.js';

export interface MissingVtsReference {
  rule: string;
  kind: 'hotkey' | 'expression';
  value: string;
  /** A near match in the model, e.g. the same name in other letter case. */
  suggestion?: string;
}

/**
 * Hotkeys and expressions that enabled rules use but the loaded VTube Studio model lacks.
 * Hotkeys may be given by name or by id; expressions by their `.exp3.json` file name.
 */
export function missingVtsReferences(rules: Rule[], hotkeys: VtsHotkey[], expressionFiles: string[]): MissingVtsReference[] {
  const hotkeyKeys = new Set(hotkeys.flatMap((h) => [h.name, h.hotkeyID]));
  const files = new Set(expressionFiles);
  const fold = (s: string) => s.trim().toLowerCase();
  const missing: MissingVtsReference[] = [];
  for (const rule of rules) {
    if (!rule.enabled) continue;
    for (const action of rule.actions) {
      if (action.type === 'vts.hotkey' && !hotkeyKeys.has(action.hotkey)) {
        const suggestion = hotkeys.find((h) => fold(h.name) === fold(action.hotkey))?.name;
        missing.push({ rule: rule.name, kind: 'hotkey', value: action.hotkey, ...(suggestion ? { suggestion } : {}) });
      } else if (action.type === 'vts.expression' && !files.has(action.file)) {
        const suggestion = expressionFiles.find((f) => fold(f) === fold(action.file));
        missing.push({ rule: rule.name, kind: 'expression', value: action.file, ...(suggestion ? { suggestion } : {}) });
      }
    }
  }
  return missing;
}
