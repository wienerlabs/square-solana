/** Sözleşme imzası olup henüz uygulanmamış fonksiyonlar bunu fırlatır; `issue` uygulayacak issue'yu gösterir. */
export class NotImplementedError extends Error {
  readonly issue: string;

  constructor(fn: string, issue: string) {
    super(`${fn} henüz uygulanmadı (${issue})`);
    this.name = 'NotImplementedError';
    this.issue = issue;
  }
}
