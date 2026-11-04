// Copies the app's legal texts into the server (public /legal pages). Run from server/: node scripts/syncLegal.js
const fs = require('fs');
const path = require('path');

const APP_FILE = path.join(__dirname, '..', '..', 'CallKaroApp', 'src', 'constants', 'legal.js');
const OUT = path.join(__dirname, '..', 'src', 'legal', 'texts.js');

const toCommonJs = src =>
  '// GENERATED copy of CallKaroApp/src/constants/legal.js (served at /legal/privacy and /legal/terms for the\n' +
  '// Play Store). Edit the app file, then: node scripts/syncLegal.js  (a monorepo test fails if they differ).\n' +
  src.replace(/^export const /gm, 'const ').trimEnd() +
  '\n\nmodule.exports = { TERMS_OF_USE, PRIVACY_POLICY };\n';

if (require.main === module) {
  fs.writeFileSync(OUT, toCommonJs(fs.readFileSync(APP_FILE, 'utf8')));
  // eslint-disable-next-line no-console
  console.log(`wrote ${OUT}`);
}

module.exports = { toCommonJs, APP_FILE, OUT };
