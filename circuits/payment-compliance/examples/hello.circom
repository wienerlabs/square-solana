pragma circom 2.0.0;

// Minimal sanity-check circuit used to validate the Circom toolchain and the
// snarkjs Groth16 pipeline. It proves knowledge of two field elements (a, b)
// whose sum equals a publicly known value (sum).
//
// This circuit has no business meaning. It exists solely so the repo can
// exercise compile -> setup -> prove -> verify end-to-end before the real
// payment-prover circuit lands.
template HelloSum() {
    signal input a;
    signal input b;
    signal input sum;

    sum === a + b;
}

component main {public [sum]} = HelloSum();
