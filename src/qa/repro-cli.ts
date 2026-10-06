#!/usr/bin/env node
/**
 * Given to the tester agent so it can check its own reproduction scripts:
 *   node repro-cli.js bugs/B1.mjs            (URL from BM_URL)
 * Exit code 1 = the bug is present (the script fails), 0 = no bug.
 */
import path from 'node:path';
import { withBrowser } from '../checks/browser.js';
import { runBugScript } from './repro.js';

const file = process.argv[2];
const url = process.argv[3] ?? process.env.BM_URL;
if (!file || !url) {
  process.stderr.write('Usage : node repro-cli.js <script.mjs> [url]  (ou BM_URL)\n');
  process.exit(2);
}
const r = await withBrowser((b) => runBugScript(b, path.resolve(file), url));
if (r.present === true) {
  console.log(`BUG PRÉSENT — l'assertion échoue : ${r.error}`);
  process.exit(1);
}
if (r.present === null) {
  console.log(`SCRIPT CASSÉ — il plante avant de vérifier quoi que ce soit, ce n'est pas une preuve : ${r.error}`);
  process.exit(3);
}
console.log('PAS DE BUG — le script passe (le comportement attendu est respecté)');
