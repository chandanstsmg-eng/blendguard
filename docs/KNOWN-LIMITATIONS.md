# Known limitations register

What is still open, how much it matters, and what closes it. Items closed in this release
are listed at the end for reference.

| # | Area | Limitation | Impact | Action |
|---|---|---|---|---|
| L1 | Scale | The METTLER TOLEDO MT-SICS driver is tested against a simulated scale (mock COM port), not yet against the plant's scale. Other makes (Sartorius SBI, A&D, Ohaus) are not supported. | Must be proven on site | First day with hardware: the checks in DEPLOYMENT.md §4 and §7 |
| L2 | Scale | If a scale cannot report its own tare (answers `TA` with an error), BlendGuard weighs on the displayed weight and logs a warning: pressing the scale's TARE key would then hide weight. | Low with MT-SICS scales | Lock the scale's TARE key during commissioning |
| L3 | Biometrics | Windows Hello passkeys stay on the PC where they were registered: each operator registers on each station they use. WebAuthn does not tell the server whether fingerprint, face or the device PIN was used. | Configuration | Windows Hello policy: disallow the device PIN if only biometrics are wanted |
| L4 | Import | The PDF reader was built against a sample of the plant's PROCESS ORDER layout. Scanned PDFs / photos (no text) and XLSX are not read. Quantities with a decimal comma or unclear separators are refused rather than guessed. | Check first real orders | Try the first SAP PDFs before go-live; use the editable preview |
| L5 | Formulas | One scientist imports and approves a formula; there is no second-person approval or formula editing. Batch approval needs a scientist who did not work on the batch. | Process | Agree with QA whether formula approval needs a second person |
| L6 | Translations | Hindi and Malayalam text, and their recorded voice, must be reviewed by native speakers (strings marked `// review` in `src/lib/i18n.ts` first). Scientist screens are English only. | Clarity on the floor | Before go-live |
| L7 | Corrections | The correction procedures are *re-weigh after excess removed* and *accept container weight*. Excess removed from a container that already holds earlier ingredients is recorded as possibly affecting them; whether such a batch may continue is the plant's decision. | Process coverage | Agree the SOP with QA |
| L8 | Cloud | No off-site sync. Backups can be copied to a network share (`BACKUP_COPY_TO`). | No off-site copy unless set | Set `BACKUP_COPY_TO` |
| L9 | Security | No independent VAPT yet. Dev-time advisory in the `prisma` CLI (`deepmerge-ts`, GHSA-ggr8-5vv4-36mx) does not affect request handling. | Before wide roll-out | Commission a VAPT |
| L10 | Kiosk | Edge kiosk mode stops accidental exits, but Alt+F4 and Ctrl+Alt+Del still work. | Station lock-down | Windows *Assigned Access* kiosk account |
| L11 | Lab ingredients | No pop-up or sound for "waiting for lab" or "sent to you"; scientists see them live on *Jobs & calls*. | Scientist awareness | On request |

## Closed in this release

- Real scales: METTLER TOLEDO MT-SICS over USB / RS-485 / RS-232, on the station PC (scale bridge) or the server PC; per-station COM port, baud, data format, readability and uncertainty in Setup → Station setup.
- Separate station launcher (`START-STATION.bat`): stations no longer start their own server.
- HTTPS with a plant certificate (`scripts/make-certificate.ps1`); secure cookies and HSTS when on.
- Nightly and pre-update backups with a tested restore (`npm run restore-backup`).
- Auto-start and restart after an error (`scripts/install-autostart.ps1`); daily log files.
- Live installs start with one scientist account (`scientist`), no demo users or data.
- Two roles only, operator and scientist; the administrator role is gone and existing admin accounts become scientists.
- Voice fully offline: numbers and rack letters are recorded clips; nothing is sent to an online service. Phrases made of several pieces play without gaps.
- Overpour sounds a two-tone alarm at the station, even with the station's sound switched off.
- Operators can send the current bottle for lab test (*LAB TEST*) and mark it arrived (*ARRIVED*); who did it is on the batch record.
- Scientist batch approval / rejection with password re-entry; approver on the batch record.
- Scale check reads the reference weight from the scale itself.
- Acceptance limits snapped to the scale's divisions; lines too small for a scale are flagged at import and cannot be zeroed.
- Weight added after an ingredient was accepted is caught at the next zero; the process-order material batch is checked at scan; lot expiry is re-checked at save.
- Records protected in the database: completed steps, submitted batches, approved formulas, resolved problems and the audit trail cannot be changed or truncated.
- Scientist sign-offs are single-use.
