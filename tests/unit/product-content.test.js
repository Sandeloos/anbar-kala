'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { plain, readProductDescription } = require('../../server/lib/product-content');
const { normalise } = require('../../server/lib/sync');

test('structured product description is plain text, bounded and comes only from the canonical page', async () => {
  let seen;
  const copy = await readProductDescription(123, async (url) => {
    seen = url;
    return new Response(`<script type="application/ld+json">{"@graph":[{"@type":"Product","description":"<p>کابل &amp; مسی</p>"}]}</script>`);
  });
  assert.equal(seen, 'https://www.digikala.com/product/dkp-123/');
  assert.equal(copy, 'کابل & مسی');
  assert.equal(await readProductDescription('bad'), '');
  assert.equal(await readProductDescription(1, async () => new Response('', { status: 403 })), '');
  assert.equal(await readProductDescription(1, async () => new Response('<script type="application/ld+json">bad</script>')), '');
  assert.equal(plain('<script>bad()</script><style>bad</style><p>سلام</p>'), 'سلام');
  assert.equal(plain('a'.repeat(30000)).length, 20000);
});

test('site descriptions include variation and parent copy; old webhook payloads preserve stored content', () => {
  assert.equal(normalise({ id: 1, type: 'simple', description: '<p>شرح کالا</p>', short_description: 'کوتاه' }, 'rial').description, 'شرح کالا کوتاه');
  assert.equal(normalise({ id: 2, description: 'تنوع' }, 'rial', { name: 'والد', description: 'توضیحات اصلی' }).description, 'تنوع توضیحات اصلی');
  assert.equal(normalise({ id: 1, type: 'simple' }, 'rial').description, undefined);
});
