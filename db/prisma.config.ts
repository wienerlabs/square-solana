// Prisma CLI yapılandırması (Prisma 7). Bağlantı adresi yalnızca ortamdan gelir; `prisma generate`
// veritabanı gerektirmez, migration komutları DATABASE_URL tanımlı değilse hata verir.
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'node dist/seed.js',
  },
  datasource: {
    url: process.env.DATABASE_URL,
  },
});
