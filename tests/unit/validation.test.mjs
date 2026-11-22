import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validate, RULES } from '../../app/js/core/validation.js';
import { CASES } from '../fixtures/cases.mjs';

const ids = (items, level) => items.filter((i) => !level || i.level === level).map((i) => i.id);
const today = new Date('2026-11-22T10:00:00+05:30');

test('empty summary is blocked on the essentials', () => {
  const r = validate({}, 'submit', today);
  assert.deepEqual(ids(r, 'block').sort(), ['diagnosis', 'patient_identifier', 'patient_name']);
});

test('complete synthetic case has no blocking items at any stage', () => {
  for (const st of ['submit', 'approve', 'finalize']) assert.deepEqual(ids(validate(CASES.surgical_complex, st, today), 'block'), [], st);
});

test('date order, future dates, procedure details and medicine completeness', () => {
  const d = { ...CASES.surgical_complex, f_Date_of_admission: '2026-12-10', f_Date_of_discharge: '2026-12-01',
    __procs: [{ n: 'Laparoscopic cholecystectomy', d: '', a: '', ao: '', o: '', f: '', c: '' }],
    __meds: [{ f: 'Tab', n: 'Paracetamol 500 mg', q: '', du: 'days', dn: '' }] };
  const r = validate(d, 'submit', today);
  assert.ok(ids(r, 'block').includes('dates_order'));
  assert.ok(ids(r).includes('dates_future'));
  assert.ok(ids(r).includes('procedure_details'));
  assert.ok(r.some((i) => i.id === 'medicine_complete' && /frequency and duration/.test(i.msg)));
});

test('surgical management without a procedure is blocked; conservative is not', () => {
  assert.ok(ids(validate({ ...CASES.surgical_complex, __procs: [] }, 'submit', today), 'block').includes('procedure_named'));
  assert.ok(!ids(validate(CASES.conservative_minimal, 'submit', today)).includes('procedure_named'));
});

test('finalize is stricter than submit (consultant name, admission dates)', () => {
  const d = { ...CASES.surgical_complex, f_Verified_by_Consultant_: '', f_Date_of_discharge: '' };
  assert.ok(!ids(validate(d, 'submit', today), 'block').includes('consultant_named'));
  assert.ok(ids(validate(d, 'finalize', today), 'block').includes('consultant_named'));
  assert.ok(ids(validate(d, 'finalize', today), 'block').includes('dates_present'));
});

test('pending results produce an informational reminder only', () => {
  const r = validate(CASES.surgical_complex, 'finalize', today);
  assert.deepEqual(r.filter((i) => i.id === 'pending_results').map((i) => i.level), ['info']);
});

test('validation never mutates the form data', () => {
  const copy = structuredClone(CASES.surgical_complex);
  validate(copy, 'finalize', today);
  assert.deepEqual(copy, CASES.surgical_complex);
  assert.equal(Object.keys(RULES).length, 20);
});
