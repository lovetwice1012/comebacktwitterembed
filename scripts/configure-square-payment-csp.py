#!/usr/bin/env python3
"""Restrict Square's bank-authentication CSP exception to the payment pages."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import tempfile


CONFIGS = (
    Path('/etc/nginx/conf.d/cbte-admin-gateway.conf'),
    Path('/etc/nginx/conf.d/cbte-dashboard-origin.conf'),
)
MAP = Path('/etc/nginx/conf.d/00-cbte-square-payment-csp.conf')
VARIABLE = '$cbte_square_payment_csp'
PAYMENT_PATHS = ('/dashboard/automation/plans', '/dashboard/automation/support')
FONT_ORIGIN = 'https://cash-f.squarecdn.com'


class ConfigError(RuntimeError):
    pass


def digest(data):
    return hashlib.sha256(data).hexdigest()


def snapshot(path):
    try:
        info = path.lstat()
    except FileNotFoundError:
        return None
    if not stat.S_ISREG(info.st_mode):
        raise ConfigError(f'Refusing non-regular file: {path}')
    data = path.read_bytes()
    after = path.lstat()
    if (info.st_ino, info.st_dev, info.st_mtime_ns, info.st_size) != (
        after.st_ino, after.st_dev, after.st_mtime_ns, after.st_size
    ):
        raise ConfigError(f'File changed while reading: {path}')
    return (data, info)


def fingerprint(value):
    return None if value is None else digest(value[0])


def csp_literal(data):
    # Tokenize comments and quoted strings so a commented header cannot match.
    tokens = list(re.finditer(rb'#[^\r\n]*|"(?:\\.|[^"\\])*"|\x27(?:\\.|[^\x27\\])*\x27|[{};]|[^\s{};#"\x27]+', data))
    tokens = [token for token in tokens if not token.group().startswith(b'#')]
    matches = []
    for index, token in enumerate(tokens):
        if token.group() == b'add_header' and index + 2 < len(tokens) and tokens[index + 1].group() == b'Content-Security-Policy':
            value = tokens[index + 2]
            end = index + 3
            if end < len(tokens) and tokens[end].group() == b'always':
                end += 1
            if end >= len(tokens) or tokens[end].group() != b';':
                raise ConfigError('Unexpected Content-Security-Policy header syntax')
            raw = value.group()
            if not raw.startswith(b'"') or not raw.endswith(b'"'):
                raise ConfigError('Expected a double-quoted literal CSP')
            if b'\\' in raw or b'$' in raw or b'\n' in raw or b'\r' in raw:
                raise ConfigError('Expected a literal CSP without escapes or interpolation')
            matches.append((value.start(), value.end(), raw[1:-1].decode('utf-8')))
    if len(matches) != 1:
        raise ConfigError('Expected exactly one active Content-Security-Policy header')
    return matches[0]


def payment_policy(base):
    parts = base.split(';')
    found = set()
    for index, part in enumerate(parts):
        match = re.fullmatch(r'(\s*)([A-Za-z][A-Za-z0-9-]*)(\s+)(.*?)(\s*)', part)
        if not match:
            continue
        name = match[2].lower()
        if name in found:
            raise ConfigError(f'Duplicate CSP directive: {name}')
        found.add(name)
        if name == 'font-src':
            sources = match[4].split()
            if "'none'" in sources:
                raise ConfigError('Cannot add a font origin to font-src none')
            value = match[4] if FONT_ORIGIN in sources else match[4] + ' ' + FONT_ORIGIN
        elif name in ('frame-src', 'form-action'):
            value = "'self' https:"
        else:
            continue
        parts[index] = match[1] + match[2] + match[3] + value + match[5]
    if not {'font-src', 'frame-src', 'form-action'} <= found:
        raise ConfigError('Expected font-src, frame-src and form-action in the existing CSP')
    return ';'.join(parts)


def quoted(value):
    if any(char in value for char in ('"', '\\', '$', '\n', '\r')):
        raise ConfigError('Unsafe character in a literal CSP')
    return '"' + value + '"'


def prepare(configs=CONFIGS, map_path=MAP):
    originals = {path: snapshot(path) for path in (*configs, map_path)}
    if originals[map_path] is not None:
        raise ConfigError('CSP map already exists; inspect and review it before changing it')
    outputs, base = {}, None
    for path in configs:
        if originals[path] is None:
            raise ConfigError(f'Missing config: {path}')
        data = originals[path][0]
        start, end, literal = csp_literal(data)
        if base is not None and literal != base:
            raise ConfigError('The two existing CSP policies differ')
        base = literal
        outputs[path] = data[:start] + ('"' + VARIABLE + '"').encode() + data[end:]
    payment = payment_policy(base)
    lines = ['# Managed by configure-square-payment-csp.py.', f'map $uri {VARIABLE} {{', f'    default {quoted(base)};']
    # Nginx string keys ignore case; anchored regex keys preserve exact scope.
    lines += [f'    ~^{re.escape(path)}$ {quoted(payment)};' for path in PAYMENT_PATHS]
    lines += ['}', '']
    outputs[map_path] = '\n'.join(lines).encode('utf-8')
    return originals, outputs, base, payment


def unchanged(path, expected):
    current = snapshot(path)
    if fingerprint(current) != fingerprint(expected):
        raise ConfigError(f'Concurrent config change: {path}')
    if expected is not None and (stat.S_IMODE(current[1].st_mode), current[1].st_uid, current[1].st_gid) != (stat.S_IMODE(expected[1].st_mode), expected[1].st_uid, expected[1].st_gid):
        raise ConfigError(f'Concurrent config permission change: {path}')


def write_atomic(path, data, original, expected):
    descriptor, temporary = tempfile.mkstemp(prefix='.cbte-csp-', dir=path.parent)
    try:
        info = None if original is None else original[1]
        mode = 0o644 if info is None else stat.S_IMODE(info.st_mode)
        if hasattr(os, 'fchmod'):
            os.fchmod(descriptor, mode)
        else:
            os.chmod(temporary, mode)
        if info is not None and hasattr(os, 'fchown'):
            os.fchown(descriptor, info.st_uid, info.st_gid)
        with os.fdopen(descriptor, 'wb') as file:
            descriptor = None
            file.write(data)
            file.flush()
            os.fsync(file.fileno())
            written_info = os.fstat(file.fileno())
        unchanged(path, expected)
        os.replace(temporary, path)
        return (data, written_info)
    finally:
        if descriptor is not None:
            os.close(descriptor)
        if os.path.exists(temporary):
            os.unlink(temporary)


def run_command(command):
    binaries = {'nginx': '/usr/sbin/nginx', 'systemctl': '/bin/systemctl'}
    if not command or command[0] not in binaries:
        raise ConfigError('Unsupported config command')
    executable = [binaries[command[0]], *command[1:]]
    return subprocess.run(executable, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False).returncode


def apply(expected, configs=CONFIGS, map_path=MAP, backup_root=Path('/var/backups'), runner=run_command):
    originals, outputs, base, payment = prepare(configs, map_path)
    if set(expected) != set(originals):
        raise ConfigError('Expected hashes must cover both configs and the absent map')
    for path, original in originals.items():
        if fingerprint(original) != expected[path]:
            raise ConfigError(f'Expected config hash does not match: {path}')
    if not backup_root.is_dir():
        raise ConfigError('Backup root does not exist')
    backup = Path(tempfile.mkdtemp(prefix='cbte-square-payment-csp-', dir=backup_root))
    backup.chmod(0o700)
    for path, original in originals.items():
        if original is not None:
            target = backup / path.name
            target.write_bytes(original[0])
            target.chmod(0o600)
    (backup / 'manifest.json').write_text(json.dumps({str(path): fingerprint(value) for path, value in originals.items()}, indent=2), encoding='utf-8')
    (backup / 'manifest.json').chmod(0o600)
    changed = {}
    reload_attempted = False
    try:
        for path, original in originals.items():
            unchanged(path, original)
        for path, data in outputs.items():
            changed[path] = write_atomic(path, data, originals[path], originals[path])
            unchanged(path, changed[path])
        if runner(['nginx', '-t']) != 0:
            raise ConfigError('nginx configuration test failed')
        for path, owned in changed.items():
            unchanged(path, owned)
        reload_attempted = True
        if runner(['systemctl', 'reload', 'nginx']) != 0:
            raise ConfigError('nginx reload failed')
        for path, owned in changed.items():
            unchanged(path, owned)
    except Exception as failure:
        conflicts = []
        for path, owned in reversed(list(changed.items())):
            try:
                unchanged(path, owned)
                original = originals[path]
                if original is None:
                    path.unlink()
                else:
                    write_atomic(path, original[0], original, owned)
            except Exception:
                conflicts.append(str(path))
        if reload_attempted and not conflicts:
            if runner(['nginx', '-t']) != 0 or runner(['systemctl', 'reload', 'nginx']) != 0:
                raise ConfigError(f'{failure}; files restored, restoring the running config failed; backup: {backup}') from failure
        if conflicts:
            raise ConfigError(f'{failure}; foreign changes preserved at {", ".join(conflicts)}; backup: {backup}') from failure
        raise ConfigError(f'{failure}; original files restored; backup: {backup}') from failure
    return {'backup': str(backup), 'before': {str(path): fingerprint(value) for path, value in originals.items()}, 'after': {str(path): digest(value) for path, value in outputs.items()}, 'default_policy': base, 'payment_policy': payment, 'payment_paths': PAYMENT_PATHS}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=('inspect', 'apply'))
    parser.add_argument('--expected-config', action='append', default=[], metavar='PATH=SHA256')
    parser.add_argument('--expected-map-sha', choices=('absent',), help='The reviewed map must be absent')
    args = parser.parse_args()
    try:
        if args.command == 'inspect':
            originals, outputs, base, payment = prepare()
            result = {'before': {str(path): fingerprint(value) for path, value in originals.items()}, 'after': {str(path): digest(value) for path, value in outputs.items()}, 'default_policy': base, 'payment_policy': payment, 'payment_paths': PAYMENT_PATHS}
        else:
            expected = {}
            for value in args.expected_config:
                path, separator, sha = value.rpartition('=')
                if not separator or Path(path) not in CONFIGS or not re.fullmatch('[a-fA-F0-9]{64}', sha) or Path(path) in expected:
                    raise ConfigError('Expected-config must name each exact config path once with a SHA256')
                expected[Path(path)] = sha.lower()
            if args.expected_map_sha != 'absent':
                raise ConfigError('Apply requires --expected-map-sha absent')
            expected[MAP] = None
            result = apply(expected)
        print(json.dumps(result, indent=2))
    except (ConfigError, OSError, UnicodeError) as error:
        parser.exit(1, f'{error}\n')


if __name__ == '__main__':
    main()
