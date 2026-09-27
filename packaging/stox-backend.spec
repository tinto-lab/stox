# -*- mode: python ; coding: utf-8 -*-
#
# PyInstaller build spec for stox_bridge.py -- bundles the Python backend
# (stoxlib) into a standalone onedir app, so the macOS app (macapp/) needs
# neither a system Python nor this repo's .venv at runtime. Built and
# copied into macapp/backend/stox-backend by scripts/build_backend.sh.
#
# providers.build_llm() resolves its LangChain provider package via
# importlib.import_module(a_string_built_from_env_vars) -- invisible to
# PyInstaller's static import analysis, so each provider package (and the
# anthropic/openai SDKs' own importlib.metadata version lookups, via
# copy_metadata) has to be pulled in explicitly here rather than being
# auto-detected. Verified by actually running the frozen binary against
# each of the three providers -- see the Phase 3 notes in the PR/commit
# this file was added in.

import os

from PyInstaller.utils.hooks import collect_all, copy_metadata

REPO_ROOT = os.path.join(SPECPATH, "..")

datas = []
binaries = []
hiddenimports = []
datas += copy_metadata("anthropic")
datas += copy_metadata("openai")
datas += copy_metadata("langchain_core")
datas += copy_metadata("langchain_anthropic")
datas += copy_metadata("langchain_deepseek")
datas += copy_metadata("langchain_openai")
for pkg in ("langchain_anthropic", "langchain_deepseek", "langchain_openai", "langchain_core"):
    pkg_datas, pkg_binaries, pkg_hiddenimports = collect_all(pkg)
    datas += pkg_datas
    binaries += pkg_binaries
    hiddenimports += pkg_hiddenimports

a = Analysis(
    [os.path.join(REPO_ROOT, "stox_bridge.py")],
    pathex=[REPO_ROOT],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="stox-backend",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name="stox-backend",
)
