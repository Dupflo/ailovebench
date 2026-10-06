import { describe, expect, it } from 'vitest';
import { knownBugStatus } from '../src/qa/known-bugs.js';
import type { ChecksRun } from '../src/checks/run.js';

const run = (results: ChecksRun['results']): ChecksRun => ({ round: 0, startedAt: '', endedAt: '', results, passed: 0, failed: 0 });
const bugs = [
  { id: 'remove', title: 'Retirer supprime deux lignes', evidence: ['scenario.remove_one'] },
  { id: 'format', title: 'Prix au format anglais', evidence: ['hidden_tests:formatPrice : zéro'] },
  { id: 'case', title: 'Codes sensibles à la casse', evidence: ['hidden_tests:codes insensibles à la casse'] },
];

describe('known bugs', () => {
  it('detects planted bugs on the starter and checks them on the final version', () => {
    const starter = run([
      { id: 'scenario.remove_one', label: 'Retirer', status: 'fail' },
      { id: 'hidden_tests', label: 'Spec', status: 'fail', detail: "3/17 conformes\n- formatPrice : zéro : attendu '0,00 €', obtenu '0.00 €'" },
    ]);
    const final = run([
      { id: 'scenario.remove_one', label: 'Retirer', status: 'pass' },
      { id: 'hidden_tests', label: 'Spec', status: 'fail', detail: "16/17 conformes\n- formatPrice : zéro : attendu '0,00 €', obtenu '0.00 €'" },
    ]);
    const s = knownBugStatus(bugs, starter, final);
    expect(s.map((b) => [b.id, b.atStart, b.atEnd])).toEqual([
      ['remove', 'present', 'absent'],
      ['format', 'present', 'present'],
      // Its test is not in the failing list: the planted bug did not reproduce.
      ['case', 'absent', 'absent'],
    ]);
    expect(s[0]!.proofs).toEqual(['scenario.remove_one']);
  });

  it('says unknown when no proof was run', () => {
    expect(knownBugStatus(bugs, undefined, undefined).every((b) => b.atStart === 'unknown' && b.atEnd === 'unknown')).toBe(true);
  });
});
