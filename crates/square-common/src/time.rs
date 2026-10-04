//! UTC gün sınırı: günlük harcama sayacı (`OperatorState`) gün değişince sıfırlanır.

use crate::constants::SECONDS_PER_DAY;

/// `unix_timestamp`'ın içinde olduğu UTC gününün başlangıcı (unix saniyesi). Sıfır ve negatif
/// değerler 0'a sabitlenir.
pub const fn day_start(unix_timestamp: i64) -> i64 {
    if unix_timestamp <= 0 {
        return 0;
    }
    unix_timestamp - unix_timestamp % SECONDS_PER_DAY
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn day_start_utc() {
        assert_eq!(day_start(1_790_000_000), 1_789_948_800);
        assert_eq!(day_start(1_789_948_800), 1_789_948_800);
        assert_eq!(day_start(1_789_948_799), 1_789_948_800 - SECONDS_PER_DAY);
        assert_eq!(day_start(0), 0);
        assert_eq!(day_start(-5), 0);
    }
}
