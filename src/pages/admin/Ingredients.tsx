import { useMemo, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Biohazard, Camera, Flame, Glasses, Hand, ImageOff, Leaf, Loader2, MapPinOff, Package, Pipette, Plus, Search, ShieldPlus, Shovel, Skull, Trash2, X } from 'lucide-react';
import { IngredientPicture, ingredientColor, LocationBadge } from '@/components/visual/Bottle';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { api } from '@/lib/api';
import { cn, fmtDate } from '@/lib/utils';
import { useAdminIngredients } from './queries';
import { HAZARDS, PPE, type AdminIngredient, type AdminLot, type AdminRack, type Hazard, type IngredientPatchBody, type NewIngredientBody, type Ppe } from './types';
import { ConfirmDialog, Empty, ErrorBox, Field, inputCls, Loading, PageHeader } from './ui';

type IconT = React.ComponentType<{ className?: string }>;

const PPE_INFO: Record<Ppe, { label: string; icon: IconT }> = {
  GLOVES: { label: 'Gloves', icon: Hand },
  MASK: { label: 'Mask', icon: ShieldPlus },
  GOGGLES: { label: 'Goggles', icon: Glasses },
  DROPPER: { label: 'Dropper', icon: Pipette },
  SPATULA: { label: 'Spatula', icon: Shovel },
};

const HAZARD_INFO: Record<Hazard, { label: string; icon: IconT }> = {
  FLAMMABLE: { label: 'Flammable', icon: Flame },
  IRRITANT: { label: 'Irritant', icon: AlertTriangle },
  ENVIRONMENT: { label: 'Harmful to environment', icon: Leaf },
  TOXIC: { label: 'Toxic', icon: Skull },
  CORROSIVE: { label: 'Corrosive', icon: Biohazard },
};

const SWATCHES = ['#c0392b', '#e67e22', '#f4d03f', '#7cb342', '#2aa198', '#4fc3f7', '#2f6fd6', '#7e57c2', '#d63c78', '#8b5a2b', '#6b7b85', '#f4f7f8'];

type QuickFilter = 'all' | 'noLocation' | 'noPhoto';

