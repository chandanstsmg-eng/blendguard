# PROJECT: BLENDGUARD
## Smart Perfume Manufacturing, Operator Guidance and Precision Weighing System

> Original project brief, saved 2026-10-03. This is the source of truth for scope.

Build a complete, production-oriented, highly intuitive manufacturing application called **BlendGuard**, designed for a perfume manufacturing company.

The application will be used primarily by factory operators and supervisors working at perfume mixing stations. Its primary purpose is to eliminate manual mistakes, guide operators through every manufacturing step, ensure accurate weighing, and maintain a complete digital manufacturing record.

The design must be inspired by modern industrial control systems, particularly the provided BlendGuard operator-console reference. Build a cleaner, more intuitive and more polished interface specifically for non-technical factory operators.

**The operator interface must be so simple that a new worker can understand what to do without technical training or complicated instructions.**

Do not build a generic ERP system, inventory website, or conventional admin dashboard as the main experience. Build an operator-first manufacturing control application with a supporting supervisor and administration interface.

---

# 1. Application architecture and technology

The company requires the application to run on a local server with a local database and synchronize with a cloud database whenever internet connectivity is available.

### Frontend
- React.js with TypeScript, Vite, Tailwind CSS, shadcn/ui, Lucide icons, Framer Motion (subtle transitions), React Router, TanStack Query, Zustand, React Hook Form, Zod, Recharts (supervisor analytics).

### Backend
- Node.js, TypeScript, Express.js, REST APIs, Socket.IO for real-time updates, JWT or secure session-based authentication, role-based access control.

### Database
- PostgreSQL for the local manufacturing database.
- A separate cloud PostgreSQL database for synchronization.
- Prisma ORM.
- Offline-first local transaction processing.
- Background synchronization service.

### Hardware integration
- QR and barcode scanner support, digital weighing scale integration, fingerprint authentication, face authentication where supported, touchscreen monitor support, thermal printer support.

Use a single application origin and one main startup process wherever possible. The frontend, API, and local application services should be integrated into one deployable project. Do not require the operator to open different ports or applications.

The hardware integration layer may run as a local device service when necessary. Document this clearly.

The system must be capable of operating without internet access during production.

---

# 2. Visual identity and design direction

Name: **BlendGuard** — Tagline: **Every Ingredient. Every Gram. Every Time.**

The design should feel like a professionally engineered industrial application, not a generic AI-generated website.

### Design palette
- Deep navy: `#17394C`
- Dark blue: `#204D62`
- Warm orange: `#D98236`
- Soft ivory: `#F8F8F5`
- Light gray: `#EEF1F2`
- Success green: `#24844F`
- Warning amber: `#E7A42A`
- Error red: `#C94343`
- Dark text: `#27343D`

Use large readable typography, spacious layouts, strong visual hierarchy, high-contrast buttons, clear status labels, large numeric displays, minimal decoration, restrained rounded corners, subtle motion only when it improves feedback.

The main interface should look like industrial control software that is easy to operate with a touchscreen. Do not overcrowd the interface with charts, tables, or settings.

---

# 3. Application entry and biometric authentication

## Entry screen
Full-screen welcome: **Welcome to BlendGuard** — "Please verify your identity to continue."
Large fingerprint icon and large face verification option if supported by the configured hardware.
Include: Scan fingerprint · Verify face · Operator ID fallback (restricted to approved methods) · Supervisor assistance · Language selection.
Primary interaction: a simple tap followed by authentication.

## Fingerprint authentication
Support compatible devices via OS authentication, WebAuthn, or a documented hardware integration. Flow:
1. Identify the operator account or request their operator ID.
2. Trigger the configured authentication method.
3. Validate the authentication response.
4. Confirm the operator's identity.
5. Start a secure session.
6. Redirect to the assigned operator workflow.

Do not access raw fingerprint images or store biometric templates in the application database.

## Face authentication
Integrate through an approved, documented authentication service if a compatible device is available. Prefer device-native face authentication or passkeys over building a face-recognition database. Display a clear fallback when hardware is unavailable.

Do not allow a face or fingerprint animation to act as a fake successful authentication.

On failure: simple error, retry, record the failed attempt, offer authorized assistance.

The supervisor must be able to configure the authentication methods permitted at each station.

---

# 4. Operator dashboard

