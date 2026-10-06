'use client';

import dynamic from 'next/dynamic';
import type { ComponentType } from 'react';
import { useRole } from '@/components/role-provider';
import type { Role } from '@/lib/roles';

// Paneller Anchor'a bağlıdır; yalnızca seçilen rolün paneli yüklenir (genel bakış sayfası hafif kalır).
const DASHBOARDS: Partial<Record<Role, ComponentType<{ owner: string }>>> = {
  institution: dynamic(() => import('./institution-dashboard')),
  agent: dynamic(() => import('./agent-dashboard')),
  buyer: dynamic(() => import('./buyer-dashboard')),
};

/** Bağlı cüzdanın seçtiği rolün paneli (FE-11); rol seçilmemişse rol seçici yol gösterir. */
export function RoleDashboard() {
  const { address, role } = useRole();
  const Dashboard = role ? DASHBOARDS[role] : undefined;
  if (!address || !Dashboard) return null;
  return <Dashboard owner={address} />;
}
