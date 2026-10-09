import type { Metadata } from 'next';
import { DocsPage } from '@/components/docs/docs-page';

export const metadata: Metadata = {
  title: 'Docs',
  description: 'How Square works, how to use the app in every role, and how to build on it.',
};

export default function Docs() {
  return <DocsPage />;
}
