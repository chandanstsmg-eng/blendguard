# BlendGuard

**Every Ingredient. Every Gram. Every Time.**

Operator guidance and precision weighing for perfume manufacturing. One application,
one command, one address. It runs on a local server with its own PostgreSQL database,
so production does not depend on the internet.

> Ready for plant pilot with METTLER TOLEDO scales (MT-SICS over USB / RS-485 / RS-232).
> Open items before full production use are listed in [docs/KNOWN-LIMITATIONS.md](docs/KNOWN-LIMITATIONS.md);
> installing at a plant: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Start it

Requirements: Windows 10/11 (x64) and Node.js 20 or newer. Nothing else: the database is built in.

```
npm install
npm start
```

Open **http://localhost:4300** (https once a certificate is set up). Which file to run where:

| PC | Run | It does |
|---|---|---|
| Server | `START-BLENDGUARD.bat` (or `scripts/install-autostart.ps1` once) | Database, screens, scales; restarts itself after an error |
| Each mixing station | `START-STATION.bat` | Opens the server full-screen (kiosk) and starts the scale bridge for the scale on this PC |
| Control room | `START-SUPERVISOR-MONITOR.bat <server>` | Scientist floor monitor, full-screen |

There are two roles, each with its own area: **operators** (`/operator`, station touchscreen)
and **scientists** (`/supervisor`). The scientist console opens on *Assign job* and has two
groups: *Daily work* (assign job, jobs and calls, floor monitor, scale checks, shift report) and
*Setup & records* (users, station setup, ingredients, formulas, logs; *Logs* has the operator
activity log and the full audit trail). The old `/admin` address
opens *Setup → Users*. See the permission matrix in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

On first start BlendGuard:
1. creates `.env` with random secrets,
2. creates and starts the local PostgreSQL database in `data/pg`,
3. applies database migrations (after a backup, on later starts),
4. creates one `scientist` account (password in `data/FIRST-SIGN-IN.txt`), or loads demo data
   when `SEED_DEMO=1` (training PCs) or in developer mode,
5. builds the screens, then serves everything on one port.

`Ctrl+C` stops the app and the database cleanly. A backup is made every night (`data/backups`).

| Command | What it does |
|---|---|
| `npm start` | Run BlendGuard (production build) |
| `npm run dev` | Developer mode with live reload (loads demo data into an empty database) |
| `npm test` | Rule tests against a throw-away database |
| `npm run typecheck` | TypeScript checks for screens and server |
| `npm run backup` | Make a backup now |
| `npm run restore-backup -- <file>` | Restore a backup (stop the app first; the current data is kept aside) |
| `npm run scale-bridge -- --list` | Show this PC's COM ports (for the scale) |
| `npm run reset-demo` | **Deletes all data** and reloads the demo (asks first, backs up first; stop the app first) |
| `npm run voices` | Re-records voice clips after a `say.*` translation changed (needs internet once, see [docs/AUDIO.md](docs/AUDIO.md)) |
| `npm run db:stop` | Stop the built-in database if it was left running |

## Demo walk-through

On a training or demo PC (`SEED_DEMO=1`, `npm run dev` or `npm run reset-demo`). Passwords and
the PIN are in `.env` (`DEMO_SUPERVISOR_PASSWORD`, `DEMO_ADMIN_PASSWORD`, `DEMO_OPERATOR_PIN`).

1. **Set up this computer as a station.** On the first screen choose *Scientist sign-in*,
   use `scientist`, then go to *Scale checks* and choose *Use this computer as ST-01*. Sign out.
2. **Operator sign-in.** Choose *Use number + PIN*, enter `1001` (Suresh Kumar) and the PIN.
   With a fingerprint reader or camera set up in Windows Hello, a scientist can
   register the operator (*Setup → Users → Register*). After that the operator only
   touches the fingerprint picture. The narrated **HOW TO** guide opens on first sign-in.
3. **Run the job.** Press the big orange *START*. For each bottle: look at the picture and the
   coloured rack badge → scan it → put the container on the scale, touch *Container 1, 2 or 3* and
   press *SET TO 0* (the container number is then recorded and locked) → pour until the screen
   turns **green** (it saves by itself) → the next bottle comes up by itself.
   Stations ST-01 and ST-02 use the **training simulator** (amber *Practice tools* panel at the
   bottom left). It stands in for the scale and barcode scanner. A real keyboard-style USB or
   Bluetooth scanner also works on every station.
