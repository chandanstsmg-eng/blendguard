import { useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { browserSupportsWebAuthn, startRegistration } from '@simplewebauthn/browser';
import { Fingerprint, KeyRound, Lock, Pencil, ShieldCheck, Trash2, Unlock, UserPlus, Users as UsersIcon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { useMe } from '@/hooks/useMe';
import { api, ApiError } from '@/lib/api';
import { cn, fmtDateTime } from '@/lib/utils';
import { useAdminStations, useAdminUsers } from './queries';
import type { AdminCredential, AdminUser, Lang, NewUserBody, Role, UserPatchBody } from './types';
import { ConfirmDialog, Empty, ErrorBox, Field, inputCls, LANGUAGES, langLabel, Loading, PageHeader, Switch } from './ui';

type Filter = Role | 'ALL';
const FILTERS: { value: Filter; label: string }[] = [
  { value: 'OPERATOR', label: 'Operators' },
  { value: 'SUPERVISOR', label: 'Scientists' },
  { value: 'ALL', label: 'All' },
];

const ROLE_LABEL: Record<Role, string> = { OPERATOR: 'Operator', SUPERVISOR: 'Scientist' };
const roleTone = (r: Role) => (r === 'SUPERVISOR' ? ('orange' as const) : ('neutral' as const));

export function Users() {
  const users = useAdminUsers();
  const { data: me } = useMe();
  const qc = useQueryClient();
  const [filter, setFilter] = useState<Filter>('OPERATOR');
  const [editing, setEditing] = useState<AdminUser | 'new' | null>(null);
  const [secretFor, setSecretFor] = useState<AdminUser | null>(null);
  const [enrol, setEnrol] = useState<AdminUser | null>(null);
  const [revoking, setRevoking] = useState<{ user: AdminUser; cred: AdminCredential } | null>(null);

  const refresh = () => qc.invalidateQueries({ queryKey: ['admin', 'users'] });
  const unlock = useMutation({ mutationFn: (id: string) => api.post(`/admin/operators/${id}/unlock`), onSuccess: refresh });
  const revoke = useMutation({
    mutationFn: (id: string) => api.post(`/admin/credentials/${id}/revoke`),
    onSuccess: () => {
      setRevoking(null);
      void refresh();
    },
  });

  const counts = useMemo(() => {
    const c: Record<Filter, number> = { OPERATOR: 0, SUPERVISOR: 0, ALL: 0 };
    for (const u of users.data ?? []) {
      c[u.role]++;
      c.ALL++;
    }
    return c;
  }, [users.data]);
  const rows = (users.data ?? []).filter((u) => filter === 'ALL' || u.role === filter);
  const showDevices = filter === 'OPERATOR' || filter === 'ALL';

  return (
    <>
      <PageHeader title="Users" subtitle="Everyone who can sign in to BlendGuard, what they're allowed to do, and how they sign in.">
        <Button variant="primary" size="md" onClick={() => setEditing('new')}>
          <UserPlus /> Add user
        </Button>
      </PageHeader>
      <div className="grid gap-6 p-8 2xl:grid-cols-[1fr_320px]">
        <div className="grid min-w-0 content-start gap-4">
          <div className="flex flex-wrap gap-2" role="tablist">
            {FILTERS.map((f) => (
              <button
                key={f.value}
                role="tab"
                aria-selected={filter === f.value}
                onClick={() => setFilter(f.value)}
                className={cn('inline-flex h-10 items-center gap-2 rounded-full border px-4 font-semibold', filter === f.value ? 'border-navy bg-navy text-white' : 'border-line bg-white text-navy hover:bg-mist')}
              >
                {f.label}
                <span className={cn('rounded-full px-2 text-xs', filter === f.value ? 'bg-white/20' : 'bg-mist')}>{counts[f.value]}</span>
              </button>
            ))}
          </div>
          {unlock.error && <ErrorBox error={unlock.error} />}

          {users.isLoading ? (
            <Loading label="Loading users…" />
          ) : users.error ? (
            <ErrorBox error={users.error} />
          ) : rows.length === 0 ? (
            <Empty icon={UsersIcon} title="Nobody here yet">
              Use <b>Add user</b> to create the first {filter === 'ALL' ? 'account' : FILTERS.find((f) => f.value === filter)?.label.toLowerCase().replace(/s$/, '')}.
            </Empty>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-line bg-white">
              <table className="w-full text-left text-sm">
                <thead className="bg-mist text-muted">
                  <tr>
                    {['Name', 'ID / username', 'Role', 'Stations', 'Language', 'Status', ...(showDevices ? ['Fingerprint / face'] : []), 'Last sign-in', ''].map((h, i) => (
                      <th key={i} className="whitespace-nowrap px-4 py-2 font-semibold">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {rows.map((u) => {
                    const isMe = me?.user?.id === u.id;
                    return (
                      <tr key={u.id} className={cn('align-top', !u.active && 'bg-mist/50 text-muted')}>
                        <td className="px-4 py-3">
                          <div className="font-semibold text-ink">{u.name}</div>
                          {isMe && <div className="text-xs font-semibold text-blue">That&apos;s you</div>}
                        </td>
                        <td className="px-4 py-3 font-mono font-semibold">{u.role === 'OPERATOR' ? u.operatorCode : u.username}</td>
                        <td className="px-4 py-3">
                          <Badge tone={roleTone(u.role)} size="sm">
                            {ROLE_LABEL[u.role]}
                          </Badge>
                        </td>
                        <td className="px-4 py-3">{u.role === 'OPERATOR' ? u.stations.join(', ') || <span className="text-err">None</span> : <span className="text-muted">—</span>}</td>
                        <td className="whitespace-nowrap px-4 py-3">{langLabel(u.language)}</td>
                        <td className="px-4 py-3">
                          <div className="flex flex-wrap gap-1">
                            {u.active ? (
                              <Badge tone="ok" size="sm">
                                Active
                              </Badge>
                            ) : (
                              <Badge tone="neutral" size="sm">
                                Inactive
                              </Badge>
                            )}
                            {u.locked && (
                              <Badge tone="err" size="sm">
                                <Lock /> Locked
                              </Badge>
                            )}
                          </div>
                        </td>
                        {showDevices && (
                          <td className="px-4 py-3">
                            {u.role !== 'OPERATOR' ? (
                              <span className="text-muted">—</span>
                            ) : u.credentials.length === 0 ? (
                              <span className="text-muted">None</span>
                            ) : (
                              <ul className="grid gap-1">
                                {u.credentials.map((c) => (
                                  <li key={c.id} className="flex items-center gap-2">
                                    <Fingerprint className="size-4 shrink-0 text-navy" />
                                    <span className="min-w-0">
                                      <span className="block truncate font-medium">{c.label}</span>
                                      <span className="block text-xs text-muted">last used {c.lastUsedAt ? fmtDateTime(c.lastUsedAt) : 'never'}</span>
                                    </span>
                                    <button className="ml-auto grid size-8 shrink-0 place-items-center rounded text-err hover:bg-err-100" title="Remove this device" aria-label={`Remove ${c.label}`} onClick={() => setRevoking({ user: u, cred: c })}>
                                      <Trash2 className="size-4" />
                                    </button>
                                  </li>
                                ))}
                              </ul>
                            )}
                          </td>
                        )}
                        <td className="whitespace-nowrap px-4 py-3">{u.lastSignIn ? fmtDateTime(u.lastSignIn) : <span className="text-muted">Never</span>}</td>
                        <td className="px-4 py-3">
                          <div className="flex flex-wrap justify-end gap-2">
                            {u.locked && (
                              <Button size="sm" variant="outline" disabled={unlock.isPending} onClick={() => unlock.mutate(u.id)}>
                                <Unlock /> Unlock
                              </Button>
                            )}
                            {u.role === 'OPERATOR' && u.active && (
                              <Button size="sm" variant="navy" onClick={() => setEnrol(u)} title="Register fingerprint / face">
                                <Fingerprint /> Register
                              </Button>
                            )}
                            <Button size="sm" variant="ghost" onClick={() => setSecretFor(u)} title={u.role === 'OPERATOR' ? 'Reset PIN' : 'Reset password'}>
                              <KeyRound /> {u.role === 'OPERATOR' ? 'PIN' : 'Password'}
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => setEditing(u)}>
                              <Pencil /> Edit
                            </Button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <p className="max-w-3xl text-sm text-muted">
            Register fingerprints on the station PC the operator will actually use. Windows Hello sign-ins don&apos;t carry over to other computers (a FIDO2 key does). Only the device&apos;s public key is
            stored; the fingerprint or face itself never leaves the reader.
          </p>
        </div>
        <RolesCard />
      </div>

      {editing && <UserDialog user={editing === 'new' ? null : editing} defaultRole={filter === 'ALL' ? 'OPERATOR' : filter} onClose={() => setEditing(null)} />}
      {secretFor && <SecretDialog user={secretFor} onClose={() => setSecretFor(null)} />}
      {enrol && <EnrolDialog operator={enrol} onClose={() => (setEnrol(null), void refresh())} />}
      <ConfirmDialog
        open={!!revoking}
        title="Remove this device?"
        description={revoking ? `"${revoking.cred.label}" will no longer sign in ${revoking.user.name}. They can still use their Operator ID and PIN if the station allows it.` : undefined}
        confirmLabel="Remove device"
        pending={revoke.isPending}
        error={revoke.error}
        onConfirm={() => revoking && revoke.mutate(revoking.cred.id)}
        onClose={() => (setRevoking(null), revoke.reset())}
      />
    </>
  );
}

function RolesCard() {
  const roles = [
    { role: 'Operator', tone: 'neutral' as const, text: 'Runs jobs at the stations they are assigned to. Signs in with fingerprint, face, or Operator ID + PIN.' },
    {
      role: 'Scientist',
      tone: 'orange' as const,
      text: 'Assigns jobs, watches the floor, clears holds and over-weights, records the daily scale check and approves batches. Also manages users, stations and ingredients, and reads the audit log.',
    },
  ];
  return (
    <aside className="h-fit rounded-xl border border-line bg-white p-6">
      <h2 className="flex items-center gap-2 font-display text-lg font-bold text-navy">
        <ShieldCheck className="size-5" /> Who can do what
      </h2>
      <ul className="mt-4 grid gap-4 text-sm">
        {roles.map((r) => (
          <li key={r.role}>
            <Badge tone={r.tone} size="sm">
              {r.role}
            </Badge>
            <p className="mt-1 text-muted">{r.text}</p>
          </li>
        ))}
      </ul>
      <p className="mt-4 border-t border-line pt-4 text-xs text-muted">Switching an account off signs it out everywhere straight away. Nothing is deleted, so the audit trail stays complete.</p>
    </aside>
  );
}

function UserDialog({ user, defaultRole, onClose }: { user: AdminUser | null; defaultRole: Role; onClose: () => void }) {
  const qc = useQueryClient();
  const { data: me } = useMe();
  const stations = useAdminStations();
  const isNew = !user;
  const isMe = !!user && me?.user?.id === user.id;
  const [role, setRole] = useState<Role>(user?.role ?? defaultRole);
  const [name, setName] = useState(user?.name ?? '');
  const [language, setLanguage] = useState<Lang>(user?.language ?? 'en');
  const [active, setActive] = useState(user?.active ?? true);
  const [operatorCode, setOperatorCode] = useState('');
  const [pin, setPin] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [stationIds, setStationIds] = useState<string[]>(user?.stationIds ?? []);
  const [touched, setTouched] = useState(false);
  const isOperator = role === 'OPERATOR';

  const errors: Record<string, string | undefined> = {
    name: name.trim().length < 2 ? 'Enter the full name (at least 2 letters).' : undefined,
    operatorCode: isNew && isOperator && !/^\d{3,8}$/.test(operatorCode) ? 'Operator ID is 3 to 8 numbers.' : undefined,
    pin: isNew && isOperator && !/^\d{4,8}$/.test(pin) ? 'PIN is 4 to 8 numbers.' : undefined,
    username: isNew && !isOperator && !/^[a-zA-Z0-9._-]{3,40}$/.test(username.trim()) ? '3–40 letters, numbers, dot or dash.' : undefined,
    password: isNew && !isOperator && password.length < 8 ? 'At least 8 characters.' : undefined,
  };
  const valid = Object.values(errors).every((e) => !e);
  const showErr = (k: string) => (touched ? errors[k] : undefined);

  const save = useMutation({
    mutationFn: async () => {
      if (isNew) {
        const body: NewUserBody = isOperator
          ? { role, name: name.trim(), language, operatorCode, pin, stationIds }
          : { role, name: name.trim(), language, username: username.trim(), password };
        await api.post<{ id: string }>('/admin/users', body);
      } else {
        const body: UserPatchBody = {};
        if (name.trim() !== user.name) body.name = name.trim();
        if (language !== user.language) body.language = language;
        if (active !== user.active) body.active = active;
        if (user.role === 'OPERATOR' && [...stationIds].sort().join() !== [...user.stationIds].sort().join()) body.stationIds = stationIds;
        if (Object.keys(body).length) await api.patch(`/admin/users/${user.id}`, body);
      }
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin', 'users'] });
      void qc.invalidateQueries({ queryKey: ['admin', 'stations'] });
      onClose();
    },
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (valid) save.mutate();
  };

  // The role is chosen when the account is made and does not change afterwards.
  const roleChoices: Role[] = isNew ? ['OPERATOR', 'SUPERVISOR'] : [user.role];

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="w-[min(680px,calc(100vw-32px))]">
        <DialogTitle>{isNew ? 'Add user' : `Edit ${user.name}`}</DialogTitle>
        <DialogDescription>
          {isNew ? 'Choose what this person does first. The sign-in details depend on it.' : user.role === 'OPERATOR' ? `Operator ID ${user.operatorCode}` : `Username ${user.username}`}
        </DialogDescription>
        <form onSubmit={submit} className="mt-5 grid gap-5" noValidate>
          <fieldset className="grid gap-1.5">
            <legend className="mb-1.5 text-sm font-semibold text-ink">Role</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {roleChoices.map((r) => (
                <button
                  type="button"
                  key={r}
                  onClick={() => setRole(r)}
                  className={cn(
                    'rounded-lg border-2 px-3 py-2 text-left disabled:cursor-not-allowed disabled:opacity-50',
                    role === r ? 'border-navy bg-navy text-white' : 'border-line bg-white text-navy hover:bg-mist',
                  )}
                >
                  <div className="font-semibold">{ROLE_LABEL[r]}</div>
                  <div className={cn('text-xs', role === r ? 'text-white/80' : 'text-muted')}>
                    {r === 'OPERATOR' ? 'ID + PIN, runs jobs' : 'Username + password, runs the floor and the setup'}
                  </div>
                </button>
              ))}
            </div>
            {!isNew && <span className="text-xs text-muted">The role can&apos;t be changed. To give someone the other role, create a separate account.</span>}
            {isMe && <span className="text-xs text-muted">You can&apos;t switch yourself off.</span>}
          </fieldset>

          <div className="grid gap-5 md:grid-cols-2">
            <Field label="Full name" error={showErr('name')}>
              <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} className={inputCls} autoFocus />
            </Field>
            <Field label="Screen language" hint={isOperator ? 'What the station shows after they sign in' : undefined}>
              <select value={language} onChange={(e) => setLanguage(e.target.value as Lang)} className={inputCls}>
                {LANGUAGES.map((l) => (
                  <option key={l.value} value={l.value}>
                    {l.label}
                  </option>
                ))}
              </select>
            </Field>
            {isNew && isOperator && (
              <>
                <Field label="Operator ID" hint="3–8 numbers, typed at the station" error={showErr('operatorCode')}>
                  <input value={operatorCode} onChange={(e) => setOperatorCode(e.target.value.replace(/\D/g, ''))} inputMode="numeric" maxLength={8} className={cn(inputCls, 'font-mono')} />
                </Field>
                <Field label="PIN" hint="4–8 numbers. Tell the operator in person." error={showErr('pin')}>
                  <input value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} inputMode="numeric" maxLength={8} type="password" autoComplete="new-password" className={cn(inputCls, 'font-mono')} />
                </Field>
              </>
            )}
            {isNew && !isOperator && (
              <>
                <Field label="Username" hint="For signing in to the console" error={showErr('username')}>
                  <input value={username} onChange={(e) => setUsername(e.target.value)} maxLength={40} autoComplete="off" className={inputCls} />
                </Field>
                <Field label="Password" hint="At least 8 characters" error={showErr('password')}>
                  <input value={password} onChange={(e) => setPassword(e.target.value)} type="password" autoComplete="new-password" className={inputCls} />
                </Field>
              </>
            )}
          </div>

          {isOperator && (
            <fieldset className="grid gap-1.5">
              <legend className="mb-1.5 text-sm font-semibold text-ink">Stations this operator may work at</legend>
              {stations.isLoading ? (
                <span className="text-sm text-muted">Loading stations…</span>
              ) : (
                <div className="grid gap-2 sm:grid-cols-2">
                  {stations.data?.map((s) => (
                    <label key={s.id} className={cn('flex h-11 cursor-pointer items-center gap-3 rounded-lg border px-3', stationIds.includes(s.id) ? 'border-navy bg-mist' : 'border-line')}>
                      <input
                        type="checkbox"
                        className="size-5 accent-[#17394C]"
                        checked={stationIds.includes(s.id)}
                        onChange={(e) => setStationIds((ids) => (e.target.checked ? [...ids, s.id] : ids.filter((x) => x !== s.id)))}
                      />
                      <span className="font-semibold">{s.name}</span>
                      <span className="ml-auto text-xs text-muted">{s.code}</span>
                    </label>
                  ))}
                </div>
              )}
              {stationIds.length === 0 && <span className="text-xs text-muted">With no stations they can sign in, but nobody can assign them a job.</span>}
            </fieldset>
          )}

          {!isNew && (
            <div className="flex items-center justify-between gap-4 rounded-lg border border-line px-4 py-3">
              <div>
                <div className="font-semibold">Account active</div>
                <div className="text-sm text-muted">{active ? 'Can sign in.' : 'Cannot sign in. Switching off ends any open session immediately.'}</div>
              </div>
              <Switch checked={active} onChange={setActive} disabled={isMe} label="Account active" />
            </div>
          )}

          <ErrorBox error={save.error} />
          <div className="flex justify-end gap-3">
            <Button type="button" variant="ghost" size="md" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" size="md" disabled={save.isPending || (touched && !valid)}>
              {isNew ? 'Create account' : 'Save changes'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function SecretDialog({ user, onClose }: { user: AdminUser; onClose: () => void }) {
  const qc = useQueryClient();
  const isOperator = user.role === 'OPERATOR';
  const [secret, setSecret] = useState('');
  const [confirm, setConfirm] = useState('');
  const [touched, setTouched] = useState(false);
  const fmtErr = isOperator ? (!/^\d{4,8}$/.test(secret) ? 'A PIN is 4 to 8 numbers.' : undefined) : secret.length < 8 ? 'At least 8 characters.' : undefined;
  const matchErr = secret !== confirm ? `The two ${isOperator ? 'PINs' : 'passwords'} don't match.` : undefined;
  const save = useMutation({
    mutationFn: () => api.post(`/admin/users/${user.id}/secret`, { secret }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['admin', 'users'] }),
  });
  const what = isOperator ? 'PIN' : 'password';

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="w-[min(520px,calc(100vw-32px))]">
        <DialogTitle>Reset {what}</DialogTitle>
        <DialogDescription>
          {user.name} · {isOperator ? `Operator ID ${user.operatorCode}` : user.username}
        </DialogDescription>
        {save.isSuccess ? (
          <div className="mt-5 grid gap-4">
            <p className="rounded-lg bg-ok-100 p-4 font-semibold text-ok">New {what} set{user.locked ? ' and the account is unlocked' : ''}. Tell {user.name.split(' ')[0]} in person, and don&apos;t write it down.</p>
            <Button variant="navy" size="md" onClick={onClose}>
              Done
            </Button>
          </div>
        ) : (
          <form
            className="mt-5 grid gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              setTouched(true);
              if (!fmtErr && !matchErr) save.mutate();
            }}
          >
            <Field label={`New ${what}`} hint={isOperator ? '4–8 numbers' : 'At least 8 characters'} error={touched ? fmtErr : undefined}>
              <input
                value={secret}
                onChange={(e) => setSecret(isOperator ? e.target.value.replace(/\D/g, '') : e.target.value)}
                type="password"
                inputMode={isOperator ? 'numeric' : undefined}
                maxLength={isOperator ? 8 : 200}
                autoComplete="new-password"
                autoFocus
                className={cn(inputCls, isOperator && 'font-mono')}
              />
            </Field>
            <Field label={`Type it again`} error={touched && !fmtErr ? matchErr : undefined}>
              <input
                value={confirm}
                onChange={(e) => setConfirm(isOperator ? e.target.value.replace(/\D/g, '') : e.target.value)}
                type="password"
                inputMode={isOperator ? 'numeric' : undefined}
                maxLength={isOperator ? 8 : 200}
                autoComplete="new-password"
                className={cn(inputCls, isOperator && 'font-mono')}
              />
            </Field>
            {user.locked && <p className="text-sm text-muted">This also unlocks the account.</p>}
            <ErrorBox error={save.error} />
            <div className="flex justify-end gap-3">
              <Button type="button" variant="ghost" size="md" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" variant="primary" size="md" disabled={save.isPending}>
                <KeyRound /> Set new {what}
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function EnrolDialog({ operator, onClose }: { operator: AdminUser; onClose: () => void }) {
  const { data: me } = useMe();
  const [label, setLabel] = useState(`${me?.station?.name ?? 'Station'} biometric`);
  const [state, setState] = useState<'idle' | 'waiting' | 'done' | 'error'>('idle');
  const [msg, setMsg] = useState('');
  const supported = browserSupportsWebAuthn() && window.isSecureContext;

  const run = async () => {
    setState('waiting');
    setMsg('');
    try {
      const optionsJSON = await api.post<Parameters<typeof startRegistration>[0]['optionsJSON']>(`/admin/operators/${operator.id}/webauthn/options`);
      const response = await startRegistration({ optionsJSON });
      await api.post(`/admin/operators/${operator.id}/webauthn/verify`, { response, label });
      setState('done');
    } catch (e) {
      setState('error');
      setMsg(
        e instanceof ApiError
          ? e.message
          : e instanceof Error && e.name === 'NotAllowedError'
            ? 'Cancelled or timed out. Try again.'
            : e instanceof Error && e.name === 'InvalidStateError'
              ? 'This device is already registered for this operator.'
              : 'Registration failed.',
      );
    }
  };

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogTitle>Register fingerprint / face</DialogTitle>
        <DialogDescription>
          {operator.name} · Operator ID {operator.operatorCode}
        </DialogDescription>
        {!supported ? (
          <p className="mt-5 rounded-lg bg-err-100 p-4 font-semibold text-err">This browser cannot use fingerprint or face sign-in here. Open BlendGuard on the station itself via http://localhost, or over https.</p>
        ) : state === 'done' ? (
          <div className="mt-5 grid gap-4">
            <p className="rounded-lg bg-ok-100 p-4 font-semibold text-ok">Registered. {operator.name.split(' ')[0]} can now sign in with “Scan fingerprint” / “Verify face” on this computer.</p>
            <Button variant="navy" onClick={onClose}>
              Done
            </Button>
          </div>
        ) : (
          <div className="mt-5 grid gap-4">
            <label className="grid gap-1">
              <span className="text-sm font-semibold">Device name (shown in the list)</span>
              <input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={60} className="h-11 rounded-lg border border-line px-3 focus:border-navy focus:outline-none" />
            </label>
            <ol className="list-decimal space-y-1 pl-5 text-muted">
              <li>Press Start.</li>
              <li>The operator touches the fingerprint reader (or looks at the camera) when Windows asks.</li>
            </ol>
            {msg && <p className="rounded-lg bg-err-100 p-3 font-semibold text-err">{msg}</p>}
            <Button variant="navy" size="md" className="h-12" disabled={state === 'waiting'} onClick={run}>
              <Fingerprint /> {state === 'waiting' ? 'Waiting for the device…' : 'Start'}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
