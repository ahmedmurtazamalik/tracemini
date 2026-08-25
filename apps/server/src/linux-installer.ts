import fs from 'node:fs';
import path from 'node:path';

export const shellQuote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;

export function linuxInstallCommand(origin: string, installToken: string) {
  const url = `${origin.replace(/\/$/, '')}/api/installers/linux/${encodeURIComponent(installToken)}`;
  return `mkdir -p "$HOME/.cache/tracemini" && curl --fail --show-error --location ${shellQuote(url)} --output "$HOME/.cache/tracemini/install.sh" && sh "$HOME/.cache/tracemini/install.sh"`;
}

export function linuxSyncCommand(origin: string, installToken: string) {
  return linuxInstallCommand(origin, installToken);
}

export function linuxInstaller(cliDir: string, serverUrl: string, installToken: string) {
  const files = fs.readdirSync(cliDir).filter(name => name.endsWith('.js')).sort();
  if (!files.includes('index.js')) throw new Error(`built TraceMini CLI not found in ${cliDir}`);
  const payload = files.map(name => {
    const encoded = fs.readFileSync(path.join(cliDir, name)).toString('base64');
    return `printf '%s' ${shellQuote(encoded)} | base64 -d > "$CLI_DIR/${name}"`;
  }).join('\n');
  return `#!/bin/sh
set -eu

if [ "$(uname -s)" != Linux ]; then
  echo 'TraceMini installation currently supports Linux only; Windows is deferred.' >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  echo 'Node.js 22 or newer is required.' >&2
  exit 1
fi
NODE_MAJOR=$(node -p 'Number(process.versions.node.split(".")[0])')
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo 'Node.js 22 or newer is required.' >&2
  exit 1
fi
if ! command -v systemctl >/dev/null 2>&1; then
  echo 'systemctl is required for the TraceMini systemd user service.' >&2
  exit 1
fi

CLI_DIR="$HOME/.local/share/tracemini/cli"
BIN_DIR="$HOME/.local/bin"
mkdir -p "$CLI_DIR" "$BIN_DIR"
chmod 700 "$HOME/.local/share/tracemini" "$CLI_DIR"
${payload}
cat > "$BIN_DIR/tracemini" <<'TRACEMINI_WRAPPER'
#!/bin/sh
exec node "$HOME/.local/share/tracemini/cli/index.js" "$@"
TRACEMINI_WRAPPER
chmod 755 "$BIN_DIR/tracemini"
"$BIN_DIR/tracemini" install --server ${shellQuote(serverUrl)} --install-token ${shellQuote(installToken)}

case ":$PATH:" in
  *:"$BIN_DIR":*) ;;
  *) echo "TraceMini installed. Add $BIN_DIR to PATH, then open a new shell:"; echo '  export PATH="$HOME/.local/bin:$PATH"' ;;
esac
`;
}
