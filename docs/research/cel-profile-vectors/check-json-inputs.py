"""Independent Python JSON parsing checks; no Originals code or network access."""
import json
import math
from pathlib import Path

def unique_members(pairs):
    value = {}
    for key, child in pairs:
        if key in value:
            raise ValueError('duplicate decoded member name')
        value[key] = child
    return value

def check(value):
    if isinstance(value, str):
        value.encode('utf-8', errors='strict')
    elif type(value) is int:
        # json.loads parses a plain integer literal as an exact, arbitrary
        # precision Python int with no fraction/exponent, unlike JS Number();
        # mirror the production parser's binary64 exactness check so this
        # oracle rejects the same out-of-range literals (see #727).
        as_double = float(value)
        if not math.isfinite(as_double) or int(as_double) != value:
            raise ValueError('integer literal not exactly representable in binary64')
    elif isinstance(value, float) and not math.isfinite(value):
        raise ValueError('nonfinite number')
    elif isinstance(value, dict):
        for key, child in value.items():
            check(key)
            check(child)
    elif isinstance(value, list):
        for child in value:
            check(child)

inputs = json.loads(Path(__file__).with_name('transport-inputs.json').read_text())['json']
for case in inputs:
    try:
        value = json.loads(case['source'], object_pairs_hook=unique_members)
        check(value)
        status = 'accepted'
    except (ValueError, UnicodeError):
        status = 'rejected'
    assert status == case['expected'], (case['id'], status)
print(json.dumps({'jsonInputs': len(inputs), 'status': 'passed', 'scope': 'Declared JSON text parser cases only; not a full production parser or schema check.'}))