Designed for workers who may lack computer experience, wear gloves, stand for long periods, work in noise, need unambiguous instructions, and should not type during normal production.

## Main screen
Header: BlendGuard logo · operator name · current station · date/time · connection status · language switcher · logout/switch operator.

Main card — **Your assigned job**: Perfume (e.g. Oud Royale), Batch ID (PB-260903-07), Formula (F-2041), Ingredients (12), Status (Ready to Start).

Primary button: **START JOB**. Other large buttons: My Jobs · Resume Job · Call Supervisor.

No admin settings or technical controls on the operator's main screen.

If no job is assigned: "No job assigned yet." with a large button to contact the supervisor.

---

# 5. Supervisor upload and job assignment

## Production instruction upload — three import options

### Option 1: Scan SOP sheet
Upload or scan PDF/images/scanned docs; OCR extraction; manual correction. Extract SOP number, perfume name, formula number, revision, date, ingredient names, quantities, remarks, required sequence. Always show extracted data for human review and approval before creating a production order.

### Option 2: Upload a soft copy
CSV, XLSX, approved Excel templates, PDF for assisted extraction. Preview. Flag missing ingredients, duplicate rows, invalid quantities, unsupported units.

### Option 3: SAP extract
Dedicated SAP extract import supporting the company's approved file format. Configurable field-mapping interface (do not hardcode an unknown SAP format). Import preview, validation, error report, duplicate order detection, import history. Do not invent SAP connectivity.

## Production order review
Table: Ingredient | Required quantity | Unit | Remarks. Also SOP details, perfume name, formula revision, production date, ingredient count, total batch quantity, validation status. Supervisor can correct imported data and approve the order.

## Assign jobs to operators
Select approved order, assign operator, station, priority, planned start time, instructions, backup operator where authorized. Show assignment confirmation. Job appears automatically on the operator's home screen. Keep the original imported document and approved order version for traceability.

---

# 6. Operator manufacturing interface

One clear instruction at a time. Full-screen, three areas:

**Left — Mixing sequence:** step number, ingredient name, required weight, status (Locked / Current / Completed / On hold). Only the current ingredient strongly highlighted. Operator cannot select a future ingredient.

**Center — Main instruction:** current step in very large text with an obvious action button.

**Right — Visual guidance:** ingredient location, rack, bin, identification, handling instructions; simple diagrams and large labels. Supervisor configures rack/bin locations if not supplied. Do not fabricate locations.

---

# 7. Step-by-step operator experience

## Step 1: Find the ingredient
**STEP 1: FIND INGREDIENT** — e.g. Ingredient #8, Bergamot Oil, Calabria, Required weight 180.0 g, Location **RACK C — BIN 08**, with a diagram highlighting rack and bin.
Button **I FOUND THE BOTTLE**: record the action, move to scan stage, do not mark verified yet. Large **CALL SUPERVISOR** button if not found.

## Step 2: Scan the ingredient
**STEP 2: SCAN INGREDIENT** — "Scan the barcode on the bottle." Large scanner icon, expected ingredient, scanner status, success/error area.
Correct scan: verify identity, lot and eligibility if lot tracking enabled, large green confirmation, unlock weighing.
Wrong scan: large red warning, explain expected ingredient ("Wrong ingredient. Please scan Bergamot Oil, Calabria."), keep step locked, record the incorrect scan.
Do not rely on color alone. Operator never enters a barcode manually in the normal workflow.

## Step 3: Weigh the ingredient
Large weighing screen — Required 180.0 g, Current 178.5 g, **ADD 1.5 g MORE**. Live scale reading when connected. Show required, current stable weight, difference, tolerance, measurement status.
Messages: Underweight "Add 1.5 g more." · Within tolerance "Weight correct." · Overweight "Too much added. Stop and follow the correction instruction." · Unstable "Wait. Keep the container still." · Disconnected "Scale disconnected. Call supervisor."
Next ingredient stays locked until weight passes configured verification rules. Account for scale resolution, measurement uncertainty, stability, recipe tolerance. Never silently round an invalid measurement into acceptance.

## Step 4: Confirm ingredient completion
**INGREDIENT COMPLETED** — "Good. Move to the next ingredient." — **NEXT INGREDIENT**.
Record required qty, actual accepted qty, scale reading, ingredient ID, lot ID, operator ID, timestamp, verification status, prior deviations and corrective actions. Next step locked until the backend has committed the previous step.

