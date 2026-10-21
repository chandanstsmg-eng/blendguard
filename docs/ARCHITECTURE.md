# BlendGuard architecture

## One process, one origin

```
 Station PC: Edge full-screen + scale bridge        Scientist PC (browser)
   │  https://server:4300        │ /bridge (key)               │
   └──────────────┬──────────────┴─────────────────────────────┘
                  ▼
   ┌───────────────── BlendGuard (Node.js, one process) ─────────────────┐
   │  React screens (static build)    REST API /api/*    Socket.IO       │
   │                                                                      │
   │  batch.service  ── state machine + all manufacturing rules          │
   │  auth.service   ── WebAuthn (fingerprint/face), PIN, sign-off       │
   │  scale.service  ── simulator · SERIAL (COM on server) · BRIDGE      │
   │  audit.service  ── append-only audit trail                          │
   │  db/backup      ── nightly + pre-update backups                     │
   └───────────────────────────────┬──────────────────────────────────────┘
                                   ▼
            Local PostgreSQL 18 (data/pg, started by BlendGuard via pg_ctl)
```

* The operator never opens a terminal or a second application. The server runs
  `START-BLENDGUARD.bat` (or the start-up task); each station runs `START-STATION.bat`.
* **Scales.** The server makes every weighing decision from its own latest reading; screens
  only display. A METTLER TOLEDO scale speaks MT-SICS (`server/scale/mtsics.ts`,
  `sics-driver.ts`): BlendGuard polls `SI` (weight, stable flag) and `TA` (the scale's own
  tare, added back so the scale's TARE key cannot hide weight). On a station PC the scale
  bridge (`scripts/scale-bridge.ts`) runs the same driver and streams readings over the
  `/bridge` Socket.IO channel, signed in with that station's bridge key. A reading older
  than 2.5 s counts as "not connected" and blocks weighing.
* **Audit trail as outbox.** `AuditEvent` rows carry `syncStatus = PENDING`, so a future
  cloud sync can read them as a transactional outbox. Manufacturing never waits for it.

## The manufacturing state machine

```
batch:  ASSIGNED → IN_PROGRESS ⇄ PAUSED
                   IN_PROGRESS ⇄ ON_HOLD            (scientist)
                   IN_PROGRESS → AWAITING_SUBMISSION → SUBMITTED (locked)

step:   LOCKED → CURRENT[FIND → SCAN → WEIGH] → COMPLETED
                 CURRENT ⇄ ON_HOLD                  (vessel changed; a scientist releases)
```

Every change runs in one database transaction:
1. lock the batch row (`SELECT … FOR UPDATE`);
2. check access, check the optimistic `version`, and check that the step and stage are current;
3. apply the change;
4. write the audit event;
5. commit, then push the new state to the station.

The next ingredient becomes `CURRENT` **in the same transaction** that commits the
previous ingredient's accepted weight (rule 10).

### Weighing

* **The server reads the scale; the browser never submits a weight.** The screen only
  shows the server's live stream, and acceptance uses the server's own latest stable reading.
* All weights are whole **milligrams**, so no floating-point rounding enters a decision.
* **Acceptance window:** `[target − tol⁻ + U, target + tol⁺ − U]`, where `U` is the
  scale's expanded uncertainty (at least one division). It is a guard band, so a reading
  that lies within uncertainty of a tolerance limit is not accepted. If no window remains,
  the result is `CANNOT_CERTIFY`.
* **Too much poured:** a stable reading above the window is recorded as an `OVERWEIGHT`
  problem (once per over-pour, with the reading). The step is **not** held and no scientist is
  called. The station sounds a 7.5-second two-tone alarm (even with its sound switched off) and
  says how much too much. The operator takes the extra out, and saving is refused while the
  scale still shows too much. When the correct weight is saved, the problem closes itself
  (`EXCESS_REMOVED_BY_OPERATOR`) with the gross weight before and after and the amount removed.
  If the container already held earlier ingredients, the record says they may be affected, for
  the scientist's review before approval.
* **Vessel continuity:** before each ingredient, the vessel must weigh what it weighed
  when the previous ingredient was accepted (within `vesselDriftLimitMg`). Otherwise the
  step is put on hold.
* **Daily scale check:** weighing is blocked until a scientist records a passing check,
  which is valid for 24 h. Scale connection and check status are shown separately.

### Immutability (rule 17)

Database triggers (in `prisma/migrations/*_immutability`) refuse:
* `UPDATE`/`DELETE` on `WeightReading`;
* `DELETE` on `AuditEvent`, and `UPDATE` of anything except its sync bookkeeping columns;
* `DELETE` on `Deviation` and `BatchStep`;
* any change to an accepted step's weight, tare, lot or target.

## Identity

* **Fingerprint / face:** WebAuthn passkeys held by the station's biometric hardware
  (Windows Hello fingerprint reader or IR camera, or a FIDO2 fingerprint key). The match
  happens inside the device. BlendGuard stores only the credential's **public key**, and
  checks the signature, the one-time challenge, the origin, the user-verified flag and the
  signature counter. On-screen animation runs only while the real device prompt is open.
* **Fallbacks:** Operator ID + PIN, and scientist-assisted sign-in. Each is allowed only
  where a scientist has enabled it for that station.
* **Lockout:** 5 failures lock the account for 15 minutes, and every attempt is audited.
* **Station identity:** a random token in an httpOnly cookie, issued when a scientist
  binds the PC. Operator sessions are bound to that station.
* **CSRF:** cookies are `SameSite=Strict`, and every state-changing call must carry
  `X-BlendGuard: 1`.

## API inventory

| Method | Path | Who | Purpose |
|---|---|---|---|
| GET | /api/health | anyone | liveness |
| GET | /api/auth/me | anyone | current user + station |
| POST | /api/auth/webauthn/options, /verify | station | fingerprint / face sign-in |
| POST | /api/auth/pin | station | Operator ID + PIN (if allowed) |
| POST | /api/auth/assisted | station | scientist-assisted sign-in (if allowed) |
| POST | /api/auth/login | anyone | scientist sign-in |
| POST | /api/auth/signoff | operator session | scientist sign-off token (station + batch bound, 5 min) |
| POST | /api/auth/logout | session | end session |
| POST | /api/me/language | session | remember language |
| GET | /api/operator/jobs | operator | assigned jobs at this station (ordered by state, then planned start) |
| GET | /api/batches/:id/run | assigned operator | run state |
| POST | /api/batches/:id/start · pause · resume · recovery-check · submit | assigned operator | job lifecycle |
| POST | /api/batches/:id/steps/:seq/found · scan · tare · accept | assigned operator | step actions (a correct scan from FIND also records the bottle as found) |
| POST | /api/batches/:id/steps/:seq/lab-skip · lab-arrived | assigned operator | send the current bottle for lab test (before zeroing); mark a lab bottle arrived |
| POST | /api/batches/:id/supervisor-action | operator session + sign-off token | release holds |
| POST | /api/calls · GET /api/station/call | operator / station | calls to the scientist |
| GET | /api/station/scale | session at station | live reading |
| POST | /api/station/scale/sim · GET /api/batches/:id/sim-bottles | operator, training stations only | simulator |
| GET | /api/ingredients/:id/photo | any session | bottle photo (URL carries the upload time) |
| GET | /api/supervisor/overview | scientist | monitoring data (floor monitor, jobs & calls) |
| GET | /api/supervisor/report?date= | scientist | shift report for one day |
| POST | /api/supervisor/jobs | scientist | assign job |
| POST | /api/supervisor/batches/:id/steps/:seq/skip · lab-release | scientist | skip an ingredient for lab test; mark it arrived |
| POST | /api/supervisor/calls/:id/ack · close | scientist | calls |
| POST | /api/supervisor/stations/:id/validate-scale | scientist | daily scale check |
| POST | /api/{supervisor,admin}/stations/:id/bind | scientist | set up this PC as a station |
| POST | /api/{supervisor,admin}/operators/:id/webauthn/options · verify · unlock | scientist | enrolment, unlock |
| POST | /api/{supervisor,admin}/credentials/:id/revoke | scientist | remove a device |
| GET · POST · PATCH | /api/admin/users · /users/:id · /users/:id/secret | scientist | user accounts, roles, stations, PIN / password reset |
| GET · PATCH | /api/admin/stations · /stations/:id | scientist | station settings (sign-in methods, language, sound, pause, auto-save, idle sign-out) |
| GET · PATCH · PUT | /api/admin/ingredients · /ingredients/:id · /ingredients/:id/photo | scientist | bottle colour, photo, shelf place, safety pictures |
| GET | /api/admin/formulas | scientist | formulas and revisions (read-only) |
| GET | /api/admin/audit | scientist | audit trail, filtered and paged |

The `/api/admin/*` paths are kept for the *Setup* screens; there is no separate administrator role.

Live updates: the `supervisors` socket room also receives `floor-scale` (every
station's scale, at most ~2–3 per second per station) for the floor monitor.

## Role and permission matrix

Two roles, each with its own area: operators (`/operator`) and scientists (`/supervisor`;
the role is stored as `SUPERVISOR`). The scientist console opens on *Assign job* and has a
*Daily work* group and a *Setup & records* group; the old `/admin` address opens *Setup → Users*. A database migration turns any
earlier `ADMIN` account into a scientist. The server enforces the same split
(`server/middleware/context.ts`).

| Capability | Operator | Scientist |
|---|:---:|:---:|
| Run assigned jobs at authorised stations | ✔ | |
| Send the current bottle for lab test; mark a lab bottle arrived | ✔ | ✔ |
| Call the scientist | ✔ | |
| Sign off holds at a station; assisted operator sign-in | | ✔ |
| Floor monitor, handle calls, shift report, activity log | | ✔ |
| Assign jobs from approved formulas | | ✔ |
| Daily scale check | | ✔ |
| Approve / reject a submitted batch | | ✔ |
| Set up a PC as a station | | ✔ |
| Enrol / revoke biometric devices, unlock accounts | | ✔ |
| Create / edit / switch off users, reset PIN or password | | ✔ |
| Station settings | | ✔ |
| Ingredient colour, photo, shelf place, safety pictures | | ✔ |
| View formulas, audit trail | | ✔ |

**Separation of duties:** a scientist cannot approve or reject a batch they worked on
themselves (`OWN_BATCH`), and a batch weighed on the training simulator can never be
approved (`TRAINING_RECORD`). A scientist cannot switch off their own account.

## Operator screens (designed for low literacy)

- One screen per step, with a picture: **take the bottle** (photo or drawn bottle in
  its cap colour, the rack-bin badge, the rack map, safety pictures) → **set to 0** →
  **pour** (the whole panel turns yellow / green / red) → **saved**.
- Scanning the right bottle moves straight to weighing — there is no separate "found" tap.
- **LAB TEST** (find/scan and set-to-zero screens, only before the scale is zeroed for that
  bottle; asks yes / no first) sends the bottle for lab test; it is added at the end. When it
  comes back the operator presses **ARRIVED** next to it on the waiting-for-lab screen, then
  **CONTINUE**. It is still scanned before weighing, so a quarantined, rejected or expired lot
  is refused at the scan.
- Jobs are listed by state, then planned start time.
- The weight saves itself once it has been correct and steady for 2 s (station setting
  *auto-save*), and the "saved" screen moves on by itself after 3 s.
- Every screen speaks its instruction; the **REPEAT** button says it again. Recorded
  clips replace the computer voice where provided (see [AUDIO.md](AUDIO.md)).
- Stopping work and signing out ask first with tick / cross pictures. After the station's
  idle time (default 10 min) the operator is asked "are you still here?" and then signed out.
- A narrated five-picture **HOW TO** guide opens by itself on an operator's first sign-in.
- Batch numbers, formula codes and revisions are not shown to operators; they stay in the
  record (folded "Details" on the last screen) and on the scientist screens.
