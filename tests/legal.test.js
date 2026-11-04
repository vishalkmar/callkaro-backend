// P29.T12 public Privacy Policy / Terms URLs (Play Console) - same text as the app shows.
const fs = require('fs');
const request = require('supertest');
const app = require('../src/app');
const { TERMS_OF_USE, PRIVACY_POLICY } = require('../src/legal/texts');
const { toCommonJs, APP_FILE, OUT } = require('../scripts/syncLegal');

describe('public legal pages', () => {
  test.each([
    ['privacy', PRIVACY_POLICY],
    ['terms', TERMS_OF_USE],
  ])('/legal/%s is a public HTML page with every section', async (name, doc) => {
    const r = await request(app).get(`/legal/${name}`);
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/text\/html/);
    expect(r.text).toContain(`<h1>${doc.title}</h1>`);
    expect((r.text.match(/<h2>/g) || []).length).toBe(doc.sections.length);
  });
  test('unknown document -> 404 JSON, like any unknown route', async () => {
    const r = await request(app).get('/legal/cookies');
    expect(r.status).toBe(404);
    expect(r.body.code).toBe('NOT_FOUND');
  });
  test('text is HTML-escaped (no markup injection from the texts)', async () => {
    const r = await request(app).get('/legal/privacy');
    expect(r.text).toContain('Settings &gt; Account &gt; Delete account');
    expect(r.text).not.toMatch(/<script/i);
  });
});

// Only in the monorepo (the standalone backend repo has no app folder).
const inMonorepo = fs.existsSync(APP_FILE);
(inMonorepo ? test : test.skip)('server copy is identical to the app legal texts (run scripts/syncLegal.js)', () => {
  expect(fs.readFileSync(OUT, 'utf8')).toBe(toCommonJs(fs.readFileSync(APP_FILE, 'utf8')));
});
