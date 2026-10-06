// Rol seçimi (FE-03). Roller Square sözlüğündeki kullanıcı rolleridir (analiz §7, "Rol terminolojisi": institution, agent,
// buyer) ve uyuşmazlık için arbitrator (FE-17); keeper uygulamada rol seçmez. Rolün adımları sekiz adımlı akışın aktör
// alanından türetilir, ayrı bir liste tutulmaz; arbitrator akışın dışındadır (dispute, ADR 0016). Rol yalnızca arayüzü
// düzenler: arbitrator konsolu cüzdanın zincirdeki aktif arbitrator setinde olup olmadığını ayrıca denetler.
import { FLOW_STEPS } from './flow';

export const ROLES = ['institution', 'agent', 'buyer', 'arbitrator'] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_INFO: Readonly<Record<Role, { label: string; summary: string }>> = {
  institution: {
    label: 'Institution',
    summary: 'Commits the spending policy, opens and funds jobs, and binds the compliance proof before release.',
  },
  agent: {
    label: 'Agent',
    summary: 'Registers its did:aip identity, accepts and delivers jobs, and can sell the receivable.',
  },
  buyer: {
    label: 'Buyer',
    summary: "Buys a receivable at a discount when the institution's policy approves the buyer.",
  },
  arbitrator: {
    label: 'Arbitrator',
    summary: "Votes on disputes with the escrow's M-of-N panel and follows them from the arbitration console.",
  },
};

const isRole = (value: string | null): value is Role => (ROLES as readonly (string | null)[]).includes(value);

/** Rolün yer aldığı adım numaraları. */
export function roleSteps(role: Role): number[] {
  return FLOW_STEPS.filter((step) =>
    step.actor
      .toLowerCase()
      .split(/[^a-z]+/)
      .includes(role),
  ).map((step) => step.number);
}

// Seçim cüzdan başına, bu tarayıcıda tutulur: aynı tarayıcıda her rol cüzdanı kendi rolünü hatırlar.
const storageKey = (address: string) => `square-role:${address}`;

/** Depolama erişilemezse (gizli pencere, engellenmiş site verisi) seçim yok sayılır. */
export function readRole(address: string): Role | null {
  try {
    const value = window.localStorage.getItem(storageKey(address));
    return isRole(value) ? value : null;
  } catch {
    return null;
  }
}

export function writeRole(address: string, role: Role): void {
  try {
    window.localStorage.setItem(storageKey(address), role);
  } catch {
    // Kaydedilemezse seçim bu oturumla sınırlı kalır.
  }
}
