# @squaresdk/solana-identity

`did:aip` çözümleyicisi (BE-09):
- **Profil:** v2 Solana profili ([spesifikasyon](../../docs/did-aip/method-spec-v2-solana.md)) ve v1.
- **DID belgesi:** Kayıttan ve doğrulanmış karttan kurulur.
- **Agent card:** İndirilir ve zincirdeki hash'le doğrulanır.

```ts
import { squareIdentity } from '@squaresdk/solana-identity';

const result = await squareIdentity.resolveDid(did, {
  connections: { [chainRef]: connection },
  commitment: 'confirmed',
  card: { maxBytes, timeoutMs },
  crossRegistrationLimit,
});
if (result.didResolutionMetadata.error) console.error(result.didResolutionMetadata.error);
else console.log(result.didDocument, result.didDocumentMetadata.agentCard);
```

- **Hata:** `resolveDid` fırlatmaz; hatayı `didResolutionMetadata.error`'da döner.
- **Kart durumu:** `absent`, `unavailable`, `unverified` (hash tutmuyor), `invalid` ya da `verified`
  ([§5.5](../../docs/did-aip/method-spec-v2-solana.md#55-agent-card-integrity-normative)).
- **Test vektörleri:** [`docs/did-aip/test-vectors.json`](../../docs/did-aip/test-vectors.json).
