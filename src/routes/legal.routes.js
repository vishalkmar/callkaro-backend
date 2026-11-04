// Public Privacy Policy / Terms pages (Play Console needs a public privacy URL). Same text as the app.
const express = require('express');
const { TERMS_OF_USE, PRIVACY_POLICY } = require('../legal/texts');

const DOCS = { privacy: PRIVACY_POLICY, terms: TERMS_OF_USE };

const esc = s =>
  String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const page = doc => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>CallKaro - ${esc(doc.title)}</title>
<style>body{font-family:system-ui,sans-serif;max-width:760px;margin:0 auto;padding:24px 16px;color:#222831;line-height:1.6}
h1{color:#AE5330;font-size:1.6rem}h2{font-size:1.05rem;margin-top:1.6rem}.u{color:#676D7B;font-size:.9rem}</style>
</head><body><h1>${esc(doc.title)}</h1><p class="u">${esc(doc.updated)}</p>
${doc.sections.map(s => `<h2>${esc(s.heading)}</h2><p>${esc(s.body)}</p>`).join('\n')}
</body></html>`;

const router = express.Router();
router.get('/:doc', (req, res, next) => {
  const doc = DOCS[req.params.doc];
  if (!doc) {
    return next();
  }
  res.set('Cache-Control', 'public, max-age=3600');
  return res.type('html').send(page(doc));
});

module.exports = router;
