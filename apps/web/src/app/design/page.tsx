import type { Metadata } from 'next';
import { Catalog } from './catalog';

export const metadata: Metadata = { title: 'Design system' };

export default function DesignPage() {
  return <Catalog />;
}