4. **Try the safeguards.** Scan the wrong bottle, overpour (screen turns red, a two-tone alarm
   sounds, then the voice says how much too much; take the extra out with the *−1* / *−0.1*
   buttons in the practice tools and the weight saves as usual), unplug the simulated scale, press *PAUSE*, or reload the page in the middle of a step.
5. **Finish.** *SEND TO SCIENTIST* locks the batch. *DOWNLOAD REPORT* saves a printable
   work summary (each ingredient, container, weights, completion time and total time taken).
6. **Scientist.** Sign in as `scientist` on another PC or browser: the **Floor monitor**
   shows every station live, sounds an alert for calls and holds, and *Shift report* summarises the day.
   *Logs → Operator activity* shows one operator's whole day, sign-in to sign-out, ready to print or export.
   *Assign job → Upload* (top right) imports a production instruction CSV for review and approval.
7. **Lab ingredients.** At the station, press *LAB TEST* on the find/scan or set-to-zero screen
   (only before the scale is zeroed for that bottle) and answer yes. Or, as a scientist, open a job
   in *Jobs & calls* and press *Skip for lab* on an ingredient (a reason is required). The operator
   carries on with the other bottles. When everything else is done the job waits for the lab (the
   station is free for other jobs). When the lab bottle comes back, the operator presses *ARRIVED*
   next to it, then *CONTINUE* (a scientist can also press *Lab ingredient arrived* in the job
   window). The bottle is still scanned before weighing, so a lot in quarantine, rejected or expired
   is refused. Who skipped it and who marked it arrived is on the batch record and audit trail.
   The final report (*Final report* in the job window) lists the lab ingredients.
   **From a process order PDF:** *Assign job → Upload PDF / CSV*, choose
   `docs/samples/process-order-sample.pdf`, tick *Lab* on an ingredient, approve, then assign it.
   The ticked ingredient starts as skipped. Reports (operator and scientist) are PDFs in the
   PROCESS ORDER layout; put the company logo at `public/company-logo.png` to print it.
8. **Setup.** As a scientist, under *Setup*: add users, change station settings (*Station setup*),
   and under *Ingredients* set each bottle's colour, photo, shelf place and safety pictures —
   exactly what operators see.
9. **Approve.** A scientist cannot approve a batch they worked on themselves; the demo has two
   scientist accounts so the other one can. Batches weighed on the training simulator (ST-01,
   ST-02) can never be approved.

| Demo account | Sign-in | Notes |
|---|---|---|
| Operators 1001–1004 | number + PIN | 1001/1002 work at ST-01 and ST-02; 1003 at ST-02/03; 1004 at ST-01 |
| `scientist` (Meena Rao) | username + password | Scientist: everything in *Daily work* and *Setup & records* |
| `scientist2` (Arjun Shetty) | username + password | Scientist, same rights; the second scientist approves a batch the first worked on |

## Layout

```
server/         Express API, Socket.IO, manufacturing state machine, scale layer
  services/batch.service.ts   ← every manufacturing rule (spec §15) lives here
  services/scale.service.ts   ← scales: training simulator, SERIAL (server PC), BRIDGE (station PC)
  scale/                      ← METTLER TOLEDO MT-SICS driver and the scale bridge's server end
  db/backup.ts                ← nightly backups and restore
  services/auth.service.ts    ← WebAuthn fingerprint/face, PIN, scientist sign-off
scripts/        Scale bridge, certificate, auto-start, backup/restore, voice recording
shared/         Code used by both server and screens (weight acceptance rules, types)
src/            React screens: pages/operator, pages/supervisor, pages/admin
public/audio/   Recorded voice clips, English / Hindi / Malayalam (docs/AUDIO.md)
prisma/         Database schema, migrations (incl. immutability triggers), demo seed
tests/          Rule tests (real HTTP + real PostgreSQL)
docs/           Architecture, API inventory, roles, limitations
data/           Local database, logs (not in git)
```

More in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

Going live or presenting: follow [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).
