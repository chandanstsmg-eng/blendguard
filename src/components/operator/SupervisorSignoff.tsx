import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Loader2, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { api, ApiError } from '@/lib/api';
import { errorText, useT, type TKey } from '@/lib/i18n';
import type { RunState } from '@shared/types';

/** Scale problems the supervisor must act on: the server's own (more technical) sentence is shown. */
const SERVER_TEXT = new Set(['SCALE_DISCONNECTED', 'SCALE_NOT_VALIDATED', 'CANNOT_CERTIFY', 'STILL_OVER']);

export type SupervisorAction = 'ALLOW_REWEIGH' | 'ACCEPT_VESSEL' | 'HOLD_BATCH' | 'RELEASE_HOLD' | 'CLOSE_CALL';

/**
 * The supervisor, standing at the station, signs in with their OWN account to
 * approve a correction. The operator's session stays open; the action is
 * recorded under the scientist's identity with their note.
 */
export function SupervisorSignoff({ run, actions, open, onOpenChange }: { run: RunState; actions: SupervisorAction[]; open: boolean; onOpenChange: (v: boolean) => void }) {
  const t = useT();
  const qc = useQueryClient();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [token, setToken] = useState<{ token: string; name: string } | null>(null);
  const [action, setAction] = useState<SupervisorAction>(actions[0]);
  const [note, setNote] = useState('');

  const reset = () => {
    setUsername('');
    setPassword('');
    setToken(null);
    setNote('');
    setAction(actions[0]);
  };

  const signin = useMutation({
    mutationFn: () => api.post<{ token: string; name: string }>('/auth/signoff', { username, password, batchId: run.id }),
    onMutate: () => act.reset(),
    onSuccess: (r) => {
      setToken(r);
      setPassword('');
    },
  });
  const act = useMutation({
    mutationFn: () => api.post<RunState>(`/batches/${run.id}/supervisor-action`, { token: token!.token, action, note, version: run.version }),
    // A one-time sign-off that was already spent: back to the sign-in step (the note is kept).
    onError: (e) => {
      if (e instanceof ApiError && e.code === 'SIGNOFF_USED') setToken(null);
    },
    onSuccess: (r) => {
      qc.setQueryData(['run', r.id], r);
      void qc.invalidateQueries({ queryKey: ['call'] });
      reset();
      onOpenChange(false);
    },
  });
  const err = (signin.error ?? act.error) as ApiError | null;

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) reset();
        onOpenChange(v);
      }}
    >
      <DialogContent className="w-[min(720px,calc(100vw-32px))]">
        <DialogTitle className="flex items-center gap-3">
          <ShieldCheck className="size-8 text-ok" />
          {t('signoff.title')}
        </DialogTitle>
        {!token ? (
          <form
            className="mt-5 grid gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              signin.mutate();
            }}
          >
            <DialogDescription>{t('signoff.intro')}</DialogDescription>
            <Field label={t('signoff.username')} value={username} onChange={setUsername} autoComplete="username" />
            <Field label={t('signoff.password')} value={password} onChange={setPassword} type="password" autoComplete="current-password" />
            <Button type="submit" variant="navy" size="lg" disabled={!username || !password || signin.isPending}>
              {signin.isPending && <Loader2 className="animate-spin" />}
              {t('signoff.signIn')}
            </Button>
          </form>
        ) : (
          <div className="mt-5 grid gap-4">
            <p className="text-lg">{t('signoff.signedInAs', { name: token.name })}</p>
            <div className="grid gap-2" role="radiogroup">
              {actions.map((a) => (
                <label key={a} className={'flex cursor-pointer gap-3 rounded-xl border-2 p-4 ' + (action === a ? 'border-navy bg-mist' : 'border-line')}>
                  <input type="radio" name="action" className="mt-1 size-5 accent-[#17394C]" checked={action === a} onChange={() => setAction(a)} />
                  <span>
                    <span className="block text-lg font-semibold text-navy">{t(`signoff.${a}` as TKey)}</span>
                    <span className="block text-muted">{t(`signoff.${a}.help` as TKey)}</span>
                  </span>
                </label>
              ))}
            </div>
            <label className="grid gap-1">
              <span className="font-semibold">{t('signoff.note')}</span>
              <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} maxLength={500} className="rounded-lg border-2 border-line p-3 text-lg focus:border-navy focus:outline-none" />
            </label>
            <Button variant="success" size="lg" disabled={act.isPending || (action !== 'CLOSE_CALL' && note.trim().length < 3)} onClick={() => act.mutate()}>
              {act.isPending && <Loader2 className="animate-spin" />}
              {t('signoff.confirm')}
            </Button>
          </div>
        )}
        {err && (
          <p role="alert" className="mt-4 flex items-center gap-3 rounded-xl bg-err-100 px-4 py-3 text-lg font-semibold text-err">
            <AlertTriangle className="size-6 shrink-0" />
            {err.code && SERVER_TEXT.has(err.code) && err.message ? err.message : errorText(t.lang, err.code, err.message)}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, value, onChange, type = 'text', autoComplete }: { label: string; value: string; onChange: (v: string) => void; type?: string; autoComplete?: string }) {
  return (
    <label className="grid gap-1">
      <span className="font-semibold">{label}</span>
      <input
        type={type}
        value={value}
        autoComplete={autoComplete}
        onChange={(e) => onChange(e.target.value)}
        className="h-14 rounded-lg border-2 border-line px-4 text-xl focus:border-navy focus:outline-none"
      />
    </label>
  );
}
