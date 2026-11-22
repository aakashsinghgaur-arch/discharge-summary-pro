# Discharge Summary Pro

Single-file, offline discharge summary tool for Surgical Gastroenterology, Liver Transplantation & HPB, Gauhati Medical College & Hospital (GMCH), Guwahati.

**Designer:** Dr Akash Singh

## How to run

1. Keep `discharge-summary-pro.html` file and `Open-Discharge-Summary-Pro.bat` in the same folder.
2. Double-click `Open-Discharge-Summary-Pro.bat`. It opens the tool in Edge (or Chrome) as an app window.
3. No internet and no installation needed. You can also just double-click the `.html`.

The `.bat` looks for `discharge-summary-pro.html` first, then any `*discharge*pro*.html`, then any `*discharge*.html`.

## What it does

- **Patient details:** name, age/sex, MRD/IRN, admission and discharge dates, BMI (auto-calculated).
- **Diagnosis and complications:** type-to-filter, pick-to-add lists; labels change with management type (Complications vs Postoperative complications).
- **Management type:** Conservative / medical or Surgical. Surgical shows anaesthesia type.
- **Procedures:** date, anaesthesia, ORN, intraoperative findings and complications, per procedure. Wording example: *Laparoscopic cholecystectomy performed under general anesthesia on 22/03/1998 ORN : 29/98*.
- **Investigations:** lab profiles (thyroid, lipid, urine, etc.), imaging, MRCP, histopathology; repeated tests with dates.
- **Medicines:** form, name, sig, duration; searchable.
- **Optional sections:** vaccination, blood transfusion, consultations, advice, follow-up.
- **Records:** save, search (name, MRD, IRN, diagnosis), reopen, edit, update, delete (tap twice), backup and restore as a JSON file.
- **Output:** Print (no browser header) and Save as Word (.docx). "Load from file" restores a saved .docx exactly into the form.
- **Spelling and grammar check:** works offline.

## Print / Word text sizes

| Part | Size |
|---|---|
| Hospital header / title | 16 pt |
| Department lines | 13 pt |
| Body | 11 pt |
| Section headings (underlined) | 12 pt |
| Tables | 10.5 pt |

## Data and backup

Records are stored in the browser on that computer only. Clearing browser data or changing device loses them, so use **Backup** regularly and keep the JSON file safe. Patient data is confidential; do not share backups over unsecured channels.

## Troubleshooting

- *"Could not find the .html"*: move the `.bat` into the same folder as the `.html`.
- *Opens in the wrong browser*: edit the `.bat`; it tries Edge, then Chrome, then your default browser.
- *Records missing*: open the tool in the same browser and the same file location as before; browser storage is per browser.
