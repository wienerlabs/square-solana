'use client';

import { Address } from '@/components/ui/address';
import { Button } from '@/components/ui/button';
import type { ApiSessionState } from '@/lib/api-session';
import { ENV_VARS } from '@/lib/config';

const iso = (unix: number) => new Date(unix * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');

/** Square API oturumunun durumu ve giriş / çıkış; `purpose` oturumun ne için gerektiğini söyler. */
export function ApiSessionPanel({ session, purpose }: { session: ApiSessionState; purpose: string }) {
  if (!session.configured) {
    return (
      <p className="text-sm text-muted">
        {purpose} needs the Square API, and <span className="font-mono">{ENV_VARS.apiUrl}</span> is not set.
      </p>
    );
  }
  if (session.session) {
    return (
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span>
          Signed in to the Square API as <Address value={session.session.wallet} label="signed-in wallet" /> until{' '}
          <time dateTime={iso(session.session.expiresAt)}>{iso(session.session.expiresAt)}</time>.
        </span>
        <Button variant="ghost" size="sm" onClick={() => void session.signOut()}>
          Sign out of the API
        </Button>
      </div>
    );
  }
  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="secondary"
          onClick={() => void session.signIn()}
          loading={session.signingIn}
          disabled={!session.canSignIn}
        >
          Sign in to the Square API
        </Button>
        <p className="text-caption text-muted">
          {purpose} goes through the Square API. Your wallet signs a sign-in message, not a transaction.
        </p>
      </div>
      {!session.canSignIn && (
        <p className="text-caption text-muted">Connect a wallet that can sign messages to sign in.</p>
      )}
      {session.error && <p className="text-sm text-danger-text">{session.error}</p>}
    </div>
  );
}
