/**
 * Unit tests for the prescription quantity calculation.
 *
 * The frontend has no build step and no module system, so the functions are
 * lifted out of public/js/doctor.js by name and evaluated here. They are pure,
 * which is exactly why they live as standalone functions.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(path.join(ROOT, 'public/js/doctor.js'), 'utf8');

function lift(name) {
  const match = src.match(new RegExp(`function ${name}\\b[\\s\\S]*?\\n}`));
  assert.ok(match, `${name}() should exist in public/js/doctor.js`);
  return match[0];
}

// dosesPerDay and doseUnits feed computeQuantity, so evaluate all three together.
const { computeQuantity, dosesPerDay, doseUnits } = (new Function(`
  ${lift('dosesPerDay')}
  ${lift('doseUnits')}
  ${lift('computeQuantity')}
  return { computeQuantity, dosesPerDay, doseUnits };
`))();

// ---------------------------------------------------------------- doses per day
test('reads doses per day from an N-N-N frequency', () => {
  assert.equal(dosesPerDay('1-0-1 (morning & night)'), 2);
  assert.equal(dosesPerDay('1-1-1 (thrice daily)'), 3);
  assert.equal(dosesPerDay('0-0-1 (night)'), 1);
  assert.equal(dosesPerDay('1-0-0 (morning)'), 1);
  assert.equal(dosesPerDay('2-0-2'), 4);
  assert.equal(dosesPerDay('1-1-1-1'), 4, 'four-slot regimens are valid too');
});

test('reads doses per day from plain-language frequencies', () => {
  assert.equal(dosesPerDay('Once daily'), 1);
  assert.equal(dosesPerDay('Twice daily'), 2);
  assert.equal(dosesPerDay('Thrice daily'), 3);
  assert.equal(dosesPerDay('Every 6 hours'), 4);
  assert.equal(dosesPerDay('Every 8 hours'), 3);
});

test('sub-daily frequencies give a fractional rate', () => {
  assert.equal(dosesPerDay('Alternate days'), 0.5);
  assert.equal(dosesPerDay('Weekly'), 1 / 7);
});

test('an as-needed frequency has no calculable rate', () => {
  for (const f of ['SOS (as needed)', 'As directed', 'PRN', 'sos', '']) {
    assert.equal(dosesPerDay(f), null, `"${f}" should not be calculable`);
  }
});

// ---------------------------------------------------------------- dose units
test('counts units only when the dose is in countable things', () => {
  assert.equal(doseUnits('1 tablet'), 1);
  assert.equal(doseUnits('2 tablets'), 2);
  assert.equal(doseUnits('1 capsule'), 1);
  assert.equal(doseUnits('1 sachet'), 1);
  assert.equal(doseUnits('2 drops'), 2);
  assert.equal(doseUnits(''), 1, 'an unstated dose is assumed to be one unit');
  assert.equal(doseUnits('1'), 1);
});

test('a dose measured by volume or weight is not countable', () => {
  // A syrup is dispensed as bottles: 5 ml twice a day is 1 bottle, not 10.
  for (const d of ['5 ml', '10 ml', '2.5 mL', '500 mg', '1 g']) {
    assert.equal(doseUnits(d), null, `"${d}" should not be countable`);
  }
});

// ---------------------------------------------------------------- quantity
test('quantity is doses per day x days x dose amount', () => {
  assert.equal(computeQuantity({ frequency: '1-0-1 (morning & night)', durationDays: 5, dosage: '1 tablet' }), 10);
  assert.equal(computeQuantity({ frequency: '1-1-1 (thrice daily)', durationDays: 3, dosage: '1 tablet' }), 9);
  assert.equal(computeQuantity({ frequency: '0-0-1 (night)', durationDays: 3, dosage: '1 tablet' }), 3);
  assert.equal(computeQuantity({ frequency: 'Once daily', durationDays: 10, dosage: '1 tablet' }), 10);
  assert.equal(computeQuantity({ frequency: '1-0-1', durationDays: 5, dosage: '2 tablets' }), 20);
  assert.equal(computeQuantity({ frequency: 'Every 6 hours', durationDays: 2, dosage: '1 capsule' }), 8);
});

test('a fractional rate rounds up to whole units', () => {
  assert.equal(computeQuantity({ frequency: 'Alternate days', durationDays: 30, dosage: '1 tablet' }), 15);
  assert.equal(computeQuantity({ frequency: 'Weekly', durationDays: 30, dosage: '1 tablet' }), 5);
  assert.equal(computeQuantity({ frequency: 'Alternate days', durationDays: 5, dosage: '1 tablet' }), 3);
});

test('quantity is left alone when it cannot be known', () => {
  // As-needed: nobody can say how many.
  assert.equal(computeQuantity({ frequency: 'SOS (as needed)', durationDays: 5, dosage: '1 tablet' }), null);
  // Volume doses: the pack size is unknown, so guessing would be wrong.
  assert.equal(computeQuantity({ frequency: '1-0-1', durationDays: 5, dosage: '5 ml' }), null);
  assert.equal(computeQuantity({ frequency: '1-0-1', durationDays: 0, dosage: '1 tablet' }), null);
  assert.equal(computeQuantity({ frequency: '1-0-1', durationDays: -3, dosage: '1 tablet' }), null);
  assert.equal(computeQuantity({ frequency: '', durationDays: 5, dosage: '1 tablet' }), null);
});

test('an unstated dosage still calculates from frequency and days', () => {
  assert.equal(computeQuantity({ frequency: '1-0-1', durationDays: 5, dosage: '' }), 10);
});
