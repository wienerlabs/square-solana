import localFont from 'next/font/local';

// OpenRunde (Arc Square'in yazı tipi; OFL-1.1, @fontsource/open-runde). Dosyalar derlemeye dahil edilir
// ve önceden yüklenir; dış bir font sunucusuna istek gitmez.
export const openRunde = localFont({
  src: [
    { path: '../../node_modules/@fontsource/open-runde/files/open-runde-latin-400-normal.woff2', weight: '400' },
    { path: '../../node_modules/@fontsource/open-runde/files/open-runde-latin-500-normal.woff2', weight: '500' },
    { path: '../../node_modules/@fontsource/open-runde/files/open-runde-latin-600-normal.woff2', weight: '600' },
    { path: '../../node_modules/@fontsource/open-runde/files/open-runde-latin-700-normal.woff2', weight: '700' },
  ],
  variable: '--font-open-runde',
  display: 'swap',
});
