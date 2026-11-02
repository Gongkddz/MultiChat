import unittest
from fastapi.testclient import TestClient
import server


class LocalSurfaceTests(unittest.TestCase):
    def test_foreign_origin_cannot_change_settings(self):
        response = TestClient(server.app).post('/api/config', json={'temperature': 1},
            headers={'Origin': 'https://untrusted.example'})
        self.assertEqual(response.status_code, 403)

    def test_dns_rebinding_host_is_rejected(self):
        response = TestClient(server.app).get('/api/status', headers={'Host': 'untrusted.example:8765'})
        self.assertEqual(response.status_code, 403)

    def test_same_origin_is_accepted(self):
        response = TestClient(server.app).get('/api/status', headers={'Origin': 'http://testserver'})
        self.assertEqual(response.status_code, 200)

    def test_sync_endpoints_are_not_exposed(self):
        paths = {route.path for route in server.app.routes}
        self.assertNotIn('/api/lan-sync', paths)
        self.assertNotIn('/api/lan-sync/v2', paths)

    def test_config_exposes_only_public_settings(self):
        from unittest.mock import patch
        with patch.dict(server.config, {'api_keys': {'nvidia': 'fake-secret'}, 'lan_sync_token': 'fake-pairing'}):
            data = TestClient(server.app).get('/api/status').json()['config']
        self.assertNotIn('api_keys', data)
        self.assertNotIn('lan_sync_token', data)
