"""Package only the Windows executable and redistributable documentation."""
import argparse
import hashlib
from pathlib import Path
import re
import shutil
import tempfile
from zipfile import ZipFile, ZIP_DEFLATED

ROOT = Path(__file__).resolve().parents[1]


def package(version):
    if not re.fullmatch(r'\d+\.\d+\.\d+', version):
        raise ValueError('Use a semantic version such as 1.0.0')
    exe = ROOT / 'dist/NVIDIAChat.exe'
    if not exe.is_file():
        raise FileNotFoundError('Build dist/NVIDIAChat.exe first')
    output = ROOT / 'release'
    output.mkdir(exist_ok=True)
    name = f'MultiChat-v{version}-windows-x64'
    archive = output / f'{name}.zip'
    with tempfile.TemporaryDirectory(prefix='multichat-package-') as temp:
        folder = Path(temp) / name
        folder.mkdir()
        shutil.copy2(exe, folder / exe.name)
        shutil.copy2(ROOT/'static/brand/app.ico', folder/'NVIDIAChat.ico')
        for filename in ['LICENSE', 'README.md', 'THIRD_PARTY_NOTICES.md', 'SECURITY.md', 'CHANGELOG.md']:
            shutil.copy2(ROOT/filename, folder/filename)
        shutil.copytree(ROOT/'third_party', folder/'third_party')
        shutil.copytree(ROOT/'docs', folder/'docs')
        brand = folder/'static/brand'
        brand.mkdir(parents=True)
        shutil.copy2(ROOT/'static/brand/logo.svg', brand/'logo.svg')
        (folder/'START_HERE.txt').write_text(
            'MultiChat for Windows x64\n\nExtract the entire ZIP, then run NVIDIAChat.exe.\n'
            'Requires Windows 10/11 x64, .NET Framework 4.8 and Microsoft Edge WebView2 Runtime.\n'
            'A provider API key and network connection are required for model requests.\n'
            'Data: %LOCALAPPDATA%/NVIDIAChat/ (keys are stored locally in plaintext).\n'
            'This build is unsigned. Check SHA256SUMS.txt before running.\n'
            'Source and updates: https://github.com/Gongkddz/MultiChat\n', encoding='utf-8')
        with ZipFile(archive, 'w', compression=ZIP_DEFLATED, compresslevel=9) as z:
            for item in sorted(folder.rglob('*')):
                if item.is_file():
                    z.write(item, item.relative_to(folder.parent))
    checksum = hashlib.sha256(archive.read_bytes()).hexdigest()
    (output/'SHA256SUMS.txt').write_text(f'{checksum}  {archive.name}\n', encoding='ascii')
    print(archive)
    print(checksum)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--version', required=True)
    package(parser.parse_args().version)
