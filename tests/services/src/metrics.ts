export interface MetricSample {
  readonly name: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly value: number;
}

const SAMPLE = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{(.*)\})?\s+(\S+)(?:\s+\d+)?$/;
const LABEL = /([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g;

const unescape = (value: string) => value.replace(/\\(.)/g, (_, char: string) => (char === 'n' ? '\n' : char));

export function parseMetrics(text: string): MetricSample[] {
  return text.split('\n').flatMap((raw): MetricSample[] => {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) return [];
    const match = SAMPLE.exec(line);
    if (!match) throw new Error(`Prometheus satırı çözülemedi: ${line}`);
    const labels = Object.fromEntries(
      [...(match[2] ?? '').matchAll(LABEL)].map(([, key, value]) => [key, unescape(value!)]),
    );
    return [{ name: match[1]!, labels, value: Number(match[3]) }];
  });
}

export function matching(
  samples: readonly MetricSample[],
  name: string,
  labels: Readonly<Record<string, string>> = {},
): MetricSample[] {
  return samples.filter(
    (sample) => sample.name === name && Object.entries(labels).every(([key, value]) => sample.labels[key] === value),
  );
}

export const metricSum = (
  samples: readonly MetricSample[],
  name: string,
  labels: Readonly<Record<string, string>> = {},
): number => matching(samples, name, labels).reduce((sum, sample) => sum + sample.value, 0);
