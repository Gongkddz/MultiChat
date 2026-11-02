# Third-party notices

Original application code and Logo are MIT licensed. Third-party components retain their own terms. No model weights, provider credentials or provider-owned logos are distributed.

## Vendored frontend assets

| Component | Version | License | Upstream |
| --- | --- | --- | --- |
| Marked | 15.0.12 | MIT | https://github.com/markedjs/marked |
| highlight.js | 11.9.0 | BSD-3-Clause | https://github.com/highlightjs/highlight.js |
| DOMPurify | 3.4.17 | Apache-2.0 OR MPL-2.0; distributed under Apache-2.0 option | https://github.com/cure53/DOMPurify |

License texts are in `third_party/`. Minified upstream files are unmodified.

## Windows runtime and packaging

- CPython 3.12.14: Python Software Foundation and included third-party notices in `third_party/Python-LICENSE.txt`. Source: https://www.python.org/downloads/source/
- Microsoft WebView2 SDK 1.0.3856.49 redistributable DLLs: Microsoft SDK license, not MIT. Original LICENSE and NOTICE are included. https://www.nuget.org/packages/Microsoft.Web.WebView2/1.0.3856.49
- The Evergreen WebView2 browser runtime and .NET Framework are system prerequisites and are not shipped in this ZIP.
- PyInstaller uses GPL-2.0-or-later WITH Bootloader-exception and Apache-2.0 for selected runtime hooks. No modifications to PyInstaller are distributed. https://pyinstaller.org/en/stable/license.html
- certifi includes the Mozilla CA bundle under MPL-2.0. It is unmodified. The corresponding covered source is included in `third_party/certifi-source/`; the full MPL-2.0 text is included in `third_party/MPL-2.0.txt`. Upstream source: https://github.com/certifi/python-certifi/tree/2026.10.23

## Python dependency / build environment inventory

This inventory includes runtime and build-time dependencies from the locked Windows build environment. License files copied from the installed distributions are under `third_party/python/`. Build-only tools are not all embedded in the executable. Dependency authors retain their copyrights. Some bundled Python DLLs include additional notices in Python's license text.

| Package | Version | License metadata | Upstream |
| --- | --- | --- | --- |
| altgraph | 0.17.5 | MIT | https://altgraph.readthedocs.io |
| annotated-doc | 0.0.5 | MIT | https://github.com/fastapi/annotated-doc |
| annotated-types | 0.8.0 | MIT | https://github.com/annotated-types/annotated-types |
| anyio | 4.16.0 | MIT | https://anyio.readthedocs.io/en/latest/ |
| bottle | 0.13.4 | MIT | http://bottlepy.org/ |
| certifi | 2026.10.23 | MPL-2.0 | https://github.com/certifi/python-certifi |
| cffi | 2.1.1 | MIT-0 | https://cffi.readthedocs.io/ |
| click | 8.5.0 | BSD-3-Clause | https://click.palletsprojects.com/page/changes/ |
| clr_loader | 0.3.1 | See license files / upstream | https://github.com/pythonnet/clr-loader |
| colorama | 0.4.6 | See license files / upstream | https://github.com/tartley/colorama |
| distro | 1.9.0 | Apache License, Version 2.0 | https://github.com/python-distro/distro |
| fastapi | 0.139.0 | MIT | https://github.com/fastapi/fastapi |
| h11 | 0.16.0 | MIT | https://github.com/python-hyper/h11 |
| httpcore | 1.0.9 | BSD-3-Clause | https://www.encode.io/httpcore |
| httptools | 0.9.0 | MIT | https://github.com/MagicStack/httptools |
| httpx | 0.28.1 | BSD-3-Clause | https://github.com/encode/httpx/blob/master/CHANGELOG.md |
| idna | 3.20 | BSD-3-Clause | https://github.com/kjd/idna/blob/master/HISTORY.md |
| jiter | 0.18.0 | MIT | https://github.com/pydantic/jiter/ |
| openai | 2.44.0 | Apache-2.0 | https://github.com/openai/openai-python |
| packaging | 26.3 | Apache-2.0 OR BSD-2-Clause | https://packaging.pypa.io/ |
| pefile | 2024.8.26 | MIT | https://github.com/erocarrera/pefile |
| pillow | 12.3.0 | MIT-CMU | https://pillow.readthedocs.io/en/stable/releasenotes/index.html |
| proxy_tools | 0.1.0 | MIT | http://github.com/jtushman/proxy_tools |
| pycparser | 3.12 | BSD-3-Clause | https://github.com/eliben/pycparser |
| pydantic | 2.14.2 | MIT | https://github.com/pydantic/pydantic |
| pydantic_core | 2.50.2 | MIT | https://github.com/pydantic/pydantic |
| pyinstaller | 6.22.2 | GPLv2-or-later with a special exception which allows to use PyInstaller to build and distr | https://pyinstaller.org |
| pyinstaller-hooks-contrib | 2026.9 | See license files / upstream | https://github.com/pyinstaller/pyinstaller-hooks-contrib |
| python-dotenv | 1.2.4 | BSD-3-Clause | https://github.com/theskumar/python-dotenv |
| python-multipart | 0.0.32 | Apache-2.0 | https://github.com/Kludex/python-multipart |
| pythonnet | 3.2.1 | MIT | https://pythonnet.github.io/ |
| pywebview | 6.2.1 | BSD 3-Clause License | https://pywebview.flowrl.com/ |
| pywin32 | 311 | PSF | https://github.com/mhammond/pywin32 |
| pywin32-ctypes | 0.2.3 | BSD-3-Clause | https://github.com/enthought/pywin32-ctypes |
| PyYAML | 6.0.3 | MIT | https://pyyaml.org/ |
| setuptools | 84.2.1 | MIT | https://github.com/pypa/setuptools |
| sniffio | 1.3.1 | MIT OR Apache-2.0 | https://github.com/python-trio/sniffio |
| starlette | 1.10.0 | BSD-3-Clause | https://github.com/Kludex/starlette |
| tqdm | 4.70.1 | MPL-2.0 AND MIT | https://tqdm.github.io |
| typing-inspection | 0.4.4 | MIT | https://github.com/pydantic/typing-inspection |
| typing_extensions | 4.16.0 | PSF-2.0 | https://github.com/python/typing_extensions/issues |
| uvicorn | 0.51.0 | BSD-3-Clause | https://uvicorn.dev/release-notes |
| watchfiles | 1.3.0 | MIT | https://github.com/samuelcolvin/watchfiles |
| websockets | 17.4 | BSD-3-Clause | https://github.com/python-websockets/websockets |
