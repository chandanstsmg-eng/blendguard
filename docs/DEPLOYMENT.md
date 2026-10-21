# Deployment checklist

Installing BlendGuard at a plant, top to bottom. Each step says where it is done. Open items
are in [KNOWN-LIMITATIONS.md](KNOWN-LIMITATIONS.md).

```
            plant network
 ┌───────────────┐        ┌──────────────────────────┐
 │  SERVER PC    │◄──────►│  STATION PC (one per      │
 │  BlendGuard   │        │  mixing station)          │
 │  database     │        │  Edge, full screen        │──USB──► METTLER TOLEDO scale
 │  backups      │        │  scale bridge             │──USB──► barcode scanner
 └───────────────┘        └──────────────────────────┘
        ▲
        └──── scientist PCs (any browser)
```

## 1. Before the hardware arrives

- [ ] Note for every scale: model, serial number, **readability** (e.g. 0.01 g), and the
      **expanded uncertainty** from its calibration certificate (in mg). Both go into
      Setup → Station setup → Scale settings and set the acceptance limits.
- [ ] On each scale: set the interface to **MT-SICS** (Mettler menu: *Communication* / *Interface*),
      and note its **baud rate** and **data format** (usually 9600, 8N1). Lock or disable the
      scale's own TARE key if the model allows it.
- [ ] One name for the server PC on the network (e.g. `blendguard-srv`), with a fixed IP or DNS entry.

## 2. Server PC

- [ ] Windows 10/11 x64, **Node.js 20 or newer** (LTS from nodejs.org).
- [ ] Copy the BlendGuard folder (without `data/`, `node_modules/`, `dist/`) and run
      `npm install --omit=dev` once (**needs the internet**).
- [ ] Start once with `START-BLENDGUARD.bat window`. It creates `.env` with random secrets, the
      database in `data/pg`, and one scientist account, `scientist`: the password is in **`data\FIRST-SIGN-IN.txt`**
      (and on screen). No demo users or jobs are created on a live install.
- [ ] **HTTPS** (needed for fingerprint / face sign-in from the stations), in PowerShell:
      `powershell -ExecutionPolicy Bypass -File scripts\make-certificate.ps1`. It makes a certificate
      for this PC's name, saves it in `data\tls`, and switches `.env` to HTTPS. If the plant has its
      own certificate authority, use a certificate from it instead (`TLS_PFX` in `.env`).
- [ ] **Backups**: set `BACKUP_COPY_TO` in `.env` to a folder on another disk or a network share.
      A backup is made every night at 02:00 and before every update; check `data\backups` the next day.
      Restore test: `npm run restore-backup -- data\backups\<file>` on a spare PC.
- [ ] **Start with Windows**: `powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1`
      (as administrator). BlendGuard then starts at power-on and restarts itself after an error.
- [ ] Windows: set the time zone to India Standard Time, turn off sleep, put the PC on a UPS.

## 3. Accounts

- [ ] Sign in as `scientist` with the first-sign-in password, then *Setup → Users → Reset password*
      on `scientist` straight away, and delete `data\FIRST-SIGN-IN.txt`.
- [ ] Create the scientists and operators. There are only these two roles; scientists also do
      all setup. Create at least two scientists: a scientist cannot approve a batch they worked
      on themselves. Operators: number, PIN, language, and the stations they may use.

## 4. Each station

On the server (*Setup → Station setup*):

- [ ] *Add station* (code and name), then *Scale settings*: **Into the station PC**, scale model,
      COM port, baud rate, data format, readability, uncertainty, container drift limit.
- [ ] *Create bridge key*: note the three values shown (server, station, key).
- [ ] Sign-in methods, language, idle sign-out, sound.

On the station PC:

- [ ] Node.js, the BlendGuard folder, `npm install --omit=dev` (as on the server; no database runs here).
- [ ] Plug in the scale (USB). `START-SCALE-BRIDGE.bat list` shows the COM ports: the USB-to-RS-485
      adapter appears as e.g. `COM5`. Put that port in the station's Scale settings.
- [ ] Edit `START-SCALE-BRIDGE.bat`: `SERVER`, `STATION`, `KEY` from the bridge key dialog.
- [ ] Edit `START-STATION.bat`: `SERVER=https://<server-name>:4300`.
- [ ] Copy `data\tls\blendguard.cer` from the server next to `INSTALL-CERTIFICATE.bat` and run that
      as administrator (once).
- [ ] Put a shortcut to `START-STATION.bat` in the Startup folder (`shell:startup`). For a fully
      locked station also use Windows *Assigned Access* (kiosk account).
- [ ] Restart the PC. Setup → Station setup should now show **Bridge online** and the live weight.
      Put something on the scale: the weight must change within a second; press the scale's TARE
      key: the gross weight shown in Station setup must **not** change.
- [ ] Barcode scanner: plug in (keyboard mode, Enter suffix). Scan one bottle on the scan screen.
- [ ] A scientist signs in on the station once and links it (*Scale checks → Use this computer as …*),
      then does the **scale check** with a reference weight. Weighing is blocked until then, and every day after.
- [ ] Fingerprint / face: a scientist registers each operator on that station
      (*Setup → Users → Register*). Windows Hello must be set up on the PC.

## 5. Ingredients and formulas

- [ ] Setup → *Ingredients*: *Add ingredient* for every material (code as in SAP, name, bottle
      barcode), then its cap colour, photo, rack and bin, hazards and protective equipment.
- [ ] *Assign job → Upload PDF / CSV*: upload a real SAP process order PDF, check the
      preview (quantities, units, tolerances), approve, assign. Lines too small to weigh on the
      station's scale are flagged in the preview.
- [ ] Company logo for screens and reports: `public\company-logo.png` (wide PNG), then restart.

## 6. Languages and voice

- [ ] **Native-speaker review** of the Hindi and Malayalam operator text in `src/lib/i18n.ts`
      (lines marked `// review` first). Then, on a PC with internet: `npm run voices`, and copy
      `public\audio` to the server. The plant never needs the internet for voice: all phrases,
      numbers and rack letters are recorded clips ([AUDIO.md](AUDIO.md)).
- [ ] On each station: sign in, switch EN → हिं → മ, start a job and listen to each screen.

## 7. Go-live checks

- [ ] A complete practice job on each station with the real scale: zero, pour, overpour (red
      screen, two-tone alarm even with the station's sound off, take the extra out, the correct weight saves), scan a
      wrong bottle, *LAB TEST* on one bottle and *ARRIVED*, pull the scale cable (weighing stops).
- [ ] A scientist who did not work on the batch approves it; the PDF shows the letterhead,
      weights, scale, approver.
- [ ] Before handing over, on the build PC:

```
npm run typecheck
npm test
npm run build
```

All three must pass.