## Step 5: Repeat
Progress: **4 OF 12 INGREDIENTS COMPLETED** with large bar. Don't overwhelm during weighing. Pause only if procedure allows. On refresh/disconnect, recover the last committed step and instruct the operator to verify equipment state before resuming.

---

# 8. Language and audio assistance

English, Hindi, Malayalam in the operator interface; visible simple language selector. All instructions, buttons, statuses, and important errors translated. Supervisor sets default language per station.
Optional audio: "Correct ingredient.", "Scan again.", "Add more.", "Weight correct.", "Call supervisor.", "Job completed." Short cues for success/warning/error. Audio can be disabled or adjusted. Written instruction always stays visible.

---

# 9. Final job completion

**ALL INGREDIENTS COMPLETED** — perfume name, batch ID, formula revision, ingredient count, start time, completion time, duration, deviations, approval status. Primary action **SUBMIT FOR APPROVAL**.
Verify all required steps complete and exceptions addressed. On submit: lock batch from routine operator modification, record submission, notify supervisor, generate report draft. Show "Your job has been submitted to the supervisor."
On rejection: show reason, return job to an authorized correction/review state, preserve the original record and every subsequent action.

---

# 10. Supervisor approval and reporting

Submitted batches list: batch ID, perfume, operator, station, start/end, ingredient verification status, exceptions, submission time.
Batch detail: complete chronological manufacturing report; per ingredient: target weight, actual accepted weight, tolerance, barcode scan details, weight history, corrections, verification result, operator actions.
Actions: Approve · Reject · Request review · Add comment · Place on hold. Every decision recorded with supervisor identity and timestamp.
After approval: print report, download PDF, download CSV, view full batch history. Professional print-friendly report with company logo, production details, approved formula revision, operator details, measurements, deviations, approval signature information.

---

# 11. Operator hardware integration

Equipment: QR/barcode scanner, touchscreen with local CPU, fingerprint reader or biometric device, digital weighing machine, printer.

**Scanner:** keyboard-emulating, USB or Bluetooth; auto-capture, identify, immediate feedback, reject wrong ingredients, record failed scans.
**Weighing machine:** adapter layer for the company's scale models; USB serial, Web Serial, Bluetooth where compatible, local device bridge where required. Don't assume a universal Bluetooth protocol. Show scale status separately from calibration status. Require authorized equipment validation before a station may certify production measurements.
**Biometric device:** secure compatible or device-native authentication; no raw fingerprint/face data stored; configurable to the actual device.
**Printer:** station's configured printing environment; printer-friendly format; thermal or standard; print preview; clear error if printing fails.

---

# 12. Supervisor and admin dashboard

Separate, desktop-oriented layout with sidebar.
- **Overview:** active orders, jobs assigned, in progress, completed, pending approvals, on hold, active stations, equipment alerts.
- **Production monitoring:** station status cards (Station 01 · Operator Suresh · Oud Royale · 4/12 · Weighing · Scale Connected) with access to batch timeline and alerts.
- **Recipe and SOP management:** upload SOPs, review extracted data, create formulas, manage revisions, set mixing sequences, quantities, tolerances, ingredient locations, approve recipes. Historical batches retain their original approved recipe version.
- **Operator management:** create accounts, assign roles, enroll authentication credentials, station access, manufacturing history, authorization, authentication events.
- **Reports and audit logs:** searchable logs for wrong scans, under/overweight readings, instability, pauses, supervisor calls, rejected batches, approval decisions, device disconnections, sync errors, admin changes. Filters: date, operator, station, batch, event.

---

# 13. Offline-first local server and cloud synchronization

All manufacturing transactions saved to local PostgreSQL first; must keep working without internet.
**Sync:** detect connectivity, queue unsynced records, auto-sync, periodic sync, retry, status display, unique IDs, no duplicate cloud records, log attempts and errors. Transactional outbox pattern or equivalent.
**Conflicts:** never silently overwrite; completed records immutable; preserve both versions, record conflict, notify admin, controlled resolution. Cloud errors must never interrupt valid local operations. Local and cloud records traceable by unique IDs. Clear sync indicator on supervisor interface.

---

# 14. Complete activity audit trail

