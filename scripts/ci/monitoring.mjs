#!/usr/bin/env node
// İzleme yapılandırmasının denetimi (BE-33): Prometheus kurallarındaki ve Grafana panosundaki her PromQL ifadesi
// sözdizimce geçerli olmalı ve yalnızca servislerin yayımladığı serilere ya da kayıt kurallarına başvurmalı.
// Histogram kovasına (`le="60"`) başvuran ifadede o kova histogramın sınırlarında bulunmalı: kova değişirse SLO
// sessizce boş seriye dönmesin. Metrikler kaynaktan okunur (`new Counter|Gauge|Histogram({ name: '…' })`);
// sınırı verilmeyen histogram istemcinin varsayılan kovalarını kullanır. Alarmın `severity` etiketi ve özeti
// olmalı. Kullanım: `node scripts/ci/monitoring.mjs`.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parser } from '@prometheus-io/lezer-promql';
import { parse as parseYaml } from 'yaml';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const RULES_FILE = 'infra/monitoring/prometheus/square-slo.rules.yml';
export const DASHBOARD_FILE = 'infra/monitoring/grafana/square-slo.json';
/** Metrik tanımlarının arandığı kaynak dizinleri: servislerin `src`'si ve ortak gözlemlenebilirlik paketi. */
const sourceDirs = () => [
  ...readdirSync(join(ROOT, 'apps'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join('apps', entry.name, 'src')),
  'packages/observability/src',
];
const SEVERITIES = new Set(['critical', 'warning']);
const HISTOGRAM_SERIES = ['_bucket', '_sum', '_count'];
/** Grafana'nın aralık değişkenleri; ayrıştırmadan önce bir süreyle değiştirilir. */
const GRAFANA_RANGE = /\$__(range|rate_interval|interval)\b/g;

/** İfadenin sözdizimi hatası ve başvurduğu seriler ile `<seri>{le="…"}` kova başvuruları. */
export function analyzeExpr(expr) {
  const tree = parser.parse(expr);
  const series = [];
  const buckets = [];
  let invalid = false;
  tree.iterate({
    enter(node) {
      if (node.type.isError) invalid = true;
      if (node.name !== 'VectorSelector') return;
      const identifier = node.node.getChild('Identifier');
      if (!identifier) return;
      const name = expr.slice(identifier.from, identifier.to);
      series.push(name);
      const matchers = node.node.getChild('LabelMatchers');
      for (const matcher of matchers?.getChildren('UnquotedLabelMatcher') ?? []) {
        const label = matcher.getChild('LabelName');
        const value = matcher.getChild('StringLiteral');
        if (label && value && expr.slice(label.from, label.to) === 'le') {
          buckets.push({ series: name, le: Number(expr.slice(value.from + 1, value.to - 1)) });
        }
      }
    },
  });
  return { invalid, series, buckets };
}

const numbers = (list) =>
  list
    .split(',')
    .map((item) => item.trim().replaceAll('_', ''))
    .filter(Boolean)
    .map(Number);

/**
 * Kaynak metinlerinden tanımlı metrikler: ad → { kind, buckets }. Histogramın sınırları ya dizi olarak ya da
 * aynı dosyadaki `export const AD = [...]` sabitiyle verilir; verilmezse `defaultBuckets`.
 */
export function definedMetrics(sources, defaultBuckets) {
  const metrics = new Map();
  for (const { file, text } of sources) {
    for (const match of text.matchAll(/new (Counter|Gauge|Histogram)\(\{([\s\S]*?)\}\)/g)) {
      const [, kind, body] = match;
      const name = /name:\s*'([A-Za-z_:][A-Za-z0-9_:]*)'/.exec(body)?.[1];
      if (!name) continue;
      let buckets = null;
      if (kind === 'Histogram') {
        const literal = /buckets:\s*\[([^\]]*)\]/.exec(body)?.[1];
        const constant = literal && /^\s*\.\.\.([A-Z_]+)\s*$/.exec(literal)?.[1];
        if (constant) {
          const values = new RegExp(`export const ${constant} = \\[([^\\]]*)\\]`).exec(text)?.[1];
          if (values === undefined) throw new Error(`${file}: ${name} kovaları ${constant} sabitinde bulunamadı`);
          buckets = numbers(values);
        } else {
          buckets = literal === undefined ? [...defaultBuckets] : numbers(literal);
        }
      }
      metrics.set(name, { kind, buckets });
    }
  }
  return metrics;
}

