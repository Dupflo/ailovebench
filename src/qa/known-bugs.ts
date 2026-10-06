import type { KnownBug } from '../catalog/load.js';
import type { ChecksRun } from '../checks/run.js';

/** present: at least one proof fails · absent: every proof passes · unknown: no proof was run. */
export type Presence = 'present' | 'absent' | 'unknown';

export interface KnownBugStatus extends KnownBug {
  /** On the untouched starter: was the planted bug detected? */
  atStart: Presence;
  /** On the agent's final version. */
  atEnd: Presence;
  /** Failing proofs on the starter, as the checks reported them. */
  proofs: string[];
}

/** A test-check proof (`hidden_tests:<name>`) fails when its test is listed as failing in the detail. */
function proofFails(proof: string, qa: ChecksRun): boolean | null {
  const [checkId, test] = proof.split(/:(.*)/s) as [string, string | undefined];
  const r = qa.results.find((x) => x.id === checkId);
  if (!r || r.status === 'skip') return null;
  if (!test) return r.status !== 'pass';
  if (r.status === 'pass') return false;
  const lines = (r.detail ?? '').split('\n');
  // The detail lists failing tests as `- <name>` or `- <name> : <expected / observed>`.
  return lines.some((l) => l === `- ${test}` || l.startsWith(`- ${test} : `));
}

function presence(bug: KnownBug, qa: ChecksRun | undefined): { state: Presence; failing: string[] } {
  if (!qa) return { state: 'unknown', failing: [] };
  const results = bug.evidence.map((p) => ({ p, fails: proofFails(p, qa) }));
  const failing = results.filter((r) => r.fails).map((r) => r.p);
  if (failing.length) return { state: 'present', failing };
  return { state: results.some((r) => r.fails === false) ? 'absent' : 'unknown', failing };
}

/** Where each planted bug stands: detected on the starter, then fixed or not in the final version. */
export function knownBugStatus(bugs: KnownBug[], baseline: ChecksRun | undefined, final: ChecksRun | undefined): KnownBugStatus[] {
  return bugs.map((b) => {
    const start = presence(b, baseline);
    return { ...b, atStart: start.state, atEnd: presence(b, final).state, proofs: start.failing };
  });
}
