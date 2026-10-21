import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Cable, CheckCircle2, Clock, Copy, Fingerprint, Hand, KeyRound, Languages, Loader2, MonitorCheck, MonitorCog, MonitorX, CirclePause, Plus, Scale, ScanFace, Settings2, ShieldAlert, UserCheck, Users, Volume2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { useMe } from '@/hooks/useMe';
import { api } from '@/lib/api';
import { resetSocket } from '@/lib/socket';
import { cn, fmtDateTime, g } from '@/lib/utils';
import type { ScaleFault, StationInfo } from '@shared/types';
import type { AdminStation, StationPatchBody } from './types';
import { ConfirmDialog, Empty, ErrorBox, Field, inputCls, LANGUAGES, Loading, PageHeader, SavedFlash, Switch } from './ui';

/** How the station's real scale is connected (from GET /admin/stations). */
interface ScaleSetup {
  scalePort: string | null;
  scaleBaud: number;
  scaleFraming: string;
  bridgeKeySet: boolean;
  bridgeOnline: boolean;
  scaleFault: ScaleFault | null;
  scaleGrossMg: number | null;
  scaleStable: boolean;
}
type Station = AdminStation & ScaleSetup;

export function Stations() {
  // Refreshed every few seconds so a scale being connected shows up while you watch.
  const stations = useQuery({ queryKey: ['admin', 'stations'], queryFn: () => api.get<Station[]>('/admin/stations'), refetchInterval: 3000 });
  const [adding, setAdding] = useState(false);
  return (
    <>
      <PageHeader title="Station setup" subtitle="How each weighing station signs people in, which scale it uses, and how it behaves during a job.">
        <Button variant="primary" size="md" onClick={() => setAdding(true)}>
          <Plus /> Add station
        </Button>
      </PageHeader>
      <div className="p-8">
        {stations.isLoading ? (
          <Loading label="Loading stations…" />
        ) : stations.error ? (
          <ErrorBox error={stations.error} />
        ) : !stations.data?.length ? (
          <Empty icon={MonitorCog} title="No stations yet">
            Use “Add station” for each weighing station on the floor.
          </Empty>
        ) : (
          <div className="grid gap-6 2xl:grid-cols-2 [&>*]:min-w-0">
            {stations.data.map((s) => (
              <StationCard key={s.id} s={s} />
            ))}
          </div>
        )}
      </div>
      {adding && <AddStationDialog onClose={() => setAdding(false)} />}
    </>
  );
}

function AddStationDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const create = useMutation({
    mutationFn: () => api.post('/admin/stations', { code: code.trim().toUpperCase(), name: name.trim() }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['admin', 'stations'] });
      onClose();
    },
  });
  const ready = /^[A-Z0-9-]{2,12}$/.test(code.trim().toUpperCase()) && name.trim().length >= 2;
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="w-[min(520px,calc(100vw-32px))]">
        <DialogTitle className="text-2xl">Add station</DialogTitle>
        <DialogDescription>
          The new station signs operators in with their ID and PIN. Set up its scale next, then a scientist checks the scale and links the station PC.
        </DialogDescription>
        <form
          className="mt-6 grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (ready && !create.isPending) create.mutate();
          }}
        >
          <Field label="Station code" hint="Short code shown on screens and reports, e.g. ST-04.">
            <input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} maxLength={12} autoFocus className={cn(inputCls, 'font-mono')} placeholder="ST-04" />
          </Field>
          <Field label="Name">
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} className={inputCls} placeholder="Mixing Station 04" />
          </Field>
          <ErrorBox error={create.error} />
          <div className="mt-2 flex justify-end gap-3">
            <Button type="button" variant="ghost" size="md" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" size="md" disabled={!ready || create.isPending}>
              {create.isPending ? <Loader2 className="animate-spin" /> : <Plus />} Add station
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

type BoolKey = 'allowFingerprint' | 'allowFace' | 'allowPin' | 'allowAssisted' | 'allowPause' | 'autoAccept';

