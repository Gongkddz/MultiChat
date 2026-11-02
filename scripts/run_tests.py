"""Run backend tests with an ephemeral data directory."""
import os
from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
with tempfile.TemporaryDirectory(prefix='multichat-tests-') as data:
    os.environ['MULTICHAT_DATA_DIR'] = data
    tests = unittest.defaultTestLoader.discover(str(ROOT/'tests'), pattern='test_*.py')
    result = unittest.TextTestRunner(verbosity=2).run(tests)
sys.exit(not result.wasSuccessful())
