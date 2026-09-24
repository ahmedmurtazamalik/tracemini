#!/usr/bin/env python3
"""Create a portable TraceMini Codex marketplace ZIP from tracked source."""
from pathlib import Path
from zipfile import ZipFile, ZipInfo, ZIP_DEFLATED
import argparse
import json

ROOT = Path(__file__).resolve().parents[1]
MARKETPLACE = ROOT / '.agents/plugins/marketplace.json'
PLUGIN = ROOT / 'plugins/tracemini'
FILES = [MARKETPLACE, *sorted(path for path in PLUGIN.rglob('*') if path.is_file())]


def package(output: Path) -> None:
    manifest = json.loads(MARKETPLACE.read_text())
    assert manifest['name'] == 'tracemini'
    assert manifest['plugins'][0]['source']['path'] == './plugins/tracemini'
    assert (PLUGIN / '.codex-plugin/plugin.json') in FILES
    assert (PLUGIN / '.mcp.json') in FILES
    output.parent.mkdir(parents=True, exist_ok=True)
    with ZipFile(output, 'w', compression=ZIP_DEFLATED) as archive:
        for file in FILES:
            relative = file.relative_to(ROOT).as_posix()
            info = ZipInfo(relative, date_time=(2026, 1, 1, 0, 0, 0))
            info.compress_type = ZIP_DEFLATED
            info.external_attr = (0o755 if file.suffix == '.mjs' else 0o644) << 16
            archive.writestr(info, file.read_bytes())
        info = ZipInfo('README-INSTALL.txt', date_time=(2026, 1, 1, 0, 0, 0))
        info.compress_type = ZIP_DEFLATED
        info.external_attr = 0o644 << 16
        archive.writestr(info, '''TraceMini for Codex\n\n1. In a terminal, run these commands with the absolute path to this extracted folder:\n\n   codex plugin marketplace add /absolute/path/to/extracted-folder\n   codex plugin add tracemini@tracemini\n\n2. Sign in with your own TraceMini account:\n\n   node /absolute/path/to/extracted-folder/plugins/tracemini/scripts/login.mjs\n\n3. Start a new Codex task and ask about your TraceMini activity.\n\nThis package uses a local login command. It does not offer the Settings > MCP servers > Authenticate button used by hosted OAuth plugins.\n''')
    print(output)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('output', type=Path)
    package(parser.parse_args().output)
