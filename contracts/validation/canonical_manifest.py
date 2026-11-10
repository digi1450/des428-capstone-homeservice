"""Dev-only cross-language canonical-byte/hash reference. No DB or migration writes.
The JS/JSON Schema reference validates field/eligibility shape; this checks encoding.
"""
import hashlib
import json
import sys
MAX_SAFE = 9007199254740991

def _check(value):
    if type(value) is int:
        if abs(value) > MAX_SAFE:
            raise ValueError('MANIFEST_NON_SAFE_INTEGER')
    elif type(value) is str:
        if any(ord(c) < 32 or ord(c) > 126 for c in value):
            raise ValueError('MANIFEST_NON_ASCII_STRING')
    elif type(value) is list:
        for item in value:
            _check(item)
    elif type(value) is dict:
        for key, item in value.items():
            if type(key) is not str:
                raise ValueError('MANIFEST_NON_STRING_KEY')
            _check(key)
            _check(item)
    else:
        raise ValueError('MANIFEST_NON_INTEGER_JSON')

def canonical_bytes(value):
    _check(value)
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode('utf-8')

def _pairs(pairs):
    out = {}
    for key, value in pairs:
        if key in out:
            raise ValueError('MANIFEST_DUPLICATE_KEY')
        out[key] = value
    return out

if __name__ == '__main__':
    try:
        core = json.loads(sys.stdin.buffer.read().decode('utf-8'), object_pairs_hook=_pairs)
        encoded = canonical_bytes(core)
        print(json.dumps({'canonical_utf8_hex':encoded.hex(), 'manifest_sha256':hashlib.sha256(encoded).hexdigest()}))
    except (ValueError, TypeError, UnicodeError):
        print('Invalid canonical manifest input', file=sys.stderr)
        sys.exit(2)
