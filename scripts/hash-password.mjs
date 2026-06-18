#!/usr/bin/env node
/**
 * Hash a password for Games Vault credentials provider.
 *
 * Usage:
 *   node scripts/hash-password.mjs           # prompt (secure)
 *   echo "mypass" | node scripts/hash-password.mjs --stdin
 *
 * Output: a bcrypt hash suitable for LAN_PASS_HASH env var.
 */

import { createInterface } from "node:readline";
import { createRequire } from "node:module";

// bcryptjs lives in gv-web's node_modules (pnpm workspace)
const require = createRequire(import.meta.url);
const bcrypt = require("../gv-web/node_modules/bcryptjs/index.js");

const SALT_ROUNDS = 12;

async function readPassword() {
  if (process.argv.includes("--stdin")) {
    const chunks = [];
    for await (const chunk of process.stdin) {
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString().trim();
  }

  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const ask = (q) => new Promise((resolve) => rl.question(q, resolve));

  const pass = await ask("Password: ");
  rl.close();
  return pass;
}

const password = await readPassword();
if (!password) {
  console.error("Error: password must not be empty.");
  process.exit(1);
}
if (password.length < 4) {
  console.error("Warning: password is very short (<4 chars).");
}

const hash = bcrypt.hashSync(password, SALT_ROUNDS);
console.log(hash);
