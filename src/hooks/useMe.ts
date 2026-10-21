import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { api } from '@/lib/api';
import { resetSocket } from '@/lib/socket';
import { usePrefs } from '@/stores/prefs';
import type { MeResponse } from '@shared/types';

export function useMe() {
  return useQuery({ queryKey: ['me'], queryFn: () => api.get<MeResponse>('/auth/me'), staleTime: 30_000 });
}

/** Applies the language default: the operator's own choice, else the station's. */
export function useLanguageDefault(me: MeResponse | undefined) {
  const { langChosen, setLang } = usePrefs();
  useEffect(() => {
    if (!me || langChosen) return;
    const lang = me.user?.language ?? me.station?.defaultLanguage;
    if (lang) setLang(lang, false);
  }, [me, langChosen, setLang]);
}

export function useSignOut() {
  const qc = useQueryClient();
  return async () => {
    await api.post('/auth/logout').catch(() => {});
    usePrefs.setState({ langChosen: false });
    qc.clear();
    resetSocket();
    await qc.invalidateQueries({ queryKey: ['me'] });
  };
}

/** After a successful sign-in: reload identity and let the socket join the right rooms. */
export function useAfterSignIn() {
  const qc = useQueryClient();
  return async () => {
    resetSocket();
    await qc.invalidateQueries({ queryKey: ['me'] });
  };
}
