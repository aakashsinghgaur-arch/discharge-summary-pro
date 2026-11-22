# Feature preservation: original vs new

**Result:** every clinical section, field, suggestion, conditional behaviour, output format, keyboard
shortcut and import/export path of `Discharge-maker.html` is present and behaves identically. This is
proven by automated side-by-side comparison (`tests/e2e/regression.spec.mjs`), not by inspection alone.

## Identical (verified byte-for-byte against the original)

| Area | Comparison performed |
|---|---|
| Section list and order (19) | legends + generated `#form` markup identical |
| Fields (36 named), controls, option lists, defaults | `#form` markup identical |
| Suggestion catalogs: 164 diagnoses, 197 procedures, 243 lab tests in 23 profiles with units, 144 drugs, 89 imaging, 51 histopathology, 68 other investigations, findings, complications, advice, warning signs, follow-up… | all catalog objects deep-equal |
| Medicine pop-up options (21 forms, 15 frequencies, 12 timings, 7 duration units) | catalogs equal + UI-driven output equal |
| Anaesthesia list (15) and "Other…" | equal |
| Conditional behaviour (management type, labels, optional sections) | UI-driven output equal |
| Preview / Copy-for-Word HTML | equal for 3 cases + UI scenario |
| A4 print document and paginator | equal; paginator runs under production CSP |
| Word (.docx): document, header, footer, styles, relationships | every zip part equal |
| Embedded restore data | decoded and equal |
| Saved form state (`dsm2` format) | equal; the same format is stored on the server |
| Legacy-data migration | equal (legacy_keys case) |
| Keyboard shortcuts | tested in the new build |
| Load from file (exact and best-effort) | tested |
| Hospital/department identity; designer attribution | header identical; footer attribution kept |

## Changed on purpose

| Change | Reason | Clinical impact |
|---|---|---|
| Storage moved from one browser draft to per-patient server documents with autosave, history and sharing | Core requirement | None — same data format |
| Spelling dictionary bundled (P7) | Original CDN path did not exist; never worked offline | Spelling suggestions now appear |
| Spelling panel shows the field name (P6) | Defect (showed the Word file name) | None |
| Remembered entries stored per doctor (P1) | Privacy between doctors | None |
| Footer wording | Old text ("never uploaded") became untrue | None |
| Extra shortcut hint "Ctrl+S Save now" | New explicit checkpoint | None |
| Read-only mode hides entry controls | Viewers, reviewers, finalised documents | None (display only) |
| "Load from file" now asks for confirmation and saves a recoverable version | Shared documents must not be replaced silently | None |
| Optional per-user switch to omit restore data from Word files | Confidentiality option | None unless switched off |

## Added (did not exist in the original)

Login, invitation, password reset, profiles and roles; dashboard (My drafts, Shared with me, Shared by me,
Pending review, Completed, All) with search, filters, sorting and paging; autosave with explicit save states;
offline recovery; editing leases with take-over; conflict protection; sharing (view / edit) and revocation;
revision history with restore and download; activity/audit log; review → approve → finalise workflow with
return-for-correction, recall and traceable amendments; configurable pre-submission checks and a finalisation
checklist (outside the printed document); admin console with server-enforced role permissions; per-summary JSON
backup; copies; security headers; automated tests.

## Not carried over

| Item | Why |
|---|---|
| Windows `.bat` launcher (README) | Not supplied and not applicable to a hosted web app |
| Single-file offline use without sign-in | Replaced by the authenticated multi-user app (the engine still runs standalone, as the tests show) |