const SIGN_IN: { key: BoolKey; label: string; hint: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { key: 'allowFingerprint', label: 'Fingerprint', hint: 'Touch the reader', icon: Fingerprint },
  { key: 'allowFace', label: 'Face', hint: 'Windows Hello camera', icon: ScanFace },
  { key: 'allowPin', label: 'Operator ID + PIN', hint: 'Fallback when biometrics fail', icon: KeyRound },
  { key: 'allowAssisted', label: 'Scientist-assisted', hint: 'A scientist vouches at the station', icon: UserCheck },
];

function StationCard({ s }: { s: Station }) {
  const qc = useQueryClient();
  const { data: me } = useMe();
  const here = me?.station?.id === s.id;
  const [saved, setSaved] = useState(0);
  const [confirmBind, setConfirmBind] = useState(false);
  const [lastSignIn, setLastSignIn] = useState<BoolKey | null>(null);
  const [volume, setVolume] = useState(s.audioVolume);
  const [idle, setIdle] = useState(String(s.idleMinutes));
  useEffect(() => setVolume(s.audioVolume), [s.audioVolume]);
  useEffect(() => setIdle(String(s.idleMinutes)), [s.idleMinutes]);

  const patch = useMutation({
    mutationFn: (body: StationPatchBody) => api.patch<StationInfo>(`/admin/stations/${s.id}`, body),
    onMutate: (body) => {
      // Optimistic: flip the switch now, roll back on error.
      const prev = qc.getQueryData<AdminStation[]>(['admin', 'stations']);
      qc.setQueryData<AdminStation[]>(['admin', 'stations'], (list) => list?.map((x) => (x.id === s.id ? { ...x, ...body } : x)));
      return { prev };
    },
    onError: (_e, _b, ctx) => ctx?.prev && qc.setQueryData(['admin', 'stations'], ctx.prev),
    onSuccess: (info) => {
      qc.setQueryData<AdminStation[]>(['admin', 'stations'], (list) => list?.map((x) => (x.id === s.id ? { ...x, ...info } : x)));
      setSaved((n) => n + 1);
      if (here) void qc.invalidateQueries({ queryKey: ['me'] });
    },
  });
  const bind = useMutation({
    mutationFn: () => api.post(`/admin/stations/${s.id}/bind`),
    onSuccess: () => {
      setConfirmBind(false);
      resetSocket();
      void qc.invalidateQueries({ queryKey: ['me'] });
      void qc.invalidateQueries({ queryKey: ['admin', 'stations'] });
    },
  });

  const noSignIn = !s.allowFingerprint && !s.allowFace && !s.allowPin && !s.allowAssisted;
  const setSignIn = (key: BoolKey, on: boolean) => {
    // Switching off the only remaining way in locks every operator out of this station: ask first.
    const others = SIGN_IN.filter((m) => m.key !== key && s[m.key]).length;
    if (!on && others === 0) return setLastSignIn(key);
    patch.mutate({ [key]: on });
  };
  const commitIdle = () => {
    const n = Math.round(Number(idle));
    if (!Number.isFinite(n) || n < 0 || n > 240) return setIdle(String(s.idleMinutes));
    if (n !== s.idleMinutes) patch.mutate({ idleMinutes: n });
  };
  const commitVolume = () => volume !== s.audioVolume && patch.mutate({ audioVolume: volume });

  return (
    // Columns inside the card follow the card's own width (not the screen's), so nothing spills out of it.
    <article className="@container min-w-0 rounded-xl border border-line bg-white">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-6 py-4">
        <div>
          <h2 className="font-display text-2xl font-bold text-navy">{s.name}</h2>
          <div className="flex flex-wrap items-center gap-x-3 text-sm text-muted">
            <span className="font-mono font-semibold">{s.code}</span>
            <span className="inline-flex items-center gap-1">
              <Users className="size-4" /> {s.operatorCount} authorised operator{s.operatorCount === 1 ? '' : 's'}
            </span>
          </div>
        </div>
        <SavedFlash tick={saved} />
      </header>

      <div className="grid gap-6 p-6 @3xl:grid-cols-2">
        <section className="min-w-0">
          <h3 className="mb-2 text-sm font-bold uppercase tracking-wide text-muted">Sign-in methods</h3>
          <div className="grid gap-1">
            {SIGN_IN.map(({ key, label, hint, icon: Icon }) => (
              <div key={key} className="flex min-h-12 items-center gap-3 rounded-md px-2 hover:bg-mist">
                <Icon className="size-5 shrink-0 text-navy" />
                <div className="min-w-0 flex-1">
                  <div className="font-medium">{label}</div>
                  <div className="text-xs text-muted">{hint}</div>
                </div>
                <Switch checked={s[key]} onChange={(v) => setSignIn(key, v)} label={label} />
              </div>
            ))}
          </div>
          {noSignIn && (
            <p className="mt-2 flex items-center gap-2 rounded-md bg-warn-100 px-3 py-2 text-sm font-semibold text-[#8a5a00]">
              <ShieldAlert className="size-4" /> Nobody can sign in at this station.
            </p>
          )}
        </section>

        <section className="min-w-0">
          <h3 className="mb-2 text-sm font-bold uppercase tracking-wide text-muted">During a job</h3>
          <div className="grid gap-1">
            <Row icon={CheckCircle2} label="Save weight automatically when correct" hint="When the reading is steady and in tolerance">
              <Switch checked={s.autoAccept} onChange={(v) => patch.mutate({ autoAccept: v })} label="Save weight automatically" />
            </Row>
            <Row icon={CirclePause} label="Operators may pause a job">
              <Switch checked={s.allowPause} onChange={(v) => patch.mutate({ allowPause: v })} label="Allow pause" />
            </Row>
            <Row icon={Clock} label="Sign operator out when idle" hint={Number(idle) === 0 ? 'Never' : `After ${idle} minute${idle === '1' ? '' : 's'} without a touch`}>
              <div className="flex shrink-0 items-center gap-2">
                <input
                  type="number"
                  min={0}
                  max={240}
                  value={idle}
                  onChange={(e) => setIdle(e.target.value)}
                  onBlur={commitIdle}
                  onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
                  className="h-9 w-20 rounded-md border border-line px-2 text-right font-mono"
                  aria-label="Idle minutes (0 = never)"
                />
                <span className="text-sm text-muted">min</span>
              </div>
            </Row>
            <Row icon={Languages} label="Default language" hint="Until the operator's own choice applies">
              <select
                value={s.defaultLanguage}
                onChange={(e) => patch.mutate({ defaultLanguage: e.target.value as StationInfo['defaultLanguage'] })}
                className="h-9 w-48 min-w-0 max-w-[50%] rounded-md border border-line px-2"
                aria-label="Default language"
              >
                {LANGUAGES.map((l) => (
                  <option key={l.value} value={l.value}>
                    {l.label}
                  </option>
                ))}
              </select>
            </Row>
            <Row icon={Volume2} label="Sound cues">
              <Switch checked={s.audioEnabled} onChange={(v) => patch.mutate({ audioEnabled: v })} label="Sound cues" />
            </Row>
            <div className={cn('flex items-center gap-3 px-2 pb-2 pl-10', !s.audioEnabled && 'opacity-50')}>
              <span className="text-sm text-muted">Volume</span>
              <input
                type="range"
                min={0}
                max={100}
                step={5}
                value={volume}
                disabled={!s.audioEnabled}
                onChange={(e) => setVolume(Number(e.target.value))}
                onPointerUp={commitVolume}
                onKeyUp={commitVolume}
                onBlur={commitVolume}
                className="flex-1 accent-[#17394C]"
                aria-label="Volume"
              />
              <span className="w-10 text-right font-mono text-sm">{volume}%</span>
            </div>
          </div>
        </section>
      </div>

      {patch.error && <ErrorBox error={patch.error} className="mx-6 mb-4" />}

      <div className="grid gap-4 border-t border-line p-6 @2xl:grid-cols-2">
        <section className="min-w-0">
          <h3 className="mb-2 text-sm font-bold uppercase tracking-wide text-muted">Station computer</h3>
          <div className="flex flex-wrap items-center gap-2">
            {here ? (
              <Badge tone="ok">
                <MonitorCheck /> This computer
              </Badge>
            ) : s.bound ? (
              <Badge tone="neutral">
                <MonitorCheck /> Linked to a PC
              </Badge>
            ) : (
              <Badge tone="warn">
                <MonitorX /> No PC linked
              </Badge>
            )}
            {s.boundAt && <span className="text-sm text-muted">since {fmtDateTime(s.boundAt)}</span>}
          </div>
          {!here && (
            <Button size="sm" variant="outline" className="mt-3" onClick={() => setConfirmBind(true)}>
              <MonitorCheck /> Use this computer as {s.code}
            </Button>
          )}
        </section>
        <ScaleSection s={s} />
      </div>

      <ConfirmDialog
        open={!!lastSignIn}
        title="Turn off the last sign-in method?"
        description={`Nobody will be able to sign in at ${s.name} until a method is switched on again.`}
        confirmLabel="Turn off"
        onConfirm={() => {
          if (lastSignIn) patch.mutate({ [lastSignIn]: false });
          setLastSignIn(null);
        }}
        onClose={() => setLastSignIn(null)}
      />
      <ConfirmDialog
        open={confirmBind}
        tone="navy"
        title={`Use this computer as ${s.code}?`}
        description={`Operators will sign in to ${s.name} on this PC.${s.bound ? ` The computer currently set up as ${s.code} will stop working as that station.` : ''}`}
        confirmLabel={`Set up as ${s.code}`}
        pending={bind.isPending}
        error={bind.error}
        onConfirm={() => bind.mutate()}
        onClose={() => (setConfirmBind(false), bind.reset())}
      />
    </article>
  );
}

