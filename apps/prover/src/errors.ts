/** Hata nesnesinden mesaj; Error olmayan değerler metne çevrilir. */
export const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Log için ad ve mesaj. */
export const errorSummary = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error);
