import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isRecord,
  optionalBoolean,
  optionalFiniteNumber,
  optionalTrimmedString,
} from './validation.ts';

test('isRecord accepts plain objects and rejects non-record values', () => {
  assert.equal(isRecord({ a: 1 }), true);
  assert.equal(isRecord(Object.create(null)), true);
  assert.equal(isRecord(null), false);
  assert.equal(isRecord(['a']), false);
});

test('optionalTrimmedString trims non-empty strings only', () => {
  assert.equal(optionalTrimmedString('  hello  '), 'hello');
  assert.equal(optionalTrimmedString('   '), null);
  assert.equal(optionalTrimmedString(42), null);
});

test('optionalBoolean and optionalFiniteNumber preserve primitive values', () => {
  assert.equal(optionalBoolean(true), true);
  assert.equal(optionalBoolean(false), false);
  assert.equal(optionalBoolean('true' as never), null);

  assert.equal(optionalFiniteNumber(12.5), 12.5);
  assert.equal(optionalFiniteNumber(Number.POSITIVE_INFINITY), null);
  assert.equal(optionalFiniteNumber(NaN), null);
  assert.equal(optionalFiniteNumber(null), null);
});
