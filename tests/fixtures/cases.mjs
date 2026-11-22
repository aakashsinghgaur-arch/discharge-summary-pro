// SYNTHETIC clinical cases (no real patient data) in the original "dsm2" form-state format.
// Used to compare the original tool and the new application output for identical input.

const labs = (rows) => rows.map(([d, t, v, u = undefined, extra = {}]) => ({ d, t, tc: '', v, u: u ?? '', uc: '', ...extra }));

export const CASES = {
  // Complex surgical case: two procedures, repeated labs, custom tests, all optional sections, many medicines.
  surgical_complex: {
    f_Name: 'Test Patient Alpha', f_Age: '54', f_Sex: 'Male', f_Address: '12 Example Lane, Test Town', f_Hospital_No: 'H-000123', f_MRD_No: 'MRD/2026/0456',
    f_IRN: '7788', f_C_O: 'Dr Synthetic Unit Head', f_Consultant: 'Dr Synthetic Consultant', f_Date_of_admission: '2026-10-02', f_Date_of_discharge: '2026-10-14',
    f_Weight_kg_: '68', f_Height_cm_: '170', f_BMI: '23.5', f_Blood_group: 'B+', f_PS_ECOG_: '1',
    f_Diagnosis: 'Carcinoma head of pancreas\nObstructive jaundice', f_Co_morbidities: 'Type 2 diabetes mellitus\nHypertension',
    opt_vacc: '1', f_Pre_operative_vaccination_status: 'Pneumococcal vaccine given\nInfluenza vaccine given',
    f_Type_of_management: 'Surgical', f_Conservative_medical_management_details: '',
    f_Complications: 'Postoperative pancreatic fistula (ISGPS grade B)\nDelayed gastric emptying', f_Plan: 'Histopathology report awaited\nDiscuss in multidisciplinary tumour board',
    opt_bt: '1', f_Blood_transfusion_details: '2 units PRBC transfused on POD 1 without reaction.',
    f_History_of_presenting_illness: 'Painless progressive jaundice for 6 weeks with pruritus.\nWeight loss of 6 kg.',
    opt_cons: '1', f_Consultations_and_referrals: 'Cardiology opinion taken\nEndocrinology opinion taken',
    f_Course_during_hospital_stay: 'Underwent the procedures listed. Postoperative period complicated by a grade B fistula managed conservatively with drain.\nDrain removed on POD 12.',
    f_Advice_at_discharge: 'Take medicines as prescribed\nTake a high-protein diet\nAvoid lifting weights above 5 kg for 6 weeks',
    f_Wound_and_drain_care: 'Keep the wound clean and dry\nSutures or staples to be removed on postoperative day 10 to 14',
    f_Warning_signs_return_to_emergency_if: 'Fever with chills or temperature above 100.4 °F (38 °C)\nIncreasing abdominal pain\nYellow discolouration of eyes or skin',
    opt_cond: '1', f_Condition_at_discharge: 'Afebrile and haemodynamically stable\nTolerating oral diet',
    opt_fu: '1', f_Follow_up_date_and_instructions: 'Review in surgical OPD after 2 weeks with histopathology report',
    f_Prepared_by_Resident_: 'Dr Synthetic Resident', f_Designation_of_resident: 'Senior Resident', f_Verified_by_Consultant_: 'Dr Synthetic Consultant', f_Emergency_contact_number: '0361-0000000',
    ld_pre: '2026-10-03', ld_post: '2026-10-09',
    __labs: {
      pre: labs([
        ['2026-10-03', 'Hemoglobin (Hb)', '11.2', 'g/dL'], ['2026-10-03', 'TC (WBC)', '8400', 'cells/cu.mm'], ['2026-10-03', 'Platelets', '2.1', 'lakh/cu.mm'],
        ['2026-10-03', 'Total bilirubin', '12.4', 'mg/dL'], ['2026-10-05', 'Total bilirubin', '9.1', 'mg/dL'], ['2026-10-03', 'ALT', '142', 'U/L'],
        ['2026-10-03', 'Creatinine', '0.9', 'mg/dL'], ['2026-10-03', 'CA 19-9', '412', 'U/mL'],
        ['2026-10-03', '__o', '7.2', '__c', { tc: 'Serum IgG4 subclass', uc: 'g/L' }],
        ['2026-10-04', 'INR', '1.3', ''], ['', 'HbA1c', '7.4', '%'], ['2026-10-04', 'Sodium (Na)', '', 'mmol/L'],
      ]),
      post: labs([
        ['2026-10-09', 'Hemoglobin (Hb)', '9.8', 'g/dL'], ['2026-10-09', 'Drain fluid amylase', '3400', 'U/L'], ['2026-10-11', 'Drain fluid amylase', '820', 'U/L'],
        ['2026-10-09', 'Total bilirubin', '3.2', 'mg/dL'], ['2026-10-09', 'Potassium (K)', '3.6', 'mmol/L'], ['2026-10-12', 'CRP', '24', 'mg/L'],
      ]),
    },
    __meds: [
      { f: 'Tab', fc: '', n: 'Pantoprazole 40 mg', d: '1 tab', q: 'once daily', qc: '', t: 'before food', dn: '14', du: 'days' },
      { f: 'Tab', fc: '', n: 'Paracetamol 650 mg', d: '1 tab', q: 'SOS (when required)', qc: '', t: '', dn: '', du: '(as needed)' },
      { f: 'Cap', fc: '', n: 'Pancreatin (lipase 25000 U)', d: '1 cap', q: 'thrice daily', qc: '', t: 'with food', dn: '3', du: 'months' },
      { f: 'Injection', fc: '', n: 'Insulin glargine', d: '10 units', q: '__c', qc: 'at 10 pm', t: '', dn: '', du: '(continue)' },
      { f: '__o', fc: 'Sachet (sugar-free)', n: 'Protein supplement', d: '1 scoop', q: 'twice daily', qc: '', t: 'with milk', dn: '1', du: 'months' },
      { f: 'Syrup', fc: '', n: 'Lactulose solution', d: '15 ml', q: 'at bedtime', qc: '', t: '', dn: '1', du: 'weeks' },
    ],
    __ot: {
      pre: [{ d: '2026-10-03', n: 'ECG', x: 'Normal sinus rhythm' }, { d: '2026-10-03', n: '2D Echo', x: 'LVEF 60%\nNo regional wall motion abnormality' }],
      post: [{ d: '2026-10-10', n: 'Drain fluid culture', x: 'No growth after 48 hours' }],
      img: [{ d: '2026-09-28', n: 'CECT abdomen', x: 'Ill-defined 2.8 x 2.4 cm hypodense mass in the pancreatic head\nDilated CBD 14 mm\nNo vascular involvement' }, { d: '2026-09-30', n: 'MRCP', x: 'Double duct sign' }],
      hpe: [{ d: '2026-10-13', n: 'Pancreatic specimen (Whipple)', x: 'Awaited' }],
    },
    __procs: [
      { n: 'Pancreaticoduodenectomy (Whipple\'s procedure)', d: '2026-10-06', a: 'General anaesthesia with epidural', ao: '', o: '1234/26', f: 'Mass noted (site and size)\nNo peritoneal or distant deposits', c: 'No intraoperative complication' },
      { n: 'Feeding jejunostomy', d: '2026-10-06', a: 'Other', ao: 'Paravertebral block', o: '1235/26', f: '', c: '' },
    ],
  },

  // Conservative management, optional sections OFF but filled (must not print), non-numeric age.
  conservative_minimal: {
    f_Name: 'Test Patient Beta', f_Age: '8 months', f_Sex: 'Female', f_MRD_No: 'MRD-9', f_Date_of_admission: '2026-11-01', f_Date_of_discharge: '2026-11-03',
    f_Diagnosis: 'Acute pancreatitis', f_Type_of_management: 'Conservative / medical',
    f_Conservative_medical_management_details: 'IV fluids\nAnalgesics\nEarly enteral nutrition', f_Complications: 'No postoperative complications',
    opt_vacc: '', f_Pre_operative_vaccination_status: 'Should not print', opt_fu: '', f_Follow_up_date_and_instructions: 'Should not print either',
    f_Advice_at_discharge: 'Take a low-fat diet', f_Weight_kg_: '7.5', f_Height_cm_: '68', f_BMI: '16.2',
    __labs: { pre: [], post: [] }, __meds: [], __ot: { pre: [], post: [], img: [], hpe: [] }, __procs: [],
  },

  // Data saved by an OLDER version of the tool: single-procedure keys and old imaging/HPE fields.
  legacy_keys: {
    f_Name: 'Test Patient Gamma', f_Age: '41', f_Sex: 'Female', f_Type_of_management: 'Surgical',
    f_Surgical_procedure_details: 'Laparoscopic cholecystectomy\nAdhesiolysis', f_Date_of_surgery: '2026-08-05', f_Type_of_anaesthesia: 'Other', f_Other_anaesthesia_specify_: 'Low-flow GA', f_ORN: '29/26',
    f_Intraoperative_findings: 'Distended gallbladder with multiple calculi', f_HPE: 'Chronic cholecystitis', f_HPE_dt: '2026-08-12',
    f_CT: 'Normal study', f_CT_dt: '2026-07-30', f_USG: 'Cholelithiasis', f_MRCP: 'No CBD calculi', f_MRCP_dt: '2026-08-01',
    f_Diagnosis: 'Chronic calculous cholecystitis', __labs: { pre: [], post: [] }, __meds: [],
  },
};
