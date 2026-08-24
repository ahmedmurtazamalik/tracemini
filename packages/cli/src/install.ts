import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';

export function installStartup(platform = process.platform, executable = process.argv[1]) {
  if (platform !== 'linux') throw new Error('automatic startup currently supports Linux only; Windows is deferred');
  const directory = path.join(os.homedir(), '.config', 'systemd', 'user');
  const service = path.join(directory, 'tracemini.service');
  const escape = (value: string) => value.replace(/([\\"])/g, '\\$1');
  fs.mkdirSync(directory, {recursive: true, mode: 0o700});
  fs.writeFileSync(service, `[Unit]\nDescription=TraceMini local Git device\nAfter=network-online.target\n\n[Service]\nType=simple\nEnvironment=PATH=%h/.local/bin:%h/bin:/usr/local/bin:/usr/bin:/bin\nExecStart="${escape(process.execPath)}" "${escape(executable)}" start\nRestart=on-failure\nRestartSec=5\n\n[Install]\nWantedBy=default.target\n`, {mode: 0o600});
  execFileSync('systemctl', ['--user', 'daemon-reload'], {stdio: 'ignore'});
  execFileSync('systemctl', ['--user', 'enable', '--now', 'tracemini.service'], {stdio: 'ignore'});
  return service;
}
