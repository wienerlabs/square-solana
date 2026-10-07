---
'@squaresdk/solana-fee-payer': patch
---

Bağımsız incelemenin fee payer bulguları. Gönderimi hata veren tx bütçede kalır; zincire girebilir. Sponsorun ödediği
ve tx'te çalışan her ATA açılışının rent'i simülasyonun rent'ine eklenir; öneri tx'indeki vault mesajının ATA'sı
yürütmede sayılır. Simülasyon bakiye okumasının slotundan eski bir bankada yapılmaz (`minContextSlot` ve yanıtın
slotu). Açılan multisig'in üyeleri ve `config_authority`'si sponsor olamaz. Maliyet metrikleri gönderimden önce yazılır;
503 günlüğü tx'in imzasını taşır.
