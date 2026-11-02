import tempfile
import unittest
from pathlib import Path

from record_store import RecordStore, WORKSPACES, CONVERSATIONS, SYNC_META


class RecordStoreTests(unittest.TestCase):
    def test_snapshot_is_split_and_unchanged_records_are_not_rewritten(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            legacy = root / "legacy.json"
            legacy.write_text("{}", encoding="utf-8")
            store = RecordStore(root / "records", legacy)
            data = {
                WORKSPACES: [{"id": "w1", "createdAt": 1, "updatedAt": 1}],
                CONVERSATIONS: [{"id": "c1", "workspaceId": "w1", "updatedAt": 2}],
                SYNC_META: {"tombstones": {}},
            }
            changed = store.save_snapshot(data)
            self.assertEqual(changed[CONVERSATIONS], ["c1"])
            index = root / "records" / "manifest.json"
            self.assertTrue(index.exists())
            self.assertIn("c1", store.manifest()[CONVERSATIONS])
            path = root / "records" / "conversations" / "c1.json"
            modified = path.stat().st_mtime_ns
            self.assertEqual(store.save_snapshot(data)[CONVERSATIONS], [])
            self.assertEqual(path.stat().st_mtime_ns, modified)

    def test_manifest_hash_changes_only_for_modified_record(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp); legacy = root / "legacy.json"; legacy.write_text("{}")
            store = RecordStore(root / "records", legacy)
            store.save_snapshot({CONVERSATIONS: [
                {"id": "c1", "updatedAt": 1, "title": "one"},
                {"id": "c2", "updatedAt": 1, "title": "two"},
            ]})
            before = store.manifest()[CONVERSATIONS]
            store.save_snapshot({CONVERSATIONS: [{"id": "c1", "updatedAt": 2, "title": "changed"}]})
            after = store.manifest()[CONVERSATIONS]
            self.assertNotEqual(before["c1"]["hash"], after["c1"]["hash"])
            self.assertEqual(before["c2"]["hash"], after["c2"]["hash"])


if __name__ == "__main__":
    unittest.main()
