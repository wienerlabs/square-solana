// Servisin logger'ı (`@squaresdk/solana-observability`, BE-12): kayıtlar tek satır JSON; gizli alanlar ve
// mesajdaki gizli biçimler (Stripe anahtarları, bağlantı adresindeki parola, RPC anahtarı …) maskelenir.
// Hata kayıtları `compliance_errors` alarmının penceresine sayılır.
import { createEventWindow, createLogger } from '@squaresdk/solana-observability';
import { config } from '../config.js';
import { packageInfo } from './package-info.js';

export const errorWindow = createEventWindow({ windowSeconds: config.alerts.errorWindowSeconds });

export const logger = createLogger({
  service: packageInfo.name,
  level: config.observability.logLevel,
  observers: [
    (record) => {
      if (record.level === 'error') errorWindow.record();
    },
  ],
});
