/**
 * What the operator is doing right now, for screens outside the run page.
 * `weighing` is true while a zeroed weighing step is on screen: the operator
 * is pouring with both hands and may not touch the screen for minutes, so the
 * idle sign-out must not cover the live weight.
 */
import { create } from 'zustand';

interface Activity {
  weighing: boolean;
  setWeighing: (on: boolean) => void;
}

export const useActivity = create<Activity>((set) => ({
  weighing: false,
  setWeighing: (weighing) => set({ weighing }),
}));
