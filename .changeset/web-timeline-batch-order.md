---
'@squaresdk/solana-web': patch
---

İş sayfasının zaman çizelgesi ve politika geçmişi işlem loglarını imzaya göre eşleştirir: `getTransactions` batch
yanıtı istekle aynı sırada gelmeyince olaylar başka işlemlerin satırına yazılıyordu.
