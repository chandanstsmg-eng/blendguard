import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { ConfirmDialog } from '../admin/ui';
import { REASON } from './labels';
import type { Overview } from './types';

type Call = Overview['calls'][number];

/**
 * Answering and closing operator calls, shared by Jobs & calls and the floor
 * monitor. "On my way" is sent straight away; closing a call asks first, since
 * the operator's call disappears from their screen.
 */
export function useCallActions() {
  const qc = useQueryClient();
  const [closing, setClosing] = useState<Call | null>(null);
  const done = () => qc.invalidateQueries({ queryKey: ['overview'] });
  const ack = useMutation({ mutationFn: (id: string) => api.post(`/supervisor/calls/${id}/ack`), onSuccess: done });
  const close = useMutation({
    mutationFn: (id: string) => api.post(`/supervisor/calls/${id}/close`),
    onSuccess: async () => {
      setClosing(null);
      await done();
    },
  });

  const dialog = (
    <ConfirmDialog
      open={!!closing}
      title="Close this call?"
      description={closing ? `${closing.stationName}: ${REASON[closing.reason] ?? closing.reason}, raised by ${closing.raisedBy}. Close it only when the operator no longer needs you.` : undefined}
      confirmLabel="Close call"
      tone="navy"
      pending={close.isPending}
      error={close.error}
      onConfirm={() => closing && close.mutate(closing.id)}
      onClose={() => {
        setClosing(null);
        close.reset();
      }}
    />
  );

  return {
    acknowledge: (c: Call) => ack.mutate(c.id),
    requestClose: (c: Call) => {
      close.reset();
      setClosing(c);
    },
    busy: ack.isPending || close.isPending,
    /** The last failed "On my way" (closing errors show inside the dialog). */
    error: ack.error,
    dismissError: () => ack.reset(),
    dialog,
  };
}