const FAULT_TEXT: Record<ScaleFault, string> = {
  NO_PORT: 'Cannot open the COM port. Check the cable and the port number.',
  NO_BRIDGE: 'Scale bridge not running on the station PC.',
  NO_REPLY: 'Scale not answering. Check it is switched on and set to MT-SICS.',
  OVERLOAD: 'Weight is over the scale’s range.',
  UNDERLOAD: 'Reading below zero. Is the weighing pan in place?',
  BUSY: 'Scale is busy (zeroing or adjusting).',
  BAD_REPLY: 'Unexpected reply. Check the scale’s interface is set to MT-SICS and the baud rate matches.',
};

const MODE_TEXT: Record<StationInfo['scaleMode'], string> = {
  SIMULATED: 'Practice scale (training only)',
  BRIDGE: 'Scale on the station PC',
  SERIAL: 'Scale on the server PC',
};

function ScaleSection({ s }: { s: Station }) {
  const [editing, setEditing] = useState(false);
  const [keyFor, setKeyFor] = useState(false);
  const real = s.scaleMode !== 'SIMULATED';
  const reading = s.scaleConnected && s.scaleGrossMg != null;
  return (
    <section className="min-w-0">
      <h3 className="mb-2 text-sm font-bold uppercase tracking-wide text-muted">Scale</h3>
      <div className="text-sm font-semibold">{s.scaleModel}</div>
      <div className="text-sm text-muted">
        {MODE_TEXT[s.scaleMode]}
        {real && s.scalePort && <span className="font-mono"> · {s.scalePort} · {s.scaleBaud} baud · {s.scaleFraming}</span>}
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        <Badge tone={s.scaleConnected ? 'ok' : 'err'} size="sm">
          <Scale /> {reading ? `${g(s.scaleGrossMg!, s.scaleResolutionMg)} g${s.scaleStable ? '' : ' (moving)'}` : s.scaleConnected ? 'Connected' : 'Not connected'}
        </Badge>
        {s.scaleMode === 'BRIDGE' && (
          <Badge tone={s.bridgeOnline ? 'ok' : 'warn'} size="sm">
            <Cable /> {s.bridgeOnline ? 'Bridge online' : s.bridgeKeySet ? 'Bridge offline' : 'No bridge key yet'}
          </Badge>
        )}
        <Badge tone={s.scaleValidated ? 'ok' : 'err'} size="sm">
          {s.scaleValidated ? <CheckCircle2 /> : <ShieldAlert />}
          {s.scaleValidated ? `Checked, valid until ${fmtDateTime(s.scaleValidatedUntil)}` : 'Scale check due'}
        </Badge>
      </div>
      {real && !s.scaleConnected && s.scaleFault && <p className="mt-2 text-sm font-semibold text-err">{FAULT_TEXT[s.scaleFault]}</p>}
      <p className="mt-2 text-xs text-muted">
        Reads to {g(s.scaleResolutionMg, s.scaleResolutionMg)} g. Uncertainty {s.scaleUncertaintyMg} mg. Container drift limit {s.vesselDriftLimitMg} mg. <Hand className="inline size-3" /> A scientist checks the scale with a reference weight every day.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
          <Settings2 /> Scale settings
        </Button>
        {s.scaleMode === 'BRIDGE' && (
          <Button size="sm" variant="outline" onClick={() => setKeyFor(true)}>
            <KeyRound /> {s.bridgeKeySet ? 'New bridge key' : 'Create bridge key'}
          </Button>
        )}
      </div>
      {editing && <ScaleSettingsDialog s={s} onClose={() => setEditing(false)} />}
      {keyFor && <BridgeKeyDialog s={s} onClose={() => setKeyFor(false)} />}
    </section>
  );
}

