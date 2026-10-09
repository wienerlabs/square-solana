'use client';

import Link from 'next/link';
import { Address } from '@/components/ui/address';
import type { Actor } from './actor';

/**
 * Rol sponsorla ya da smart account'la çalışıyorsa sayfanın üstündeki not: işlemler hangi adres adına gidiyor ve
 * ücreti kim ödüyor (FE-21). Cüzdan modunda bir şey göstermez.
 */
export function ActorNotice({ actor }: { actor: Actor }) {
  if (actor.mode === 'wallet') return null;
  return (
    <p role="status" className="mb-6 card p-4 text-sm text-muted">
      {actor.mode === 'smartAccount' && actor.address ? (
        <>
          Acting as the smart account vault <Address value={actor.address.toBase58()} label="vault" />. Each step is
          proposed and executed with this wallet&apos;s approval; the sponsor pays the fees and rent.{' '}
        </>
      ) : (
        <>The sponsor pays the fees and rent of this wallet&apos;s transactions. </>
      )}
      {actor.problem && <span className="text-danger-text">{actor.problem} </span>}
      <Link href="/app/account" className="text-link underline">
        Manage the account
      </Link>
    </p>
  );
}
