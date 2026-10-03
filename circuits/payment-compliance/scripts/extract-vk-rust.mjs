#!/usr/bin/env node
// snarkjs doğrulama anahtarını (JSON) groth16-solana'nın `Groth16Verifyingkey` Rust sabitine
// çevirir. Release anahtarı için scripts/release-artifacts.mjs aynı işlevi kullanır; bu CLI
// tek bir anahtarı elle çevirmek içindir.
//
//   node scripts/extract-vk-rust.mjs <vk.json> <VK_CONST_NAME> <NR_INPUTS_CONST_NAME>

import fs from 'node:fs';
import path from 'node:path';
import { renderVerifyingKey } from './groth16-solana.mjs';

const [vkPath, constName, nrInputsConst] = process.argv.slice(2);
if (!vkPath || !constName || !nrInputsConst) {
  process.stderr.write('Usage: node scripts/extract-vk-rust.mjs <vk.json> <VK_CONST_NAME> <NR_INPUTS_CONST_NAME>\n');
  process.exit(2);
}

const vk = JSON.parse(fs.readFileSync(vkPath, 'utf8'));
process.stdout.write(
  renderVerifyingKey(vk, {
    constName,
    nrInputsConst,
    header: [`Generated from ${path.basename(vkPath)} by scripts/extract-vk-rust.mjs — do not edit by hand.`],
  }),
);
