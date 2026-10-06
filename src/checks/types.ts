import { tr } from '../i18n.js';

export type CheckStatus = 'pass' | 'fail' | 'skip' | 'error';

/** One automatic check on the delivered product. Same shape for every task and agent. */
export interface CheckResult {
  id: string;
  /**
   * Canonical label and detail, in the benchmark's language (French, like the task prompts): a failed
   * check becomes a bug sent back to the agent, so this text must be the same on every machine.
   */
  label: string;
  /** English label, for display only (see `checkLabel`). */
  labelEn?: string;
  /** English detail, for display only (see `checkDetail`). */
  detailEn?: string;
  status: CheckStatus;
  /** Measured value when there is one (score, fps, % of tests…). */
  value?: number;
  detail?: string;
  /** Files produced as evidence (screenshots, reports), relative to the job folder. */
  artifacts?: string[];
}

/** What people read: the label in the computer's language (the canonical one when not translated). */
export const checkLabel = (r: Pick<CheckResult, 'label' | 'labelEn'>): string => tr(r.label, r.labelEn ?? r.label);

/** Same for the detail. */
export const checkDetail = (r: Pick<CheckResult, 'detail' | 'detailEn'>): string | undefined =>
  r.detail === undefined ? undefined : tr(r.detail, r.detailEn ?? r.detail);

/** How the product is built and served, declared by the task and identical for every agent. */
export interface Deliverable {
  install: string;
  build: string;
  static_dir: string;
  entry: string;
}
