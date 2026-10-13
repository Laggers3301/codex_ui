#!/usr/bin/python3
"""Root-owned controller management; no tokens are emitted or sent to proxies."""
import json
import os
import re
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

CONFIG_FILE = Path('/etc/codex-zerotier-controller.json')
config_stat = CONFIG_FILE.stat()
if config_stat.st_uid != 0 or config_stat.st_mode & 0o022:
    raise RuntimeError('Controller configuration must be root-owned and not writable by other users')
CONFIG = json.loads(CONFIG_FILE.read_text())
HOME_DIR = Path(CONFIG.get('home', '/var/lib/zerotier-codex-controller'))
NETWORK = CONFIG['networkId']
if not re.fullmatch(r'[0-9a-f]{16}', NETWORK) or NETWORK == '0000000000000000':
    raise RuntimeError('Configure a valid private controller network ID')
CONTROLLER_ID = NETWORK[:10]
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))

def request(path, payload=None):
    token = (HOME_DIR / 'authtoken.secret').read_text().strip()
    req = urllib.request.Request('http://127.0.0.1:19993' + path,
        data=json.dumps(payload).encode() if payload is not None else None,
        headers={'X-ZT1-AUTH': token, 'Content-Type': 'application/json'},
        method='POST' if payload is not None else 'GET')
    with OPENER.open(req, timeout=3) as response:
        return json.load(response)

def main():
    if os.getuid() != 0:
        raise RuntimeError('Use sudo for controller management')
    args = sys.argv[1:]
    if not args or len(args) > 3:
        raise ValueError('Usage: codex-zerotier-admin status|member <id>|authorize <id> <name>')
    command = args[0]
    if command == 'health':
        if len(args) != 1:
            raise ValueError('Unexpected health arguments')
        directory = Path('/run/codex-zerotier-controller-health')
        directory.mkdir(mode=0o700, exist_ok=True)
        file = directory / 'state.json'
        try:
            state = json.loads(file.read_text())
        except (OSError, ValueError):
            state = {'failures': 0, 'lastRestart': 0}
        now = int(time.time() * 1000)
        try:
            status, config = request('/status'), request('/controller/network/' + NETWORK)
            if status.get('address') != CONTROLLER_ID or config.get('id') != NETWORK:
                raise RuntimeError('Controller identity/network mismatch')
            state.update(failures=0, lastSuccess=now, online=status.get('online'))
        except Exception as error:
            state['failures'] = state.get('failures', 0) + 1
            print(json.dumps({'controllerHealthFailure': state['failures'], 'error': str(error)}), file=sys.stderr)
            if state['failures'] >= 3 and now - state.get('lastRestart', 0) > 300000:
                subprocess.run(['/usr/bin/systemctl', 'restart', 'codex-zerotier-controller.service'], check=True, timeout=30)
                state.update(lastRestart=now, failures=0)
                print('Restarted only the dedicated controller after repeated local API failures.', file=sys.stderr)
        file.write_text(json.dumps(state))
        file.chmod(0o600)
        return
    status = request('/status')
    if status.get('address') != CONTROLLER_ID:
        raise RuntimeError('Wrong controller identity')
    if command == 'status':
        if len(args) != 1:
            raise ValueError('Unexpected status arguments')
        members = request('/controller/network/' + NETWORK + '/member')
        print(json.dumps({'controller': status['address'], 'online': status.get('online'), 'networkId': NETWORK, 'memberRecords': len(members)}))
        return
    if command not in ('member', 'authorize') or len(args) != (3 if command == 'authorize' else 2):
        raise ValueError('Invalid member command')
    node = args[1].lower()
    if not re.fullmatch(r'[0-9a-f]{10}', node):
        raise ValueError('Node ID must have 10 hexadecimal characters')
    path = '/controller/network/' + NETWORK + '/member/' + node
    if command == 'authorize':
        name = args[2]
        if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,63}', name):
            raise ValueError('Invalid member name')
        before = request(path)
        if not before.get('identity'):
            raise RuntimeError('Node has not joined this network; ask the user to join first')
        request(path, {'authorized': True, 'name': name})
    member = request(path)
    if command == 'authorize' and (member.get('authorized') is not True or member.get('name') != args[2]):
        raise RuntimeError('Authorization read-back failed')
    print(json.dumps({'nodeId': node, 'name': member.get('name'), 'authorized': member.get('authorized'),
        'ipAssignments': member.get('ipAssignments'), 'lastSeen': member.get('lastSeen')}))

if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
