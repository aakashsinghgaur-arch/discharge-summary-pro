# Stage 1 — Analysis of the original application

Source files analysed: `original/Discharge-maker.html` (1,477 lines, the functional and clinical baseline),
`original/Discharge-Summary-Pro-README.md`, `original/Discharge Summary Pro.md` (interface text).
Counts below were extracted programmatically from the running original page (`tests/.tmp/inventory.json`).

## 1. Architecture of the original

A single self-contained HTML file: ~370 lines of CSS, ~15 lines of markup, ~1,060 lines of JavaScript.
The form is **generated at load time** from a section table `S` and suggestion catalogs (`LIB`, `U`, `PR`,
`OTQ`, `DRUGS`, `SGT`). All state lives in the DOM and is serialised by `save()` to one browser
`localStorage` key, `dsm2`, on every keystroke. There is one draft per browser.

## 2. Clinical section and field inventory (order is binding)

| # | Section | Optional (toggle) | Content |
|---|---|---|---|
| 1 | Patient details | — | Name, Age, Sex (Male/Female/Other), Address, Hospital No, MRD No, IRN, C/O, Consultant, Date of admission, Date of discharge, Weight (kg), Height (cm), BMI (auto), Blood group (8 suggestions), PS (ECOG) (5 suggestions) |
| 2 | Diagnosis | — | Diagnosis (list, numbered + bold in output; 164 suggestions), Co-morbidities (list; 40) |
| 3 | Vaccination status | `opt_vacc` | Pre-operative vaccination status (list; 18) |
| 4 | Management and procedure | — | Type of management (Conservative / medical · Surgical). Conservative → "Conservative / medical management details". Surgical → repeatable **procedures** (name, date, ORN, anaesthesia from 15 + "Other…", per-procedure intraoperative findings (58) and complications (31)). Complications (label switches to "Postoperative complications"; 43). Plan (shown as "Plan after discharge, if any"; 28) |
| 5 | Blood transfusion | `opt_bt` | Blood transfusion details |
| 6 | History | — | History of presenting illness |
| 7 | Pre-op laboratory investigations | — | Repeatable rows: date, test, value, unit (243 tests, 23 profiles, unit choices per test, custom test + unit) |
| 8 | Other pre-op investigations | — | Repeatable: name, date, result (68 suggestions) |
| 9 | Post-op laboratory investigations | — | as 7 |
| 10 | Other post-op investigations | — | as 8 |
| 11 | Imaging | — | as 8 (89 suggestions incl. MRCP) |
| 12 | Histopathology | — | as 8 (51 suggestions) |
| 13 | Consultations and referrals | `opt_cons` | list (40) |
| 14 | Hospital course | — | Course during hospital stay |
| 15 | Treatment at discharge | — | Medicine list + pop-up editor: form (21), name (144 drugs, searchable, grouped), dose (auto default by form), frequency (15 + custom), timing (12), duration number + unit (7) |
| 16 | Advice and care | — | Advice at discharge (42), Wound and drain care (22), Warning signs: return to emergency if (27) |
| 17 | Condition at discharge | `opt_cond` | list (21) |
| 18 | Follow-up | `opt_fu` | Follow-up date and instructions (15) |
| 19 | Sign-off | — | Prepared by (Resident), Designation of resident (8), Verified by (Consultant), Emergency contact number |

36 named fields, plus repeatable procedures, lab rows, other-investigation rows and medicines.
Lab profiles: CBC, CBC indices/differential, LFT, RFT, Electrolytes and minerals, Coagulation,
Inflammatory markers, Blood sugar, Pancreatic enzymes, Thyroid, Lipid, Iron, ABG, Cardiac markers,
Urine R/E, Stool R/E, Viral markers, Immunology, Tumour markers, Endocrine, Vitamins, Ascitic fluid, Drain fluid.

## 3. Behaviour inventory

