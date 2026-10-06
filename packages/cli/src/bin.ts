#!/usr/bin/env node
// `squaresdk-solana` süreç giriş noktası.
import { runCli } from './cli.js';

process.exitCode = await runCli(process.argv.slice(2));
// web3.js bağlantısının websocket'i süreci açık tutabilir.
process.exit();
