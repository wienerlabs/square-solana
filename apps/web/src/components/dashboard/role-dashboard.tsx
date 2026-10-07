'use client';

import dynamic from 'next/dynamic';
import type { ComponentType } from 'react';
import { useActor } from '@/components/actor';
import { ActorNotice } from '@/components/actor-notice';
import { useRole } from '@/components/role-provider';
import type { Role } from '@/lib/roles';

// Paneller Anchor'a bağlıdır; yalnızca seçilen rolün paneli yüklenir (genel bakış sayfası hafif kalır).
const DASHBOARDS: Partial<Record<Role, ComponentType<{ owner: string }>>> = {
  institution: dynamic(() => import('./institution-dashboard')),
  agent: dynamic(() => import('./agent-dashboard')),
  buyer: dynamic(() => import('./buyer-dashboard')),
};

/**
 * Bağlı cüzdanın seçtiği rolün paneli (FE-11); rol seçilmemişse rol seçici yol gösterir. Panel rolün adresini
 * gösterir: cüzdan ya da rolün smart account vault'u (FE-21).
 */
export function RoleDashboard() {
  const { role } = useRole();
  const actor = useActor(role);
  const owner = actor.address?.toBase58() ?? null;
  const Dashboard = role ? DASHBOARDS[role] : undefined;
  if (!owner || !Dashboard) return null;
  return (
    <>
      <ActorNotice actor={actor} />
      <Dashboard key={owner} owner={owner} />
    </>
  );
}