/** Tanımlı metriklerin Prometheus'ta görünen seri adları (histogramın alt serileri dahil). */
export function seriesOf(metrics) {
  const names = new Map();
  for (const [name, metric] of metrics) {
    if (metric.kind === 'Histogram') {
      for (const suffix of HISTOGRAM_SERIES) names.set(`${name}${suffix}`, name);
    } else {
      names.set(name, name);
    }
  }
  return names;
}

/** Kural dosyasının ifadeleri; alarmların etiket ve özet eksikleri. */
export function ruleEntries(rulesText) {
  const document = parseYaml(rulesText);
  const entries = [];
  const problems = [];
  for (const group of document?.groups ?? []) {
    for (const rule of group.rules ?? []) {
      const where = `${group.name}/${rule.record ?? rule.alert}`;
      entries.push({ where, expr: String(rule.expr), record: rule.record ?? null });
      if (rule.alert) {
        if (!SEVERITIES.has(rule.labels?.severity)) problems.push(`${where}: severity critical ya da warning olmalı`);
        if (!rule.annotations?.summary) problems.push(`${where}: annotations.summary yok`);
      }
    }
  }
  return { entries, problems };
}

/** Panodaki sorgular (satır panelleri hariç). */
export function dashboardEntries(dashboardText) {
  const dashboard = JSON.parse(dashboardText);
  return (dashboard.panels ?? []).flatMap((panel) =>
    (panel.targets ?? []).map((target) => ({
      where: `${panel.title}/${target.refId}`,
      expr: String(target.expr).replace(GRAFANA_RANGE, '5m'),
    })),
  );
}

export function checkMonitoring({ rulesText, dashboardText, sources, defaultBuckets }) {
  const metrics = definedMetrics(sources, defaultBuckets);
  const series = seriesOf(metrics);
  const rules = ruleEntries(rulesText);
  const recorded = new Set(rules.entries.filter((entry) => entry.record).map((entry) => entry.record));
  const problems = [...rules.problems];
  for (const { where, expr } of [...rules.entries, ...dashboardEntries(dashboardText)]) {
    const analysis = analyzeExpr(expr);
    if (analysis.invalid) problems.push(`${where}: PromQL sözdizimi hatalı: ${expr}`);
    for (const name of analysis.series) {
      if (!series.has(name) && !recorded.has(name)) problems.push(`${where}: tanımlı olmayan seri ${name}`);
    }
    for (const { series: name, le } of analysis.buckets) {
      const histogram = metrics.get(series.get(name) ?? '');
      if (histogram?.buckets && !histogram.buckets.includes(le)) {
        problems.push(`${where}: ${series.get(name)} histogramında le="${le}" kovası yok`);
      }
    }
  }
  return problems;
}

function sourceFiles(dir) {
  if (!existsSync(join(ROOT, dir))) return [];
  return readdirSync(join(ROOT, dir), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => join(entry.parentPath, entry.name));
}

/** İstemcinin varsayılan kovaları: sınırı verilmeyen bir histogramın sınırları. */
function clientDefaultBuckets() {
  const require = createRequire(join(ROOT, 'packages/observability/package.json'));
  const { Histogram } = require('@prometheus-io/client');
  return [...new Histogram({ name: 'default_buckets', help: 'varsayılan kovalar', registers: [] }).upperBounds];
}

export function loadRepository() {
  const sources = sourceDirs()
    .flatMap(sourceFiles)
    .map((path) => ({
      file: relative(ROOT, path),
      text: readFileSync(path, 'utf8'),
    }));
  return {
    rulesText: readFileSync(join(ROOT, RULES_FILE), 'utf8'),
    dashboardText: readFileSync(join(ROOT, DASHBOARD_FILE), 'utf8'),
    sources,
    defaultBuckets: clientDefaultBuckets(),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const problems = checkMonitoring(loadRepository());
  for (const problem of problems) console.error(problem);
  if (problems.length > 0) process.exit(1);
  console.log('izleme yapılandırması geçerli');
}
