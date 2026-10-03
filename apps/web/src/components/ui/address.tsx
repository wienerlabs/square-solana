import { CopyButton } from './copy-button';

/** Uzun bir base58 değeri baştan ve sondan kısaltır; kısa değerler olduğu gibi kalır. */
export function shorten(value: string, head = 4, tail = 4): string {
  return value.length <= head + tail + 1 ? value : `${value.slice(0, head)}…${value.slice(-tail)}`;
}

/**
 * DID'in yöntem öneklerini (`did:aip:solana:` gibi) korur, uzun segmentleri kısaltır:
 * `did:aip:solana:EtWT…xqa1:Cgch…Vbc:34jS…oEvT`.
 */
export function shortenDid(did: string): string {
  return did
    .split(':')
    .map((segment) => (segment.length > 12 ? shorten(segment) : segment))
    .join(':');
}

function Shortened({ full, short, label }: { full: string; short: string; label: string }) {
  return (
    <span className="inline-flex max-w-full items-center gap-1.5">
      <span className="font-mono" title={full}>
        <span aria-hidden="true">{short}</span>
        <span className="sr-only">{full}</span>
      </span>
      <CopyButton value={full} label={`Copy ${label}`} />
    </span>
  );
}

/** Solana adresi ya da imza: kısaltılmış gösterim, tam değer ekran okuyucuya ve kopyalamaya gider. */
export function Address({ value, label = 'address' }: { value: string; label?: string }) {
  return <Shortened full={value} short={shorten(value)} label={label} />;
}

export function Did({ value }: { value: string }) {
  return <Shortened full={value} short={shortenDid(value)} label="DID" />;
}
