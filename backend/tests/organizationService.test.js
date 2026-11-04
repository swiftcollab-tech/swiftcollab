const assert = require('assert');
const {
  VALID_ROLES,
  createSlug,
  hashToken,
} = require('../services/organizationService');
const { assertEmail, escapeHtml } = require('../services/emailService');
const { isUuid } = require('../middleware/organization');

function run() {
  assert.deepStrictEqual([...VALID_ROLES].sort(), ['admin', 'member', 'owner', 'viewer']);

  const slug = createSlug('Client Team / Engineering');
  assert.match(slug, /^client-team-engineering-[a-z0-9]{6}$/);

  const fallbackSlug = createSlug('!!!');
  assert.match(fallbackSlug, /^organization-[a-z0-9]{6}$/);

  assert.strictEqual(hashToken('invite-token'), hashToken('invite-token'));
  assert.match(hashToken('invite-token'), /^[a-f0-9]{64}$/);
  assert.strictEqual(assertEmail(' TEAM@Example.COM '), 'team@example.com');
  assert.throws(() => assertEmail('not-an-email'), /valid email/);
  assert.strictEqual(escapeHtml('<script>"x"</script>'), '&lt;script&gt;&quot;x&quot;&lt;/script&gt;');
  assert.strictEqual(isUuid('d3469d12-869c-42ae-b75a-7055c8ee09f0'), true);
  assert.strictEqual(isUuid('not-a-uuid'), false);

  console.log('Organization service tests passed');
}

try {
  run();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
