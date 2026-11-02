# Contributing

Issues and focused pull requests are welcome. Include app version, Windows version, reproduction steps and expected behavior. Redact API keys and private conversations.

Use Python 3.12 x64, a project-local `.venv`, and `requirements-dev.lock`. Run `python scripts/run_tests.py`. Optional frontend tests require Node.js 24: install with `npm ci --prefix tests/frontend`, start `python tests/preview_ui.py`, and run `node tests/run_frontend.cjs`.

Build with `build_exe.bat`. Keep generated binaries, local configuration, logs and chat data out of commits. The preview harness uses synthetic data.