export function Ingredients() {
  const q = useAdminIngredients();
  const [search, setSearch] = useState('');
  const [quick, setQuick] = useState<QuickFilter>('all');
  const [openId, setOpenId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const list = useMemo(() => {
    const s = search.trim().toLowerCase();
    return (q.data?.ingredients ?? []).filter(
      (i) =>
        (!s || i.name.toLowerCase().includes(s) || i.code.toLowerCase().includes(s) || (i.barcode ?? '').toLowerCase().includes(s)) &&
        (quick === 'all' || (quick === 'noLocation' ? !i.rackCode || i.bin == null : !i.photoUrl)),
    );
  }, [q.data, search, quick]);
  const all = q.data?.ingredients ?? [];
  const missingLoc = all.filter((i) => !i.rackCode || i.bin == null).length;
  const missingPhoto = all.filter((i) => !i.photoUrl).length;
  const open = all.find((i) => i.id === openId) ?? null;

  return (
    <>
      <PageHeader title="Ingredients" subtitle="What each bottle looks like and where it lives, exactly as the operator sees it on screen.">
        <div className="flex flex-wrap items-center gap-3">
          <label className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-5 -translate-y-1/2 text-muted" />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name, code or barcode" className={cn(inputCls, 'w-80 max-w-full pl-10')} />
          </label>
          <Button variant="primary" size="md" onClick={() => setAdding(true)}>
            <Plus /> Add ingredient
          </Button>
        </div>
      </PageHeader>
      <div className="grid gap-4 p-8">
        <div className="flex flex-wrap gap-2">
          {(
            [
              ['all', `All (${all.length})`],
              ['noLocation', `No shelf location (${missingLoc})`],
              ['noPhoto', `No photo (${missingPhoto})`],
            ] as [QuickFilter, string][]
          ).map(([k, label]) => (
            <button
              key={k}
              onClick={() => setQuick(k)}
              className={cn('h-10 rounded-full border px-4 font-semibold', quick === k ? 'border-navy bg-navy text-white' : 'border-line bg-white text-navy hover:bg-mist')}
            >
              {label}
            </button>
          ))}
        </div>
        {q.isLoading ? (
          <Loading label="Loading ingredients…" />
        ) : q.error ? (
          <ErrorBox error={q.error} />
        ) : list.length === 0 ? (
          <Empty icon={Package} title={all.length ? 'No matches' : 'No ingredients yet'}>
            {all.length ? 'Try a different search or filter.' : 'Use “Add ingredient” to add the first one.'}
          </Empty>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-4">
            {list.map((i) => (
              <IngredientCard key={i.id} i={i} onOpen={() => setOpenId(i.id)} />
            ))}
          </div>
        )}
      </div>
      {open && q.data && <IngredientEditor key={open.id} ing={open} racks={q.data.racks} onClose={() => setOpenId(null)} />}
      {adding && (
        <AddIngredientDialog
          onClose={() => setAdding(false)}
          onCreated={(id) => {
            setAdding(false);
            // Show the new ingredient and open its editor for colour, photo, location and safety.
            setSearch('');
            setQuick('all');
            setOpenId(id);
          }}
        />
      )}
    </>
  );
}

function AddIngredientDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const qc = useQueryClient();
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [barcode, setBarcode] = useState('');
  const body: NewIngredientBody = { code: code.trim().toUpperCase(), name: name.trim(), barcode: barcode.trim() };
  const codeErr = body.code && !/^[A-Z0-9][A-Z0-9._-]{0,39}$/.test(body.code) ? 'Letters, numbers, dot, dash or underscore only.' : undefined;
  const ready = !!body.code && !!body.name && !!body.barcode && !codeErr;

  const create = useMutation({
    mutationFn: () => api.post<{ id: string }>('/admin/ingredients', body),
    onSuccess: async ({ id }) => {
      await qc.invalidateQueries({ queryKey: ['admin', 'ingredients'] });
      onCreated(id);
    },
  });

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="w-[min(560px,calc(100vw-32px))]">
        <DialogTitle className="text-2xl">Add ingredient</DialogTitle>
        <DialogDescription>After saving you can set the cap colour, bottle photo, shelf location and safety pictures.</DialogDescription>
        <form
          className="mt-6 grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (ready && !create.isPending) create.mutate();
          }}
        >
          <Field label="Material code" hint="The code used in formulas and process orders, e.g. RM-1016." error={codeErr}>
            <input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} maxLength={40} autoFocus className={cn(inputCls, 'font-mono')} placeholder="RM-1016" />
          </Field>
          <Field label="Name" hint="As the operator will see it on screen.">
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} className={inputCls} placeholder="e.g. Geraniol" />
          </Field>
          <Field label="Bottle barcode" hint="Scan the bottle's barcode into this box, or type it. The operator scans this to prove the right bottle was picked.">
            <input value={barcode} onChange={(e) => setBarcode(e.target.value)} maxLength={128} className={cn(inputCls, 'font-mono')} placeholder="Scan or type" />
          </Field>
          <ErrorBox error={create.error} />
          <div className="mt-2 flex justify-end gap-3">
            <Button type="button" variant="ghost" size="md" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" size="md" disabled={!ready || create.isPending}>
              {create.isPending ? <Loader2 className="animate-spin" /> : <Plus />} Add ingredient
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function IngredientCard({ i, onOpen }: { i: AdminIngredient; onOpen: () => void }) {
  const color = ingredientColor(i.code, i.colorHex);
  return (
    <button onClick={onOpen} className="group flex flex-col gap-3 rounded-xl border border-line bg-white p-4 text-left transition-shadow hover:border-navy hover:shadow-md focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-orange/50">
      <div className="flex items-start gap-3">
        <IngredientPicture code={i.code} name={i.name} colorHex={i.colorHex} photoUrl={i.photoUrl} className="size-20 shrink-0 rounded-xl border-[3px]" />
        <div className="min-w-0 flex-1">
          <div className="line-clamp-2 font-semibold break-words text-ink">{i.name}</div>
          <div className="font-mono text-xs text-muted">{i.code}</div>
        </div>
      </div>
      <div className="flex items-center justify-between gap-2">
        {i.rackCode && i.bin != null ? (
          <LocationBadge rack={i.rackCode} bin={i.bin} color={color} size="sm" />
        ) : (
          <Badge tone="warn" size="sm">
            <MapPinOff /> No location
          </Badge>
        )}
        <div className="flex gap-1 text-navy">
          {(i.ppe as Ppe[]).filter((p) => PPE_INFO[p]).map((p) => {
            const Icon = PPE_INFO[p].icon;
            return <Icon key={p} className="size-4" aria-label={PPE_INFO[p].label} />;
          })}
          {i.hazards.length > 0 && <Flame className="size-4 text-err" aria-label="Hazards" />}
        </div>
      </div>
    </button>
  );
}

