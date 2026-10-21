import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { AdminFormula, AdminIngredients, AdminStation, AdminUser } from './types';

export const useAdminUsers = () => useQuery({ queryKey: ['admin', 'users'], queryFn: () => api.get<AdminUser[]>('/admin/users') });
export const useAdminStations = () => useQuery({ queryKey: ['admin', 'stations'], queryFn: () => api.get<AdminStation[]>('/admin/stations'), refetchInterval: 30_000 });
export const useAdminIngredients = () => useQuery({ queryKey: ['admin', 'ingredients'], queryFn: () => api.get<AdminIngredients>('/admin/ingredients') });
export const useAdminFormulas = () => useQuery({ queryKey: ['admin', 'formulas'], queryFn: () => api.get<AdminFormula[]>('/admin/formulas') });
