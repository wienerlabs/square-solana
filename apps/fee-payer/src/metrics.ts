// Maliyet metrikleri (Prometheus, servisin kayıt defterinde). Kullanıcı kimliği etiket olmaz (kardinalite):
// kullanıcı başına toplamlar `sponsored_txs` tablosunda ve `GET /v1/sponsor/usage`'dadır; dağılımları
// `square_fee_payer_user_daily_spend_lamports` histogramındadır.
import { Counter, Gauge, Histogram, type Registry } from '@squaresdk/solana-observability';

export type SponsorOutcome = 'signed' | 'submitted' | 'rejected' | 'failed';

export interface SponsorMetrics {
  readonly requests: Counter<'outcome'>;
  readonly rejections: Counter<'reason'>;
  readonly feeLamports: Counter;
  readonly rentLamports: Counter;
  readonly computeUnits: Histogram;
  readonly txCost: Histogram;
  readonly userDailySpend: Histogram;
  readonly balance: Gauge;
}

/** Lamport kovaları: 5 bin (tek imza) – 0,1 SOL. */
const LAMPORT_BUCKETS = [
  5_000, 10_000, 50_000, 100_000, 500_000, 1_000_000, 2_500_000, 5_000_000, 10_000_000, 100_000_000,
];
/** Compute unit kovaları: tx tavanına (1,4 M) kadar. */
const UNIT_BUCKETS = [10_000, 25_000, 50_000, 100_000, 200_000, 400_000, 800_000, 1_400_000];

export function createSponsorMetrics(registry: Registry): SponsorMetrics {
  const registers = [registry];
  return {
    requests: new Counter({
      name: 'square_fee_payer_requests_total',
      help: 'Sponsor istekleri, sonuca göre (signed, submitted, rejected, failed)',
      labelNames: ['outcome'],
      registers,
    }),
    rejections: new Counter({
      name: 'square_fee_payer_rejections_total',
      help: 'Reddedilen sponsor istekleri, sebebe göre (politika, bütçe, simülasyon)',
      labelNames: ['reason'],
      registers,
    }),
    feeLamports: new Counter({
      name: 'square_fee_payer_fee_lamports_total',
      help: 'Sponsorlanan tx’lerin ücretleri (imza + priority fee, lamport)',
      registers,
    }),
    rentLamports: new Counter({
      name: 'square_fee_payer_rent_lamports_total',
      help: 'Sponsorun ödediği rent (lamport)',
      registers,
    }),
    computeUnits: new Histogram({
      name: 'square_fee_payer_compute_units',
      help: 'Sponsorlanan tx’in simülasyonda tükettiği compute unit',
      buckets: UNIT_BUCKETS,
      registers,
    }),
    txCost: new Histogram({
      name: 'square_fee_payer_tx_cost_lamports',
      help: 'Sponsorlanan tx başına maliyet (ücret + rent, lamport)',
      buckets: LAMPORT_BUCKETS,
      registers,
    }),
    userDailySpend: new Histogram({
      name: 'square_fee_payer_user_daily_spend_lamports',
      help: 'Her sponsorlu tx’ten sonra kullanıcının o günkü toplam harcaması (lamport)',
      buckets: LAMPORT_BUCKETS,
      registers,
    }),
    balance: new Gauge({
      name: 'square_fee_payer_balance_lamports',
      help: 'Sponsor anahtarının son okunan bakiyesi (lamport)',
      registers,
    }),
  };
}
