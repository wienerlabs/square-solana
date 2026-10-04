//! Rol sözlüğü (program arayüzü §2).

/// Akıştaki roller. `Institution` escrow'da kurumun imzacı cüzdanı, policy ve verifier'da
/// square_policy'nin `Institution` PDA'sıdır.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Role {
    /// Politikayı koyan, işi açıp fonlayan kurum.
    Institution,
    /// İşi kabul edip teslim eden agent (`Job.agent_wallet`).
    Agent,
    /// Alacağı satın alan, kurumun onaylı alıcı listesindeki adres.
    Buyer,
    /// Uyuşmazlıkta oy veren hakem (`EscrowConfig.arbitrators`).
    Arbitrator,
    /// Ödemeyi sonuçlandıran izinsiz çağıran; keeper ücreti alır.
    Keeper,
}

impl Role {
    /// Sözleşmedeki adı.
    pub const fn as_str(self) -> &'static str {
        match self {
            Role::Institution => "institution",
            Role::Agent => "agent",
            Role::Buyer => "buyer",
            Role::Arbitrator => "arbitrator",
            Role::Keeper => "keeper",
        }
    }
}