| Area | Behaviour in the original |
|---|---|
| Suggestions | Type-to-filter, grouped lists; token matching with ranking; keyboard ↑/↓/Enter/Esc; "custom name" entry; list boxes suggest per line and skip lines already present |
| Remembered entries | Free-text lines not in the catalogs are remembered (`dsm_hist`, max 60 per field); recent medicines (`dsm_medhist`, 15); forget one / forget all (double-tap) |
| Conditional UI | Management type shows/hides conservative details vs procedures; complications label switches; optional sections appear when toggled; anaesthesia "Other…" reveals a text box |
| Repeatable rows | Add lab profile (all tests) or single test; "+ Add another value of this test"; continuation rows visually merged; remove row |
| Dates | Type `dd/mm/yyyy`, `ddmmyyyy`, `t`/`today`, or pick from calendar; invalid dates highlighted |
| BMI | Auto-calculated from weight/height, WHO category hint; manual override kept |
| Navigation | Sticky section chips with completion marks, progress bar, collapsible sections, collapse/expand all, patient chip in header |
| Output | `build()` creates the summary HTML: hospital/department header (16 pt / 13 pt), title, two-column particulars, sections in fixed order, lists numbered/bulleted, labs grouped by date and profile with short names, procedures as "*X performed under Y on dd/mm/yyyy ORN : n*", advice + warning signs + emergency contact, sign-off block |
| Copy for Word | Rich HTML to clipboard (fallback: select preview) |
| Print | Hidden iframe with its own A4 paginator (Arial, "Page n of N" footer, keeps headings with content) |
| Save Word | Own `.docx` writer (no library): header on first page, footer page numbers, Arial 11 pt; the full form state is embedded in custom document properties (`dsm00000…`) for exact restoration; share sheet on touch devices |
| Load from file | `.docx` with embedded data → exact restore; `.docx`/`.html` without → best-effort text parsing with a warning; `.json` → restore |
| Spelling & grammar | typo.js + en_US dictionary (downloaded from a CDN on first use) + medical word list + personal dictionary + 8 grammar rules; review panel with replace / ignore / add to dictionary |
| Keyboard | Ctrl+Enter copy, Ctrl+P print, Alt+V preview, Alt+W save Word, Alt+S spelling, Alt+↑/↓ sections, Enter = next field |
| Legacy data | Restores older single-procedure keys (`f_Surgical_procedure_details`, `f_Date_of_surgery`, …) and old imaging/HPE fields into the current structure |
| Theme / layout | Light/dark by system preference; phone bottom-sheet dialogs; large touch targets on coarse pointers; reduced-motion support |

## 4. README-to-code gap analysis

| README claim | Present in the HTML? | Action in this project |
|---|---|---|
| Patient details incl. auto BMI | Yes | Preserved |
| Diagnosis/complications type-to-filter; labels change with management type | Yes | Preserved |
| Management type; Surgical shows anaesthesia | Yes (per procedure) | Preserved |
| Procedure wording example "*…under general anesthesia…*" | Yes, but the output spells **anaesthesia** (from the list) | Output unchanged; README corrected |
| Investigations, imaging, MRCP, histopathology, repeated tests | Yes | Preserved |
| Optional sections "vaccination, blood transfusion, consultations, **advice**, follow-up" | Partly: **advice is not optional**; **condition at discharge is** optional | README corrected; behaviour unchanged |
| **Records: save, search, reopen, edit, update, delete, backup/restore JSON** | **No.** Only one auto-saved draft per browser; JSON can be *loaded* but not exported | Implemented additively: dashboard with search/sort/filter, reopen, delete drafts, copies, history; per-summary JSON download |
| Print (no browser header), Save as Word, exact Load from file | Yes | Preserved byte-for-byte |
| **Spelling check works offline** | **No.** Dictionary is fetched from a CDN at a path that does not exist in typo-js 1.2.4 | Fixed: dictionary bundled locally (P7) |
| Text sizes: header 16, dept 13, body 11, headings 12, **tables 10.5 pt** | Mostly. The current output has no tables (lists instead); title is 14 pt | README corrected |
| `.bat` launcher | Not supplied; not applicable to a hosted app | Documented as not applicable |

## 5. Defects and technical risks found

| # | Finding | Severity | Resolution |
|---|---|---|---|
| D1 | Two functions named `fname()`: the second (Word file name) silently replaces the first (field name), so the spelling panel shows "Discharge Summary – Name – date.docx" instead of the field name | Low (confusing) | **Fixed** (P6), proven by a test that reproduces it in the original |
| D2 | Dictionary URL `typo-js@1.2.4/typo/typo.js` does not exist in that package; spelling falls back to grammar-only, and never works offline | Medium | **Fixed** (P7): typo-js 1.2.4 + dictionary-en 3.2.0 bundled |
| D3 | One draft per browser; starting a new patient overwrites the previous one; clearing browser data loses it | High (data loss) | Replaced by server drafts with history |
| D4 | Remembered entries may contain patient-specific text and are stored unencrypted in shared `localStorage` | Medium (privacy on shared PCs) | Per-user keys, removed at sign-out, private server copy |
| D5 | The `.docx` embeds the **entire** form state (including text of optional sections switched off) in hidden document properties | Medium (confidentiality) | Preserved for compatibility; per-user switch to turn embedding off; documented |
| D6 | Footer says entries are "never uploaded" | Accuracy | Wording updated (cosmetic) |
| D7 | Dead code: `simple()`, `medT()`, `otT()`, `los()` (length of stay is computed but never printed), `#optbar`, `docHTML(true)`, references to removed `f_Type_of_anaesthesia` | Low | Left unchanged (behaviour-neutral); **length of stay is a possible clinical addition needing approval** |
| D8 | `OTQ.pre` and `OTQ.post` are the same array, so extra pre-op suggestions also appear post-op | Informational | Preserved (appears intended) |
| D9 | Duplicate `"aPTT"` key in the unit table; duplicated closing `</body></html>` | Cosmetic | Harmless; not carried over to the new markup |

