# Changesets

Paket sürümleri [changesets](https://github.com/changesets/changesets) ile yönetilir (BE-01, [ADR 0001](../docs/decisions/0001-ts-paket-adlandirma-ve-surumleme.md)).

- Yayımlanan bir paketi değiştiren her PR, `pnpm changeset` ile bir changeset dosyası ekler.
- `pnpm version-packages` sürümleri ve CHANGELOG'ları günceller.
- npm'e yayın, `@squaresdk` npm org'u ve CI'daki `NPM_TOKEN` hazır olunca `changeset publish` ile yapılır.
