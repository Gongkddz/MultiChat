"""Stable Windows taskbar identity shared by the app and its shortcuts."""
import sys

APP_USER_MODEL_ID = 'Optimistrans.MultiChat.Desktop'


def configure_taskbar_identity():
    if sys.platform == 'win32':
        import ctypes
        set_id = ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID
        set_id.argtypes = [ctypes.c_wchar_p]
        set_id.restype = ctypes.c_long
        result = set_id(APP_USER_MODEL_ID)
        if result != 0:
            raise OSError(f'Windows AppUserModelID setup failed: {result}')