/** Resize to at most 800 px on the long side and re-encode as JPEG; returns base64 without the data: prefix. */
async function resizePhoto(file: File): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('That file is not a picture we can read.'));
      el.src = url;
    });
    const scale = Math.min(1, 800 / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('This browser cannot resize pictures.');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.85).replace(/^data:image\/jpeg;base64,/, '');
  } finally {
    URL.revokeObjectURL(url);
  }
}

function IngredientEditor({ ing, racks, onClose }: { ing: AdminIngredient; racks: AdminRack[]; onClose: () => void }) {
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [colorHex, setColorHex] = useState<string | null>(ing.colorHex);
  const [rackCode, setRackCode] = useState<string>(ing.rackCode ?? '');
  const [bin, setBin] = useState<string>(ing.bin != null ? String(ing.bin) : '');
  const [ppe, setPpe] = useState<Ppe[]>(ing.ppe.filter((p): p is Ppe => (PPE as readonly string[]).includes(p)));
  const [hazards, setHazards] = useState<Hazard[]>(ing.hazards.filter((h): h is Hazard => (HAZARDS as readonly string[]).includes(h)));
  const [handling, setHandling] = useState<string[]>(ing.handling);
  const [newNote, setNewNote] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);
  /** Which question is open: removing the photo, or leaving with unsaved changes. */
  const [confirm, setConfirm] = useState<'photo' | 'discard' | null>(null);

  const rack = racks.find((r) => r.code === rackCode);
  const binCount = rack ? rack.rows * rack.cols : 0;
  const color = ingredientColor(ing.code, colorHex);
  const refresh = () => qc.invalidateQueries({ queryKey: ['admin', 'ingredients'] });

  const notes = handling.map((h) => h.trim()).filter(Boolean);
  const body: IngredientPatchBody = {};
  if (colorHex !== ing.colorHex) body.colorHex = colorHex;
  const newRack = rackCode || null;
  const newBin = bin ? Number(bin) : null;
  if (newRack !== ing.rackCode || newBin !== ing.bin) {
    body.rackCode = newRack;
    body.bin = newBin;
  }
  if ([...ppe].sort().join() !== [...ing.ppe].sort().join()) body.ppe = ppe;
  if ([...hazards].sort().join() !== [...ing.hazards].sort().join()) body.hazards = hazards;
  if (JSON.stringify(notes) !== JSON.stringify(ing.handling)) body.handling = notes;
  const dirty = Object.keys(body).length > 0;
  const locationErr = (rackCode && !bin) || (!rackCode && bin) ? 'Choose both a rack and a bin, or neither.' : undefined;

  const save = useMutation({
    mutationFn: () => api.patch(`/admin/ingredients/${ing.id}`, body),
    onSuccess: async () => {
      await refresh();
      onClose();
    },
  });
  const photo = useMutation({
    mutationFn: async (file: File | null) => {
      if (!file) return api.put(`/admin/ingredients/${ing.id}/photo`, { type: null, data: null });
      const data = await resizePhoto(file);
      if (data.length * 0.75 > 1_500_000) throw new Error('The photo is still too large after resizing. Try a simpler picture.');
      return api.put(`/admin/ingredients/${ing.id}/photo`, { type: 'image/jpeg', data });
    },
    onSuccess: () => void refresh(),
  });

  const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  // A typed note not yet added counts as unsaved work too.
  const unsaved = dirty || !!newNote.trim();
  const requestClose = () => (unsaved ? setConfirm('discard') : onClose());

  return (
    <Dialog open onOpenChange={(v) => !v && requestClose()}>
      <DialogContent className="w-[min(1100px,calc(100vw-32px))]">
        <DialogTitle>{ing.name}</DialogTitle>
        <DialogDescription>
          <span className="font-mono">{ing.code}</span>
          {ing.barcode && <> · barcode <span className="font-mono">{ing.barcode}</span></>} · used in {ing.formulaCount} formula line{ing.formulaCount === 1 ? '' : 's'}
          {ing.lotTracked && ' · lot-tracked'}
        </DialogDescription>

        <div className="mt-6 grid gap-8 lg:grid-cols-[1fr_340px]">
          <div className="grid content-start gap-6">
            {/* colour */}
            <section>
              <h3 className="mb-2 text-sm font-bold uppercase tracking-wide text-muted">Cap / sticker colour</h3>
              <div className="flex flex-wrap items-center gap-2">
                {SWATCHES.map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setColorHex(c)}
                    className={cn('size-9 rounded-lg border-2 border-line', colorHex?.toLowerCase() === c && 'ring-4 ring-navy ring-offset-2')}
                    style={{ background: c }}
                    aria-label={`Colour ${c}`}
                    title={c}
                  />
                ))}
                <label className="ml-1 flex items-center gap-2 rounded-lg border border-line px-2 py-1 text-sm">
                  <input type="color" value={colorHex ?? color} onChange={(e) => setColorHex(e.target.value)} className="size-7 cursor-pointer border-0 bg-transparent p-0" aria-label="Custom colour" />
                  <span className="font-mono">{colorHex ?? 'auto'}</span>
                </label>
                {colorHex && (
                  <Button type="button" size="sm" variant="ghost" onClick={() => setColorHex(null)}>
                    Clear
                  </Button>
                )}
              </div>
              {!colorHex && <p className="mt-1 text-xs text-muted">No colour set, so one is picked automatically from the code. Match it to the real bottle cap if you can.</p>}
            </section>

            {/* photo */}
            <section>
              <h3 className="mb-2 text-sm font-bold uppercase tracking-wide text-muted">Bottle photo</h3>
              <div className="flex flex-wrap items-center gap-3">
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/*"
                  capture="environment"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    e.target.value = '';
                    if (f) photo.mutate(f);
                  }}
                />
                <Button type="button" size="sm" variant="navy" disabled={photo.isPending} onClick={() => fileRef.current?.click()}>
                  {photo.isPending ? <Loader2 className="animate-spin" /> : <Camera />} {ing.photoUrl ? 'Replace photo' : 'Take or upload photo'}
                </Button>
                {ing.photoUrl && (
                  <Button type="button" size="sm" variant="ghost" className="text-err" disabled={photo.isPending} onClick={() => setConfirm('photo')}>
                    <ImageOff /> Remove photo
                  </Button>
                )}
              </div>
              <p className="mt-1 text-xs text-muted">Saved straight away. Photograph the bottle upright on a plain background; it&apos;s shrunk to 800 px before upload.</p>
              <ErrorBox error={photo.error} className="mt-2" />
            </section>

            {/* location */}
            <section>
              <h3 className="mb-2 text-sm font-bold uppercase tracking-wide text-muted">Shelf location</h3>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Rack">
                  <select
                    value={rackCode}
                    onChange={(e) => {
                      setRackCode(e.target.value);
                      const r = racks.find((x) => x.code === e.target.value);
                      if (!r || (bin && Number(bin) > r.rows * r.cols)) setBin('');
                    }}
                    className={inputCls}
                  >
                    <option value="">Not set</option>
                    {racks.map((r) => (
                      <option key={r.code} value={r.code}>
                        {r.code}: {r.label} ({r.zone})
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Bin" error={locationErr}>
                  <select value={bin} onChange={(e) => setBin(e.target.value)} disabled={!rack} className={inputCls}>
                    <option value="">Not set</option>
                    {Array.from({ length: binCount }, (_, k) => k + 1).map((n) => (
                      <option key={n} value={n}>
                        {rackCode}-{String(n).padStart(2, '0')}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
              {!rackCode && <p className="mt-1 text-xs text-muted">Without a location the operator is told to call a scientist to find the bottle.</p>}
            </section>

            {/* PPE + hazards */}
            <div className="grid gap-6 sm:grid-cols-2">
              <section>
                <h3 className="mb-2 text-sm font-bold uppercase tracking-wide text-muted">Protective equipment & tools</h3>
                <div className="grid gap-1">
                  {PPE.map((p) => {
                    const { label, icon: Icon } = PPE_INFO[p];
                    return (
                      <label key={p} className="flex h-10 cursor-pointer items-center gap-3 rounded-md px-2 hover:bg-mist">
                        <input type="checkbox" className="size-5 accent-[#17394C]" checked={ppe.includes(p)} onChange={() => setPpe((l) => toggle(l, p))} />
                        <Icon className="size-5 text-navy" />
                        {label}
                      </label>
                    );
                  })}
                </div>
              </section>
              <section>
                <h3 className="mb-2 text-sm font-bold uppercase tracking-wide text-muted">Hazards</h3>
                <div className="grid gap-1">
                  {HAZARDS.map((h) => {
                    const { label, icon: Icon } = HAZARD_INFO[h];
                    return (
                      <label key={h} className="flex h-10 cursor-pointer items-center gap-3 rounded-md px-2 hover:bg-mist">
                        <input type="checkbox" className="size-5 accent-[#c94343]" checked={hazards.includes(h)} onChange={() => setHazards((l) => toggle(l, h))} />
                        <Icon className="size-5 text-err" />
                        {label}
                      </label>
                    );
                  })}
                </div>
              </section>
            </div>

            {/* handling */}
            <section>
              <h3 className="mb-2 text-sm font-bold uppercase tracking-wide text-muted">Handling notes</h3>
              <ul className="grid gap-2">
                {handling.map((h, idx) => (
                  <li key={idx} className="flex items-center gap-2">
                    <input
                      value={h}
                      maxLength={200}
                      onChange={(e) => setHandling((l) => l.map((x, k) => (k === idx ? e.target.value : x)))}
                      className={cn(inputCls, 'h-10')}
                      aria-label={`Handling note ${idx + 1}`}
                    />
                    <button type="button" className="grid size-10 shrink-0 place-items-center rounded-lg text-err hover:bg-err-100" onClick={() => setHandling((l) => l.filter((_, k) => k !== idx))} aria-label="Remove note">
                      <Trash2 className="size-4" />
                    </button>
                  </li>
                ))}
              </ul>
              {handling.length < 10 && (
                <form
                  className="mt-2 flex gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (newNote.trim()) {
                      setHandling((l) => [...l, newNote.trim()]);
                      setNewNote('');
                    }
                  }}
                >
                  <input value={newNote} onChange={(e) => setNewNote(e.target.value)} maxLength={200} placeholder="e.g. Keep the cap closed between pours" className={cn(inputCls, 'h-10')} />
                  <Button type="submit" size="sm" variant="outline" className="h-10" disabled={!newNote.trim()}>
                    <Plus /> Add
                  </Button>
                </form>
              )}
              <p className="mt-1 text-xs text-muted">Up to 10 short notes, shown in English to the operator.</p>
            </section>

            {/* lots */}
            <section>
              <h3 className="mb-2 text-sm font-bold uppercase tracking-wide text-muted">Lots {ing.lotTracked ? '' : '(not lot-tracked)'}</h3>
              {ing.lots.length === 0 ? (
                <p className="text-sm text-muted">No lots recorded.</p>
              ) : (
                <div className="overflow-hidden rounded-lg border border-line">
                  <table className="w-full text-left text-sm">
                    <thead className="bg-mist text-muted">
                      <tr>
                        {['Lot', 'Barcode', 'Expires', 'Status'].map((h) => (
                          <th key={h} className="px-3 py-1.5 font-semibold">
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-line">
                      {ing.lots.map((l) => (
                        <tr key={l.id}>
                          <td className="px-3 py-1.5 font-mono font-semibold">{l.lotNumber}</td>
                          <td className="px-3 py-1.5 font-mono text-muted">{l.barcode}</td>
                          <td className="px-3 py-1.5">{fmtDate(l.expiresOn)}</td>
                          <td className="px-3 py-1.5">
                            <LotBadge lot={l} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <p className="mt-1 text-xs text-muted">Lot status is read-only here.</p>
            </section>
          </div>

          {/* live preview */}
          <aside className="h-fit rounded-xl bg-navy p-5 text-white lg:sticky lg:top-0">
            <div className="text-xs font-bold uppercase tracking-wide text-blue-300">What the operator sees</div>
            <div className="mt-3 rounded-xl bg-ivory p-4 text-ink">
              <div className="flex justify-center">
                <IngredientPicture code={ing.code} name={ing.name} colorHex={colorHex} photoUrl={ing.photoUrl} className="size-56" />
              </div>
              <div className="mt-3 text-center font-display text-2xl font-bold text-navy">{ing.name}</div>
              <div className="mt-3 flex justify-center">
                {rackCode && bin ? (
                  <LocationBadge rack={rackCode} bin={Number(bin)} color={color} size="lg" />
                ) : (
                  <Badge tone="warn" size="lg">
                    <MapPinOff /> Location not set
                  </Badge>
                )}
              </div>
              {(ppe.length > 0 || hazards.length > 0) && (
                <div className="mt-4 flex flex-wrap justify-center gap-2">
                  {ppe.map((p) => {
                    const { label, icon: Icon } = PPE_INFO[p];
                    return (
                      <div key={p} className="grid w-20 justify-items-center gap-1 rounded-lg bg-white p-2 text-center text-[11px] leading-tight font-semibold break-words text-navy shadow-sm" title={label}>
                        <Icon className="size-7" />
                        {label}
                      </div>
                    );
                  })}
                  {hazards.map((h) => {
                    const { label, icon: Icon } = HAZARD_INFO[h];
                    return (
                      <div key={h} className="grid w-20 justify-items-center gap-1 rounded-lg bg-err-100 p-2 text-center text-[11px] leading-tight font-semibold break-words text-err" title={label}>
                        <Icon className="size-7" />
                        {label}
                      </div>
                    );
                  })}
                </div>
              )}
              {notes.length > 0 && (
                <ul className="mt-4 list-disc space-y-1 pl-5 text-sm">
                  {notes.map((n, k) => (
                    <li key={k}>{n}</li>
                  ))}
                </ul>
              )}
            </div>
          </aside>
        </div>

        {(save.error || localError) && <ErrorBox error={save.error ?? new Error(localError ?? '')} className="mt-6" />}
        <div className="mt-6 flex items-center justify-end gap-3 border-t border-line pt-4">
          {unsaved && <span className="mr-auto text-sm font-semibold text-[#8a5a00]">Unsaved changes</span>}
          <Button variant="ghost" size="md" onClick={requestClose}>
            {unsaved ? 'Discard…' : 'Close'}
          </Button>
          <Button
            variant="primary"
            size="md"
            disabled={!dirty || save.isPending}
            onClick={() => {
              if (locationErr) return setLocalError(locationErr);
              setLocalError(null);
              save.mutate();
            }}
          >
            {save.isPending && <Loader2 className="animate-spin" />} Save changes
          </Button>
        </div>
        <ConfirmDialog
          open={confirm === 'photo'}
          title="Remove the bottle photo?"
          description={`Operators will see the coloured bottle picture for ${ing.name} instead. You can upload a new photo at any time.`}
          confirmLabel="Remove photo"
          pending={photo.isPending}
          error={photo.error}
          onConfirm={() => photo.mutate(null, { onSuccess: () => setConfirm(null) })}
          onClose={() => setConfirm(null)}
        />
        <ConfirmDialog
          open={confirm === 'discard'}
          title="Discard your changes?"
          description={`The changes to ${ing.name} have not been saved.`}
          confirmLabel="Discard changes"
          onConfirm={() => {
            setConfirm(null);
            onClose();
          }}
          onClose={() => setConfirm(null)}
        />
      </DialogContent>
    </Dialog>
  );
}

function LotBadge({ lot }: { lot: AdminLot }) {
  const expired = !!lot.expiresOn && new Date(lot.expiresOn).getTime() < Date.now();
  if (expired)
    return (
      <Badge tone="err" size="sm">
        <X /> Expired
      </Badge>
    );
  if (lot.status === 'RELEASED')
    return (
      <Badge tone="ok" size="sm">
        Released
      </Badge>
    );
  if (lot.status === 'QUARANTINE')
    return (
      <Badge tone="warn" size="sm">
        Quarantine
      </Badge>
    );
  return (
    <Badge tone="err" size="sm">
      Rejected
    </Badge>
  );
}
