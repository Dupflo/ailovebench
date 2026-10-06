import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

/** Yields each parsable JSON line of a file; malformed lines are skipped. */
export async function* readJsonl(file: string): AsyncGenerator<Record<string, any>> {
  const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    try {
      yield JSON.parse(line);
    } catch {
      // Transcripts can end with a partially written line.
    }
  }
}

export const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