## 6. Changes made to the original engine (all marked `DSP-CLOUD [Pn]` in `app/js/form-engine.js`)

| Patch | Change | Effect when running standalone (no cloud shell) |
|---|---|---|
| P1 | Remembered entries read/written through `lsGet/lsSet` (per-user key + sync hook) | Identical keys and behaviour |
| P2 | `save()` body moved into `snapshot()`; the state goes to the cloud shell | Identical (`localStorage.dsm2`) |
| P3 | Restore reads the cloud shell's boot data | Identical (`localStorage.dsm2`) |
| P4 | Embedded Word restore data built from `snapshot()` (same JSON); can be switched off per user | Identical |
| P5 | "Load from file" hands the data to the shell (saved as a new, recoverable version) | Identical (store + reload) |
| P6 | D1 fix (rename to `fldName`) | Fix |
| P7 | D2 fix (bundled dictionary) | Fix |
| P8 | Section navigator offsets include the app-bar height | Identical (height 0) |

Everything else — catalogs, form generation, suggestion logic, output builders, the Word writer, the
print paginator, keyboard handling — is byte-for-byte the original. `tests/e2e/regression.spec.mjs`
proves equality of catalogs, form markup, preview HTML, A4 print document, saved state and every part of
the `.docx` for three synthetic cases and for an identical sequence of UI actions.

## 7. Feature-preservation checklist

Status: ✅ preserved and covered by an automated test · ☑ preserved, manual check (see TESTING.md).

| Feature | Status | Evidence |
|---|---|---|
| 19 sections in original order, all labels and fields | ✅ | regression: catalogs/markup identical; legends asserted |
| All suggestion catalogs, units, profiles, drugs, anaesthesia list | ✅ | regression: `S, U, PR, PL, SNG, LIB, SGT, DRUGS, OTQ, ANA, FM, FQ, TM, DU, MED…` equal |
| Management-type switching and label change | ✅ | regression (UI drive, cases) |
| Multiple procedures, per-procedure findings/complications | ✅ | regression (surgical_complex) |
| Lab profiles, repeated values, custom tests/units, date grouping | ✅ | regression (cases + UI drive) |
| Other investigations, imaging, histopathology | ✅ | regression |
| Medicine pop-up (add/edit/remove, chips, defaults, recent) | ✅ | regression UI drive; app: read-only blocks the pop-up |
| Searchable suggestions + keyboard selection | ✅ | regression UI drive |
| Remembered entries (+ forget) | ✅ | regression (per-user keys); app (private sync) |
| Optional sections and activation | ✅ | regression (conservative_minimal: hidden text not printed) |
| BMI auto-calculation | ✅ | regression UI drive (25.0) |
| Collapse/expand, section navigator, progress | ✅ | regression keyboard test |
| Preview, Copy for Word | ✅ / ☑ | build() identical; clipboard manual |
| Print with A4 pagination | ✅ | print document identical; app: paginator runs under CSP |
| Save Word (.docx) | ✅ | all docx parts identical |
| Load from file: exact (.docx with data) and best-effort | ✅ | regression round-trip + plain-HTML import |
| Spelling & grammar | ✅ | regression (offline dictionary, field name) |
| Keyboard shortcuts | ✅ | regression keyboard test |
| Legacy data migration | ✅ | regression (legacy_keys) |
| Dark theme, responsive layout, touch sizes | ☑ | screenshots (tests/e2e/screens.spec.mjs) |
| Hospital/department identity, Dr Akash Singh attribution | ✅ | regression (header markup identical, footer asserted) |

## 8. Items that need clinical approval (not changed)

1. Validation rules and their levels in `app/js/core/validation.js` (blocking / warning / info per stage).
2. The finalisation checklist wording (`FINAL_CHECKLIST`) and whether all items are mandatory.
3. Whether amended summaries should carry a printed "Amended" marker (currently the printed document is unchanged).
4. Whether length of stay (already computed by the original, D7) should be printed.
5. Whether embedding restore data in Word files should default to on (current, original behaviour) or off.
6. The role → capability mapping (who may review, self-approve and finalise), editable in the admin console.

## 9. Recommended (and implemented) structure

```
app/                      static site (deployed as-is)
  editor.html             original markup + app bar; loads js/editor-shell.js
  css/form.css            ORIGINAL stylesheet, verbatim
  js/form-engine.js       ORIGINAL script + 8 marked patches
  js/editor-shell.js      cloud integration: auth, leases, autosave, recovery, workflow, history
  js/core/*.js            env, Supabase client, API/errors, UI kit, auth, sharing, autosave, recovery, validation
  index.html, login.html, reset.html, admin.html (+ js)
  vendor/                 supabase-js UMD, typo-js, en_US dictionary
supabase/migrations/      schema, RLS, API functions;  supabase/functions/admin-users (Edge Function)
scripts/                  build (config + key guard + CSP check), static server, vendoring
tests/                    unit, db (real PostgreSQL), e2e (Playwright)
```
