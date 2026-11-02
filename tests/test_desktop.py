import sys
import unittest
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import server


class DesktopTests(unittest.TestCase):
    def test_webview_has_persistent_non_private_edge_profile(self):
        webview = MagicMock()
        runtime = MagicMock()
        runtime.host = '127.0.0.1'
        runtime.port = 8765
        with patch.dict(sys.modules, {'webview': webview}), \
                patch.object(server, 'DesktopRuntime', return_value=runtime), \
                patch.object(server, 'save_config'), \
                patch.object(server.atexit, 'register'), \
                patch('desktop_identity.configure_taskbar_identity') as identity:
            self.assertEqual(server.run_desktop(), 0)
        identity.assert_called_once()
        options = webview.start.call_args.kwargs
        self.assertFalse(options['private_mode'])
        self.assertEqual(options['gui'], 'edgechromium')
        self.assertEqual(options['storage_path'], str(server.DATA_DIR / 'webview_profile'))
        self.assertEqual(options['icon'], str(server.resource_path('static/brand/app.ico')))


if __name__ == '__main__':
    unittest.main()
