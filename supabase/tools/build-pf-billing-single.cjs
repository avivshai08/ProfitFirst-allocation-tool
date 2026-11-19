// Builds the one-file version of the pf-billing function for pasting into the Supabase
// dashboard editor (the function was deployed from the dashboard, which takes one file):
// emails.ts + logic.ts + index.ts with the imports between them removed. Same code otherwise.
// Usage: node supabase/tools/build-pf-billing-single.cjs [output file]
// Default output: pf-billing-single.ts next to this script's folder (not committed).
const fs = require('fs');
const path = require('path');

const dir = path.resolve(__dirname, '..', 'functions', 'pf-billing');
const out = process.argv[2] || path.resolve(__dirname, '..', 'pf-billing-single.ts');
// Removes imports of the sibling files (single or multi-line); keeps the npm import.
const local = /^import\s[^;]*?\sfrom\s+'\.\/[a-z]+\.ts';\r?\n/gm;
const part = (name) => fs.readFileSync(path.join(dir, name), 'utf8').replace(local, '');

const single = '// pf-billing — single file for pasting into the Supabase dashboard editor.\n'
  + '// Generated from supabase/functions/pf-billing/emails.ts + logic.ts + index.ts (same code, one file).\n\n'
  + part('emails.ts')
  + '\n// ---- billing rules (logic.ts) ----\n' + part('logic.ts')
  + '\n// ---- function entry point (index.ts) ----\n' + part('index.ts');
if (/from\s+'\.\//.test(single)) throw new Error('a local import was left in');
fs.writeFileSync(out, single);
console.log('written: ' + out);
