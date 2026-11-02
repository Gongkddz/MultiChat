"""Export a persistent icon and refresh existing shortcuts for this exact EXE."""
import ctypes
import os
from pathlib import Path
import shutil
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from desktop_identity import APP_USER_MODEL_ID


def refresh(dist: Path):
    dist = dist.resolve()
    exe = dist / 'NVIDIAChat.exe'
    if not exe.is_file():
        raise FileNotFoundError(exe)
    icon = dist / 'NVIDIAChat.ico'
    shutil.copy2(ROOT / 'static/brand/app.ico', icon)
    import pythoncom
    from win32com.propsys import propsys, pscon
    from win32com.shell import shell, shellcon
    pythoncom.CoInitialize()
    folders = [
        Path(shell.SHGetFolderPath(0, shellcon.CSIDL_DESKTOPDIRECTORY, None, 0)),
        Path(shell.SHGetFolderPath(0, shellcon.CSIDL_PROGRAMS, None, 0)),
        Path(os.environ['APPDATA']) / 'Microsoft/Internet Explorer/Quick Launch/User Pinned/TaskBar',
    ]
    notify = ctypes.windll.shell32.SHChangeNotify
    notify.argtypes = [ctypes.c_long, ctypes.c_uint, ctypes.c_wchar_p, ctypes.c_void_p]
    updated = []
    try:
        for folder in folders:
            if not folder.is_dir():
                continue
            for path in folder.rglob('*.lnk'):
                link = pythoncom.CoCreateInstance(shell.CLSID_ShellLink, None,
                    pythoncom.CLSCTX_INPROC_SERVER, shell.IID_IShellLink)
                persist = link.QueryInterface(pythoncom.IID_IPersistFile)
                persist.Load(str(path))
                target, _ = link.GetPath(shell.SLGP_RAWPATH)
                if not target or Path(target).resolve() != exe:
                    continue
                persist.Load(str(path), 2)  # STGM_READWRITE, only for our shortcut
                backup = path.with_suffix('.lnk.before-brand-fix')
                if not backup.exists():
                    shutil.copy2(path, backup)
                link.SetIconLocation(str(icon), 0)
                properties = link.QueryInterface(propsys.IID_IPropertyStore)
                properties.SetValue(pscon.PKEY_AppUserModel_ID, propsys.PROPVARIANTType(APP_USER_MODEL_ID))
                properties.Commit()
                persist.Save(str(path), 1)
                notify(0x2000, 0x0005, str(path), None)  # UPDATEITEM, PATHW
                updated.append(str(path))
        notify(0x2000, 0x0005, str(exe), None)
        print('Persistent icon:', icon)
        print('Updated shortcuts:', *updated, sep='\n')
    finally:
        pythoncom.CoUninitialize()


if __name__ == '__main__':
    refresh(Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / 'dist')
