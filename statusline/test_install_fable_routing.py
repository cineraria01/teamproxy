#!/usr/bin/env python3
"""install-fable-routing.py finds the LaunchAgent without assuming a machine-specific label."""
import importlib.util
from pathlib import Path
import tempfile

spec = importlib.util.spec_from_file_location('install_fable_routing', Path(__file__).with_name('install-fable-routing.py'))
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)


def refused(agents: Path) -> str:
    try:
        mod.find_plist(agents)
    except SystemExit as e:
        return str(e)
    raise AssertionError('expected a refusal')


with tempfile.TemporaryDirectory() as d:
    agents = Path(d)
    assert 'found: none' in refused(agents)
    (agents / 'com.example.teamclaude.plist').write_text('')
    (agents / 'com.example.teamclaude.plist.pre-fable-routing').write_text('')
    (agents / 'com.example.teamcodex.plist').write_text('')
    assert mod.find_plist(agents) == agents / 'com.example.teamclaude.plist'
    (agents / 'kr.other.teamclaude.plist').write_text('')
    msg = refused(agents)
    assert 'com.example.teamclaude.plist' in msg and 'kr.other.teamclaude.plist' in msg, msg
print('install-fable-routing: ok')
