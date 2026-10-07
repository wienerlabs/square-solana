// MPP 402 akışı (BE-25 iş kalemi 4, ADR 0026): `mppx`'in Stripe `charge` yöntemi (Shared Payment Token). Express 4
// isteği Fetch `Request`'e çevrilir; credential `Authorization: Payment …` başlığındadır. Challenge işe bağlıdır
// (tutar, `externalId` = job) ve `API_MPP_SECRET_KEY` ile HMAC'lenir; ödeyen başka bir işin challenge'ını
// kullanamaz. Square PaymentIntent'i SPT ile onaylar; metadata'sı işi taşır, webhook ve mutabakat da aynı ödemeyi
// tanır.
import { Receipt } from 'mppx';
import { Mppx, stripe as mppStripe } from 'mppx/server';
import type Stripe from 'stripe';
import type { FiatJob } from './chain.js';
import { CURRENCY, METADATA } from './service.js';

const DECIMALS = 2;

/** `mppx` challenge yanıtı (402) ya da ödenmiş isteğin makbuzu. */
export type MppOutcome =
  | { readonly paid: false; readonly challenge: Response }
  | {
      readonly paid: true;
      /** PaymentIntent kimliği (`Receipt.reference`). */
      readonly paymentIntent: string;
      /** Yanıta makbuz başlığını (`Payment-Receipt`) ekler. */
      readonly withReceipt: (response: Response) => Response;
    };

export interface MppCharger {
  charge(request: Request, job: FiatJob): Promise<MppOutcome>;
}

/** Sent → `mppx`'in ondalık tutar biçimi (`"12.34"`). */
export function majorUnits(amountMinor: number): string {
  const cents = BigInt(amountMinor);
  return `${cents / 100n}.${(cents % 100n).toString().padStart(DECIMALS, '0')}`;
}

export function createMppCharger(deps: {
  stripe: Stripe;
  secretKey: string;
  networkId: string;
  /** Challenge'ın `realm`'i: API'nin dışarıdan görünen host'u. */
  realm: string;
}): MppCharger {
  const mppx = Mppx.create({
    methods: [
      mppStripe.charge({
        client: deps.stripe,
        networkId: deps.networkId,
        paymentMethodTypes: ['card'],
        currency: CURRENCY,
        decimals: DECIMALS,
      }),
    ],
    secretKey: deps.secretKey,
    realm: deps.realm,
  });

  return {
    async charge(request, job) {
      const address = job.address.toBase58();
      const result = await mppx.charge({
        amount: majorUnits(job.amountMinor),
        description: `Square fiat job ${address}`,
        externalId: address,
        paymentIntentOptions: {
          metadata: { [METADATA.job]: address, [METADATA.institution]: job.institution },
        },
      })(request);
      if (result.status === 402) return { paid: false, challenge: result.challenge };
      const receipt = Receipt.fromResponse(result.withReceipt(new Response(null)) as Response);
      return {
        paid: true,
        paymentIntent: receipt.reference,
        withReceipt: (response) => result.withReceipt(response) as Response,
      };
    },
  };
}