const RESOLUTIONS = [
  { mg: 1, label: '0.001 g' },
  { mg: 10, label: '0.01 g' },
  { mg: 100, label: '0.1 g' },
  { mg: 1000, label: '1 g' },
];
const BAUDS = [1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200];
const FRAMINGS = ['8N1', '7E1', '7O1', '8E1', '8O1', '7N2', '8N2'];

function ScaleSettingsDialog({ s, onClose }: { s: Station; onClose: () => void }) {
  const qc = useQueryClient();
  const [mode, setMode] = useState(s.scaleMode);
  const [model, setModel] = useState(s.scaleModel);
  const [port, setPort] = useState(s.scalePort ?? '');
  const [baud, setBaud] = useState(s.scaleBaud);
  const [framing, setFraming] = useState(s.scaleFraming);
  const [res, setRes] = useState(s.scaleResolutionMg);
  const [unc, setUnc] = useState(String(s.scaleUncertaintyMg));
  const [drift, setDrift] = useState(String(s.vesselDriftLimitMg));
  const ports = useQuery({ queryKey: ['admin', 'serial-ports'], queryFn: () => api.get<{ path: string; label: string }[]>('/admin/serial-ports'), enabled: mode === 'SERIAL' });

  const real = mode !== 'SIMULATED';
  const uncN = Number(unc);
  const driftN = Number(drift);
  const portOk = !real || /^COM\d{1,3}$/i.test(port.trim());
  const uncOk = Number.isInteger(uncN) && uncN >= res;
  const driftOk = Number.isInteger(driftN) && driftN >= 0;
  const measuringChanged =
    mode !== s.scaleMode || (real && (port.trim().toUpperCase() !== (s.scalePort ?? '') || baud !== s.scaleBaud || framing !== s.scaleFraming)) || res !== s.scaleResolutionMg || uncN !== s.scaleUncertaintyMg;

  const save = useMutation({
    mutationFn: () =>
      api.put(`/admin/stations/${s.id}/scale`, {
        scaleMode: mode,
        scaleModel: model.trim(),
        scalePort: real ? port.trim().toUpperCase() : s.scalePort,
        scaleBaud: baud,
        scaleFraming: framing,
        scaleResolutionMg: res,
        scaleUncertaintyMg: uncN,
        vesselDriftLimitMg: driftN,
      }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['admin', 'stations'] });
      onClose();
    },
  });

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[calc(100vh-32px)] w-[min(680px,calc(100vw-32px))] overflow-y-auto">
        <DialogTitle className="text-2xl">Scale for {s.name}</DialogTitle>
        <DialogDescription>METTLER TOLEDO scales are read with MT-SICS. On the scale, set the interface to MT-SICS with the same baud rate and data format as here.</DialogDescription>
        <form
          className="mt-6 grid gap-5"
          onSubmit={(e) => {
            e.preventDefault();
            if (portOk && uncOk && driftOk && model.trim() && !save.isPending) save.mutate();
          }}
        >
          <fieldset className="grid gap-2">
            <legend className="mb-1 text-sm font-semibold text-ink">Where is the scale plugged in?</legend>
            {(
              [
                ['BRIDGE', 'Into the station PC', 'USB cable to the station PC. The scale bridge on that PC sends the readings here.'],
                ['SERIAL', 'Into this server PC', 'Only when the station and the server are the same computer.'],
                ['SIMULATED', 'Practice scale', 'Training only. Weights are marked as practice and are not production records.'],
              ] as const
            ).map(([value, label, hint]) => (
              <label key={value} className={cn('flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2.5', mode === value ? 'border-navy bg-mist' : 'border-line hover:bg-mist')}>
                <input type="radio" name="mode" className="mt-1 size-4 accent-[#17394C]" checked={mode === value} onChange={() => setMode(value)} />
                <span>
                  <span className="block font-semibold">{label}</span>
                  <span className="block text-sm text-muted">{hint}</span>
                </span>
              </label>
            ))}
          </fieldset>

          <Field label="Scale model" hint="As on the scale’s label, e.g. METTLER TOLEDO ICS425s.">
            <input value={model} onChange={(e) => setModel(e.target.value)} maxLength={80} className={inputCls} />
          </Field>

          {real && (
            <div className="grid gap-4 sm:grid-cols-3">
              <Field
                label="COM port"
                error={port && !portOk ? 'For example COM3' : undefined}
                hint={mode === 'BRIDGE' ? 'On the station PC. Run START-SCALE-BRIDGE.bat list there to see its ports.' : undefined}
              >
                {mode === 'SERIAL' && ports.data?.length ? (
                  <select value={port} onChange={(e) => setPort(e.target.value)} className={inputCls}>
                    <option value="">Choose…</option>
                    {ports.data.map((p) => (
                      <option key={p.path} value={p.path}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input value={port} onChange={(e) => setPort(e.target.value.toUpperCase())} maxLength={6} placeholder="COM3" className={cn(inputCls, 'font-mono')} />
                )}
              </Field>
              <Field label="Baud rate">
                <select value={baud} onChange={(e) => setBaud(Number(e.target.value))} className={inputCls}>
                  {BAUDS.map((b) => (
                    <option key={b} value={b}>
                      {b}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Data format">
                <select value={framing} onChange={(e) => setFraming(e.target.value)} className={inputCls}>
                  {FRAMINGS.map((f) => (
                    <option key={f} value={f}>
                      {f}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Reads to" hint="The scale’s smallest step (readability d).">
              <select value={res} onChange={(e) => setRes(Number(e.target.value))} className={inputCls}>
                {RESOLUTIONS.map((r) => (
                  <option key={r.mg} value={r.mg}>
                    {r.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Uncertainty (mg)" hint="Expanded uncertainty from the calibration certificate." error={unc && !uncOk ? `At least ${res} mg (one step)` : undefined}>
              <input value={unc} onChange={(e) => setUnc(e.target.value.replace(/\D/g, ''))} inputMode="numeric" className={cn(inputCls, 'font-mono')} />
            </Field>
            <Field label="Container drift limit (mg)" hint="Change allowed between two ingredients." error={drift && !driftOk ? 'Whole milligrams' : undefined}>
              <input value={drift} onChange={(e) => setDrift(e.target.value.replace(/\D/g, ''))} inputMode="numeric" className={cn(inputCls, 'font-mono')} />
            </Field>
          </div>

          {measuringChanged && (
            <p className="flex items-start gap-2 rounded-lg bg-warn-100 px-4 py-3 text-sm font-semibold text-[#8a5a00]">
              <ShieldAlert className="mt-0.5 size-4 shrink-0" /> Saving cancels the current scale check. A scientist must check the scale with a reference weight before anyone can weigh on it.
            </p>
          )}
          <ErrorBox error={save.error} />
          <div className="flex justify-end gap-3">
            <Button type="button" variant="ghost" size="md" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" size="md" disabled={!portOk || !uncOk || !driftOk || !model.trim() || save.isPending}>
              {save.isPending && <Loader2 className="animate-spin" />} Save scale settings
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function BridgeKeyDialog({ s, onClose }: { s: Station; onClose: () => void }) {
  const qc = useQueryClient();
  const [copied, setCopied] = useState(false);
  const create = useMutation({
    mutationFn: () => api.post<{ key: string; station: string }>(`/admin/stations/${s.id}/bridge-key`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['admin', 'stations'] }),
  });
  const key = create.data?.key;
  const server = window.location.origin;
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      /* clipboard blocked on plain http: the key stays on screen to copy by hand */
    }
  };
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="w-[min(640px,calc(100vw-32px))]">
        <DialogTitle className="text-2xl">Bridge key for {s.code}</DialogTitle>
        {!key ? (
          <>
            <DialogDescription>
              The scale bridge on the station PC signs in with this key.{s.bridgeKeySet ? ' Creating a new key stops the old one straight away; the bridge must be given the new key.' : ''}
            </DialogDescription>
            <ErrorBox error={create.error} className="mt-4" />
            <div className="mt-6 flex justify-end gap-3">
              <Button variant="ghost" size="md" onClick={onClose}>
                Cancel
              </Button>
              <Button variant="primary" size="md" disabled={create.isPending} onClick={() => create.mutate()}>
                {create.isPending ? <Loader2 className="animate-spin" /> : <KeyRound />} {s.bridgeKeySet ? 'Create new key' : 'Create key'}
              </Button>
            </div>
          </>
        ) : (
          <>
            <DialogDescription>Copy these three values into START-SCALE-BRIDGE.bat on the station PC. The key is shown only now.</DialogDescription>
            <dl className="mt-4 grid gap-3 rounded-lg border border-line bg-mist p-4 font-mono text-sm">
              {(
                [
                  ['SERVER', server],
                  ['STATION', s.code],
                  ['KEY', key],
                ] as const
              ).map(([k, v]) => (
                <div key={k} className="grid gap-0.5">
                  <dt className="text-xs font-bold text-muted">{k}</dt>
                  <dd className="break-all text-ink select-all">{v}</dd>
                </div>
              ))}
            </dl>
            <div className="mt-6 flex justify-end gap-3">
              <Button variant="outline" size="md" onClick={() => void copy(`set "SERVER=${server}"\r\nset "STATION=${s.code}"\r\nset "KEY=${key}"`)}>
                <Copy /> {copied ? 'Copied' : 'Copy'}
              </Button>
              <Button variant="primary" size="md" onClick={onClose}>
                Done
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Row({ icon: Icon, label, hint, children }: { icon: React.ComponentType<{ className?: string }>; label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-12 items-center gap-3 rounded-md px-2 hover:bg-mist">
      <Icon className="size-5 shrink-0 text-navy" />
      <div className="min-w-0 flex-1">
        <div className="font-medium">{label}</div>
        {hint && <div className="text-xs text-muted">{hint}</div>}
      </div>
      {children}
    </div>
  );
}
