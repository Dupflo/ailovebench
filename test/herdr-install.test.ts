import { describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { addToPath, herdrInstallDir } from '../src/detect/herdr-install.js';

describe('herdr install', () => {
  it('looks where the official installer puts herdr', () => {
    expect(herdrInstallDir({})).toBe(path.join(os.homedir(), '.local', 'bin'));
    expect(herdrInstallDir({ HERDR_INSTALL_DIR: '/opt/herdr' })).toBe('/opt/herdr');
  });

  it('adds the install folder to PATH once, in front', () => {
    const env: NodeJS.ProcessEnv = { PATH: ['/usr/bin', '/bin'].join(path.delimiter) };
    expect(addToPath('/home/me/.local/bin', env)).toBe(true);
    expect(env.PATH).toBe(['/home/me/.local/bin', '/usr/bin', '/bin'].join(path.delimiter));
    expect(addToPath('/home/me/.local/bin', env)).toBe(false);
    expect(env.PATH?.split(path.delimiter)).toHaveLength(3);
  });
});
