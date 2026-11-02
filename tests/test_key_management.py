import copy
import unittest
from unittest.mock import patch
from fastapi.testclient import TestClient
import server


class KeyManagementTests(unittest.TestCase):
    def test_remove_selected_key_preserves_other_provider_and_records(self):
        with patch.dict(server.api_keys, {'nvidia': 'test-nvidia', 'deepseek': 'test-deepseek'}, clear=True), \
                patch.dict(server.config, copy.deepcopy(server.config), clear=True), \
                patch.object(server, 'current_provider', 'nvidia'), \
                patch.object(server, 'save_config') as save, \
                patch.object(server, 'save_user_data') as records:
            response = TestClient(server.app).delete('/api/auth/keys/nvidia')
            self.assertEqual(response.status_code, 200)
            self.assertNotIn('nvidia', server.api_keys)
            self.assertEqual(server.api_keys['deepseek'], 'test-deepseek')
            self.assertEqual(server.current_provider, 'deepseek')
            self.assertEqual(server.config['api_keys'], {'deepseek': 'test-deepseek'})
            save.assert_called_once()
            records.assert_not_called()

    def test_removing_unknown_provider_is_rejected(self):
        response = TestClient(server.app).delete('/api/auth/keys/unknown')
        self.assertEqual(response.status_code, 400)


if __name__ == '__main__':
    unittest.main()
