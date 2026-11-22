// Pre-submission / pre-finalisation checks. These NEVER change the form; they only report.
// Levels: 'block' (cannot continue), 'warn' (must confirm), 'info' (reminder).
//
// CLINICAL GOVERNANCE: every rule and its level below must be reviewed and approved by the
// doctors responsible for the application before clinical use (docs/ANALYSIS.md §8).
// Set a level to null to switch a rule off for that stage.
export const RULES = {
  //  id                    submit   approve  finalize
  patient_name:          ['block', 'block', 'block'],
  patient_identifier:    ['block', 'block', 'block'],
  age_sex:               ['warn', 'warn', 'warn'],
  dates_present:         ['warn', 'warn', 'block'],
  dates_order:           ['block', 'block', 'block'],
  dates_future:          ['warn', 'warn', 'warn'],
  diagnosis:             ['block', 'block', 'block'],
  management_type:       ['warn', 'warn', 'warn'],
  procedure_named:       ['block', 'block', 'block'],
  procedure_details:     ['warn', 'warn', 'warn'],
  procedure_date_range:  ['warn', 'warn', 'warn'],
  medicines_present:     ['warn', 'warn', 'warn'],
  medicine_complete:     ['warn', 'warn', 'warn'],
  advice_present:        ['info', 'warn', 'warn'],
  warning_signs:         ['info', 'info', 'info'],
  follow_up:             ['info', 'info', 'warn'],
  consultant_named:      ['warn', 'warn', 'block'],
  resident_named:        ['warn', 'warn', 'warn'],
  pending_results:       ['info', 'info', 'info'],
  lab_values_blank:      ['info', 'info', 'info'],
};
const STAGE = { submit: 0, approve: 1, finalize: 2 };

const lines = (v) => String(v || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
const iso = (v) => (/^\d{4}-\d\d-\d\d$/.test(v || '') ? v : '');

// `data` is the engine's snapshot() object (same keys the original stored as "dsm2").
export function validate(data, stage = 'submit', today = new Date()) {
  const s = STAGE[stage] ?? 0, out = [];
  const add = (id, msg, field) => { const lvl = RULES[id]?.[s]; if (lvl) out.push({ id, level: lvl, msg, field }); };
  const v = (k) => String(data[k] ?? '').trim();

  if (!v('f_Name')) add('patient_name', 'Patient name is missing.', 'f_Name');
  if (!v('f_MRD_No') && !v('f_IRN') && !v('f_Hospital_No')) add('patient_identifier', 'No patient identifier: enter at least one of MRD No, IRN or Hospital No.', 'f_MRD_No');
  if (!v('f_Age') || !v('f_Sex')) add('age_sex', 'Age or sex is not recorded.', v('f_Age') ? 'f_Sex' : 'f_Age');

  const adm = iso(v('f_Date_of_admission')), dis = iso(v('f_Date_of_discharge'));
  if (!adm || !dis) add('dates_present', 'Date of admission or discharge is missing.', adm ? 'f_Date_of_discharge' : 'f_Date_of_admission');
  if (adm && dis && dis < adm) add('dates_order', 'Date of discharge is before the date of admission.', 'f_Date_of_discharge');
  const t = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  if ((adm && adm > t) || (dis && dis > t)) add('dates_future', 'Admission or discharge date is in the future. Please confirm.', adm > t ? 'f_Date_of_admission' : 'f_Date_of_discharge');

  if (!lines(v('f_Diagnosis')).length) add('diagnosis', 'Diagnosis is missing.', 'f_Diagnosis');

  const mg = v('f_Type_of_management');
  if (!mg) add('management_type', 'Type of management (Conservative / medical or Surgical) is not selected.', 'f_Type_of_management');
  if (mg === 'Surgical') {
    const procs = (data.__procs || []);
    const named = procs.filter((p) => (p.n || '').trim());
    if (!named.length) add('procedure_named', 'Management is Surgical but no procedure is entered.', 'procs');
    named.forEach((p) => {
      const miss = [!p.d && 'date', !(p.a === 'Other' ? (p.ao || '').trim() : p.a) && 'anaesthesia'].filter(Boolean);
      if (miss.length) add('procedure_details', `Procedure "${p.n}" has no ${miss.join(' or ')}.`, 'procs');
      if (p.d && ((adm && p.d < adm) || (dis && p.d > dis))) add('procedure_date_range', `Procedure "${p.n}" is dated outside the admission period.`, 'procs');
    });
  }

  const meds = (data.__meds || []).filter((m) => (m.n || '').trim());
  if (!meds.length) add('medicines_present', 'No treatment at discharge is listed. Confirm this is intentional.', 'addmed');
  meds.forEach((m) => {
    const freq = m.q === '__c' ? (m.qc || '').trim() : m.q;
    const dur = m.du && m.du[0] === '(' ? m.du : (m.dn || '').trim();
    const miss = [!freq && 'frequency', !dur && 'duration'].filter(Boolean);
    if (miss.length) add('medicine_complete', `${m.n}: ${miss.join(' and ')} not given.`, 'addmed');
  });

  if (!lines(v('f_Advice_at_discharge')).length) add('advice_present', 'Advice at discharge is empty.', 'f_Advice_at_discharge');
  if (!lines(v('f_Warning_signs_return_to_emergency_if')).length) add('warning_signs', 'No warning signs (return to emergency) are listed.', 'f_Warning_signs_return_to_emergency_if');
  if (!(data.opt_fu && lines(v('f_Follow_up_date_and_instructions')).length)) add('follow_up', 'Follow-up section is not filled in.', 'opt_fu');
  if (!v('f_Verified_by_Consultant_')) add('consultant_named', 'Verifying consultant (Sign-off) is not named.', 'f_Verified_by_Consultant_');
  if (!v('f_Prepared_by_Resident_')) add('resident_named', 'Preparing resident (Sign-off) is not named.', 'f_Prepared_by_Resident_');

  const text = [v('f_Plan'), v('f_Follow_up_date_and_instructions'), v('f_Course_during_hospital_stay')].join('\n');
  const ot = data.__ot || {};
  const pendingHpe = (ot.hpe || []).some((x) => /awaited|pending/i.test(x.x || ''));
  if (/awaited|pending/i.test(text) || pendingHpe) add('pending_results', 'Some results are marked awaited/pending. Make sure the patient knows how they will be followed up.', 'f_Plan');

  const blankLabs = ['pre', 'post'].reduce((n, p) => n + ((data.__labs || {})[p] || []).filter((r) => !(r.v || '').trim()).length, 0);
  if (blankLabs) add('lab_values_blank', `${blankLabs} laboratory row(s) have no value and will not be printed.`, 'rows_pre');

  const order = { block: 0, warn: 1, info: 2 };
  return out.sort((a, b) => order[a.level] - order[b.level]);
}

// Review checklist shown before finalisation (stored with the document, not in the printed summary).
export const FINAL_CHECKLIST = [
  ['identity', 'Patient identity and identifiers checked against the case sheet'],
  ['medicines', 'Treatment at discharge reviewed (drug, dose, frequency, duration)'],
  ['allergies', 'Drug allergies reviewed'],
  ['pending', 'Pending results (e.g. histopathology) and how they will be communicated reviewed'],
  ['advice', 'Advice, warning signs and follow-up reviewed'],
];
export const REQUIRE_FULL_CHECKLIST = true;
