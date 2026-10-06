// Kayıt ve tx hazırlığının istemciye dönen hataları. API bunları HTTP durumuna çevirir (`kind`); relayer
// kullanmaz.
export type CctpErrorKind = 'invalid' | 'forbidden' | 'notFound' | 'conflict';

export class CctpError extends Error {
  constructor(
    readonly kind: CctpErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'CctpError';
  }
}