Capture: operator authentication, job assignment, SOP upload, formula approval, location confirmation, scan attempts, weight readings, rejections, accepted measurements, ingredient completion, pause, resume, supervisor intervention, submission, approval, rejection, report generation, print attempt, cloud sync.
Each event: event ID, timestamp, user ID, role, batch ID, station ID, event type, details, outcome, previous state, new state, source device, sync status.
Append-only at application level. Restricted access; secure retention and backup policy.

---

# 15. Manufacturing rules (enforced on the backend)

1. Operator must authenticate before entering the production interface.
2. Operator can only access assigned jobs and authorized stations.
3. Job must use an approved SOP or formula revision.
4. Ingredients processed in the approved sequence.
5. Ingredient barcode must match the expected ingredient.
6. Lot eligibility checked where required.
7. Scale must be ready and validated.
8. Weight acceptance uses approved tolerance and stability requirements.
9. Operator cannot skip an ingredient.
10. Next ingredient not unlocked until the previous step is committed.
11. Incorrect scans and invalid measurements recorded.
12. Corrections follow approved procedures.
13. Supervisor interventions auditable.
14. Batch completion requires all mandatory steps to pass.
15. Batch cannot be approved while mandatory exceptions remain unresolved.
16. Offline transactions stored locally and synchronized reliably.
17. No historical measurement may be silently edited or deleted.

---

# 16. Security and VAPT readiness

Secure authentication, RBAC, session protection, input validation, rate limiting, secure API handling, SQL injection protection, XSS protection, CSRF where applicable, secure password storage, audit logging, secrets management, dependency scanning, error handling, secure sync, network restrictions for the local server.
Prepare: security test environment, architecture documentation, API endpoint inventory, role/permission matrix, known limitations register, remediation tracker.
Final delivery includes a VAPT report with issue status. Do not fabricate a passed VAPT report. Statuses: Open · In Progress · Fixed · Retest Required · Verified Closed · Accepted Risk. Provide the template and evidence structure if the independent assessment hasn't happened yet.

---

# 17. Local deployment and Azure DevOps

Code maintained in the company's Azure DevOps repository. Provide: repo structure, branching conventions, environment configuration, DB migration instructions, local server deployment guide, cloud sync configuration, build and release instructions, backup and recovery procedures.
Simple startup — operator never launches a terminal, configures DB connections, or opens a second app. Optional service wrapper to auto-start on boot. Deployment guide distinguishes the main app from any hardware bridge or background sync service.

---

# 18. Final UI quality requirements

Large descriptive buttons: START JOB · I FOUND THE BOTTLE · SCAN INGREDIENT · WEIGH INGREDIENT · WEIGHT CORRECT · NEXT INGREDIENT · CALL SUPERVISOR · SUBMIT FOR APPROVAL. Avoid technical labels (Execute transaction, Initialize process, Validate payload, Commit state, Continue workflow).
Visual feedback: large success indicators, visible warnings, simple error explanations, large weight values, progress bars, simple location diagrams, large current-step labels. Never make the operator guess.
Accessibility: touchscreen, glove-friendly targets, readable text, not color alone, optional audio, multiple languages, essential actions visible. Designed for real use at a mixing station.

---

# 19. Development and acceptance criteria

**Phase 1 — Operator experience:** authentication, assigned job list, location guidance, barcode scanning, simulated weighing, strict progression, job completion.
**Phase 2 — Supervisor system:** SOP upload, formula review, job assignment, production monitoring, batch approval, report generation.
**Phase 3 — Manufacturing backend:** local database, state machine, audit logging, error handling, offline recovery.
**Phase 4 — Hardware integration:** real scanner, real scale, biometric authentication, printer.
**Phase 5 — Cloud sync and security:** cloud sync, retry and conflict management, security testing, VAPT preparation and assessment, remediation and retesting.

### Final acceptance test
A non-technical operator can: (1) authenticate with an approved biometric method, (2) open an assigned job, (3) understand which ingredient to collect, (4) find the rack and bin, (5) scan the ingredient, (6) see whether it's correct, (7) weigh it, (8) get clear instructions if too low/high, (9) complete the step only when it meets requirements, (10) continue through every ingredient, (11) submit for supervisor approval.

The supervisor can assign the job, monitor production, inspect the complete activity history, approve or reject the batch, and download or print the final report.

**The final result must feel like a dedicated industrial manufacturing console: simple for the operator, comprehensive for the supervisor, reliable offline, and traceable at every step.**
