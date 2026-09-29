import test from 'node:test';
import assert from 'node:assert/strict';
import { findQuote, htmlToText, tokenize } from '../src/match.js';

test('tokenize folds case, curly quotes and punctuation', () => {
  assert.deepEqual(tokenize('The “Agent’s” reply—fast!'), ['the', 'agent', 's', 'reply', 'fast']);
});

test('exact match survives whitespace, case and typographic differences', () => {
  const page = 'Intro.\n\nThe committee said it “will not   renew” the contract in 2027. More text.';
  const r = findQuote(page, 'the committee said it "will not renew" the contract');
  assert.equal(r.kind, 'exact');
  assert.equal(r.score, 1);
  assert.match(r.excerpt, /will not renew the contract/);
});

test('exact match requires whole tokens', () => {
  assert.notEqual(findQuote('a category of things', 'cat').kind, 'exact');
});

test('one changed word in a long quote is near, not exact', () => {
  const page = 'Revenue grew twelve percent year over year driven by strong demand in the northern region.';
  const r = findQuote(page, 'Revenue grew twelve percent year over year driven by steady demand in the northern region');
  assert.equal(r.kind, 'near');
  assert.ok(r.score >= 0.9 && r.score < 1);
});

test('a reworded claim is partial or absent, never supported', () => {
  const page = 'The trial enrolled 400 patients and found no significant difference in outcomes.';
  const r = findQuote(page, 'The trial found a large and significant improvement in patient outcomes');
  assert.ok(['partial', 'absent'].includes(r.kind), r.kind);
});

test('an unrelated quote is absent', () => {
  const r = findQuote('Weather today is sunny with light wind.', 'central bank raised interest rates by fifty basis points');
  assert.equal(r.kind, 'absent');
  assert.equal(r.excerpt, null);
});

test('htmlToText drops scripts and decodes entities', () => {
  const t = htmlToText('<html><head><title>x</title><script>var a="secret quote";</script></head><body><p>Fish &amp; chips&#8217; price</p></body></html>');
  assert.match(t, /Fish & chips’ price/);
  assert.doesNotMatch(t, /secret quote/);
});
