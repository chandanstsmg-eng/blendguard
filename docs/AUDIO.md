# Voice

Every operator instruction is spoken in English, Hindi or Malayalam, **offline**. Nothing is
sent to an online service, so formula quantities never leave the plant.

1. **Fixed phrases** are one recorded clip each: `public/audio/<lang>/<key>.mp3`, listed in
   `public/audio/manifest.json`, made with Microsoft's natural Indian voices (Neerja – English,
   Swara – Hindi, Sobhana – Malayalam).
2. **Phrases with a number** are put together from recorded pieces. `say.pour` ("Pour slowly.
   You need {g} grams.") plays `say.pour.0` + the number + `say.pour.1`. Numbers are
   `num.0` … `num.100`, `num.200` … `num.900`, `num.thousand` and `num.point`; rack letters are
   `chr.A` … `chr.Z`. A person's name is not spoken (it cannot be pre-recorded).
   All pieces of a phrase are decoded before it starts, the silence at the ends of each piece is
   trimmed, and the pieces play back-to-back with a short, even pause, so there are no gaps in
   the middle of a sentence.
3. **The PC's own voice** reads a phrase only if one of its pieces is missing. Windows usually
   has only English voices, so Hindi / Malayalam phrases are then read in English.

`VOICE_ONLINE=1` in `.env` re-enables the old online voice route; leave it off in production.

**Overpour alarm.** When an operator pours over the upper limit, the station first sounds a
7.5-second two-tone alarm (even if the station's sound switch is off), then says how much too
much and to take the extra out (`say.over`). Each time the scale settles while there is still
too much, it says the new amount. The alarm stops as soon as the weight is back in range.

## After correcting a translation

If a native speaker corrects a `say.*` phrase in `src/lib/i18n.ts`, re-record the clips so
the voice matches the screen (needs the internet):

```
npm run voices            # only phrases whose text changed
npm run voices -- --all   # everything
```

This also records the pieces of phrases with a number, the number words and the letters.
The internet is needed only on the PC that runs it; copy `public/audio` to the server and restart.

## Replacing a clip with a real person's voice

A recording of a staff member can replace any clip:

## How to add recordings

1. Record each phrase as a short MP3 (mono, 44.1 kHz, about 1–4 seconds, no long silence
   at the start). A phone voice-recorder app is fine; record in a quiet room.
2. Name the file after the phrase key and put it in the language folder:

   ```
   public/audio/hi/say.scanNow.mp3   ← "अब बारकोड स्कैन करें।"
   public/audio/ml/say.scanNow.mp3   ← "ഇപ്പോൾ ബാർകോഡ് സ്കാൻ ചെയ്യുക."
   ```

3. List the keys you recorded in `public/audio/manifest.json`:

   ```json
   { "en": [], "hi": ["say.scanNow", "say.correct"], "ml": ["say.scanNow"] }
   ```

4. Restart BlendGuard (`npm start` rebuilds the screens when files change).

Phrases not in the manifest keep using the computer voice, so you can add recordings a
few at a time. If a clip cannot be played, the computer voice is used instead.

## Phrases worth recording first

The exact wording for each language is in `src/lib/i18n.ts` (`say.*` keys). Phrases that
mention the scientist say "scientist" in English, साइंटिस्ट in Hindi and സയന്റിസ്റ്റ് in
Malayalam; the Hindi and Malayalam wording should be checked by a native speaker.

| Key | English wording |
|---|---|
| `say.welcome` | Touch the finger picture. Then put your finger on the reader. |
| `say.touchSensor` | Put your finger on the reader. |
| `say.home` | Your job is ready. Press the orange button. |
| `say.noJob` | No job yet. Please wait for your scientist. |
| `say.scanNow` | Now scan the barcode. |
| `say.correct` | Right bottle. |
| `say.wrong` | Wrong bottle. Put it back. |
| `say.doNotUse` | Do not use this bottle. Call scientist. |
| `say.placeVessel` | Put the container on the scale. Touch its number. Then press set to zero. |
| `say.weightCorrect` | Correct. Stop pouring. |
| `say.holdOver` | Stop. Do not pour more. Scientist is coming. |
| `say.holdVessel` | Stop. The container moved. Scientist is coming. |
| `say.jobHold` | Job on hold. Please wait for your scientist. |
| `say.check` | Check three things. Touch each picture. |
| `say.saved` | Saved. Next bottle. |
| `say.supervisorCalled` | Scientist called. Please stay here. |
| `say.jobCompleted` | All bottles done. Press the green button. |
| `say.sent` | Sent to scientist. Thank you. |
| `say.idle` | Are you still here? Touch the screen. |
| `say.confirmPause` | Pause work for now? |
| `say.confirmSignOut` | Leave this station? |
| `say.confirmLabSkip` | Send this bottle for lab test? Add it at the end. |
| `say.waitLab` | Done for now. When the lab bottle comes, press arrived. |
| `say.labReady` | The lab bottle is ready. Press continue. |
| `say.guide1` … `say.guide5` | The five HOW TO pictures |

Phrases with a number in them (`say.goTo`, `say.pour`, `say.addMore`, `say.nearly`,
`say.over`, `say.hello`) are put together from pieces (see above). Note that
`npm run voices -- --all` overwrites hand-made recordings; without `--all` it only touches
phrases whose text changed.
