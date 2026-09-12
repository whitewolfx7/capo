import { createWriteStream } from 'node:fs';
import { join } from 'node:path';

/** Appends every line the `Orchestrator` logs to `<runDir>/run.log`. */
export function makeFileLogger(dir: string): (line: string) => void {
  const stream = createWriteStream(join(dir, 'run.log'), { flags: 'a' });
  return (line: string): void => {
    stream.write(`${line}\n`);
  };
}
