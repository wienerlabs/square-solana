import { parseWebConfig } from '@/lib/config';
import { evmChainInfo } from '@/lib/evm-chains';

// Railway sağlık kontrolü (apps/web/railway.json). Yapılandırma geçerliyse 200, değilse 503: eksik ya da
// geçersiz env'le başlayan bir deploy yayına alınmaz. Gövde yalnızca değişken adlarını ve sebepleri taşır,
// değerleri (RPC adresi gibi) taşımaz.
export const dynamic = 'force-dynamic';

export function GET(): Response {
  const result = parseWebConfig(process.env, evmChainInfo);
  return Response.json(result.ok ? { ok: true } : { ok: false, errors: result.errors }, {
    status: result.ok ? 200 : 503,
    headers: { 'cache-control': 'no-store' },
  });
}
