#!/usr/bin/env python3
"""Per-user remote directory picker. SSH uses existing OpenSSH authentication."""
import contextlib
import errno
import fcntl
import hashlib
import json
import os
from pathlib import Path
import posixpath
import re
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time

sys.path.insert(0, str(Path(__file__).parent / '.remote-folder-deps'))
IDENTIFIER = re.compile(r'[a-zA-Z0-9_-]{1,128}')


def identifier(value):
    if not isinstance(value, str) or not IDENTIFIER.fullmatch(value):
        raise ValueError('对话或目录标识无效。')
    return value


def read_json(file, default, limit):
    if file.is_symlink():
        raise ValueError('目录配置不能是符号链接。')
    if not file.exists():
        return default
    if file.stat().st_size > limit:
        raise ValueError('目录配置过大。')
    return json.loads(file.read_text())


def read_state(workspace):
    directory = workspace / '.codex'
    if directory.is_symlink():
        raise ValueError('目录配置不能是符号链接。')
    records = read_json(directory / 'remote-folders.json', [], 256 * 1024)
    views = read_json(directory / 'remote-folder-views.json', {}, 2 * 1024 * 1024)
    if not isinstance(records, list) or len(records) > 100 or not isinstance(views, dict) or len(views) > 5000:
        raise ValueError('目录配置无效。')
    for entry in records:
        if not isinstance(entry, dict) or not isinstance(entry.get('mount_path'), str):
            raise ValueError('目录记录无效。')
        identifier(entry.get('id'))
        mount = Path(os.path.abspath(entry['mount_path']))
        if not mount.is_relative_to(workspace) or mount == workspace:
            raise ValueError('挂载点不属于当前工作区。')
        bindings = entry.get('thread_ids')
        if bindings is not None:
            if not isinstance(bindings, list) or len(bindings) > 1000:
                raise ValueError('对话绑定无效。')
            for value in bindings:
                identifier(value)
    for thread, ids in views.items():
        identifier(thread)
        if not isinstance(ids, list) or len(ids) > 100:
            raise ValueError('对话目录配置无效。')
        for value in ids:
            identifier(value)
    return records, views


def atomic_json(file, value, limit):
    data = json.dumps(value, ensure_ascii=False, indent=2) + '\n'
    if len(data.encode()) > limit:
        raise ValueError('目录配置已达到容量限制。')
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=file.parent, delete=False) as handle:
            temporary = handle.name
            handle.write(data)
        os.replace(temporary, file)
    finally:
        if temporary and os.path.exists(temporary):
            os.unlink(temporary)


@contextlib.contextmanager
def state_lock(workspace, name='.remote-folders.lock'):
    directory = workspace / '.codex'
    if directory.is_symlink():
        raise ValueError('目录配置不能是符号链接。')
    directory.mkdir(mode=0o700, exist_ok=True)
    with os.fdopen(os.open(directory / name, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600), 'r+') as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        yield


def selected_ids(records, views, thread):
    if thread in views:
        return views[thread]
    if thread.startswith('draft-'):
        return []
    return [entry['id'] for entry in records if entry.get('shared') is True or thread in (entry.get('thread_ids') or [])]


def host_id(target):
    return hashlib.sha256(target.encode()).hexdigest()[:20]


def hosts_for(records):
    hosts = {}
    for entry in records:
        target = entry.get('host', '')
        if not isinstance(target, str) or not re.fullmatch(r'[a-zA-Z0-9_][a-zA-Z0-9_.@:\[\]-]{0,254}', target):
            continue
        key = host_id(target)
        remote = str(entry.get('remote_path', ''))
        windows = bool(re.match(r'^/?[A-Za-z]:[/\\]', remote))
        if key not in hosts:
            hosts[key] = dict(id=key, name=target, windows=windows)
        hosts[key]['windows'] |= windows
    return list(hosts.values())


def get_host(records, key):
    host = next((item for item in hosts_for(records) if item['id'] == key), None)
    if not host:
        raise ValueError('这台电脑尚未在当前账号中配置，请先连接电脑。')
    return host


def remote_path(value):
    if not isinstance(value, str) or not value or len(value) > 4096 or any(ord(char) < 32 for char in value):
        raise ValueError('远程路径无效。')
    if re.match(r'^/?[A-Za-z]:', value):
        value = '/' + value.lstrip('/').replace('\\', '/')
        value = '/' + value[1].upper() + value[2:]
    if not value.startswith('/'):
        raise ValueError('请选择远程绝对路径。')
    return posixpath.normpath(value)


def display_path(value):
    return value[1:].replace('/', '\\') + ('\\' if re.fullmatch(r'/[A-Za-z]:', value) else '') if re.match(r'^/[A-Za-z]:', value) else value


class SSHStream:
    def __init__(self, process):
        self.process = process

    def send(self, data):
        size = self.process.stdin.write(data)
        self.process.stdin.flush()
        return size

    def recv(self, size):
        return self.process.stdout.read(size)

    def get_name(self):
        return 'openssh-sftp'

    def close(self):
        if self.process.poll() is None:
            self.process.terminate()


@contextlib.contextmanager
def sftp_connection(host):
    import paramiko
    with tempfile.TemporaryFile() as errors:
        process = subprocess.Popen(['ssh', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
                                    '-o', 'ConnectTimeout=8', '-o', 'ServerAliveInterval=5',
                                    '-o', 'ServerAliveCountMax=1', '-s', host['name'], 'sftp'],
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=errors)
        client = None
        try:
            client = paramiko.SFTPClient(SSHStream(process))
            yield client
        except (EOFError, paramiko.SSHException) as error:
            raise ValueError('无法连接这台电脑，请检查 SSH 连接、电脑在线状态及访问权限。') from error
        finally:
            if client:
                client.close()
            if process.poll() is None:
                process.terminate()
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()


def browse(workspace, payload):
    records, _ = read_state(workspace)
    host = get_host(records, payload.get('hostId'))
    with sftp_connection(host) as client:
        requested = payload.get('path')
        if not requested:
            roots = []
            home = client.normalize('.')
            windows = host['windows'] or bool(re.match(r'^/?[A-Za-z]:', home))
            if windows:
                for letter in 'ABCDEFGHIJKLMNOPQRSTUVWXYZ':
                    candidate = f'/{letter}:/'
                    try:
                        if stat.S_ISDIR(client.stat(candidate).st_mode):
                            roots.append(dict(name=f'{letter}:', path=candidate))
                    except OSError:
                        pass
            else:
                roots.append(dict(name='文件系统 /', path='/'))
                if home != '/':
                    roots.append(dict(name='主目录', path=home))
            return dict(path=None, displayPath='盘符' if windows else '位置', parent=None, directories=roots, truncated=False)
        current = remote_path(requested)
        if not stat.S_ISDIR(client.stat(current).st_mode):
            raise ValueError('所选路径不是目录。')
        directories = []
        truncated = False
        for index, entry in enumerate(client.listdir_iter(current, read_aheads=1)):
            if index >= 2000:
                truncated = True
                break
            if stat.S_ISDIR(entry.st_mode) and entry.filename not in ('.', '..'):
                directories.append(dict(name=entry.filename, path=posixpath.join(current, entry.filename)))
        directories.sort(key=lambda entry: entry['name'].casefold())
        parent = None if current == '/' or re.fullmatch(r'/[A-Za-z]:', current) else posixpath.dirname(current)
        return dict(path=current, displayPath=display_path(current), parent=parent, directories=directories, truncated=truncated)


def mounted(mount):
    for line in Path('/proc/self/mountinfo').read_text().splitlines():
        fields = line.split(' - ', 1)[0].split()
        actual = re.sub(r'\\([0-7]{3})', lambda match: chr(int(match[1], 8)), fields[4])
        if actual == str(mount):
            filesystem = line.split(' - ', 1)[1].split()[0]
            return {'read_only': 'ro' in fields[5].split(','), 'filesystem': filesystem}
    return None


def connect_mount(workspace, host, remote, mount, folder_id, read_only=True):
    unit = 'codex-rf-' + hashlib.sha256(str(workspace).encode()).hexdigest()[:10] + '-' + folder_id
    info = mounted(mount)
    if info:
        # A disconnected FUSE filesystem can survive in mountinfo after SSH
        # exits. Repair only that explicit failure, never a merely slow mount.
        try:
            probe = subprocess.run([sys.executable, '-c',
                                    'import os,sys;\ntry: os.stat(sys.argv[1]); print(0)\nexcept OSError as error: print(error.errno)',
                                    str(mount)], capture_output=True, text=True, timeout=5)
        except subprocess.TimeoutExpired:
            return info
        disconnected = probe.returncode == 0 and probe.stdout.strip() in (str(errno.ENOTCONN), str(errno.EIO))
        if not disconnected:
            return info
        if info['filesystem'] != 'fuse.sshfs' or not mount.parent.resolve().is_relative_to(workspace):
            raise ValueError('挂载点无效，无法恢复连接。')
        unmount = shutil.which('fusermount3') or shutil.which('fusermount')
        if not unmount:
            raise ValueError('远程挂载已失效，当前环境无法恢复，请检查 FUSE 工具。')
        subprocess.run(['systemctl', '--user', 'stop', unit], capture_output=True, timeout=5)
        if mounted(mount):
            result = subprocess.run([unmount, '-u', str(mount)], capture_output=True, timeout=5)
            if result.returncode or mounted(mount):
                raise ValueError('失效挂载仍被占用，请关闭使用此目录的程序后重试。')
        with sftp_connection(host) as client:
            if not stat.S_ISDIR(client.stat(remote).st_mode):
                raise ValueError('所选路径不是目录。')
    binary = shutil.which('sshfs') or str(workspace / '.local/opt/sshfs/usr/bin/sshfs')
    if not os.access(binary, os.X_OK):
        raise ValueError('当前账号尚未安装 SSHFS，请点击“连接其他电脑”让 Codex 配置连接。')
    if mount.is_symlink() or not mount.resolve().is_relative_to(workspace):
        raise ValueError('挂载点无效。')
    mount.mkdir(parents=True, exist_ok=True)
    if next(mount.iterdir(), None) is not None:
        raise ValueError('挂载点不是空目录。')
    result = subprocess.run(['systemd-run', '--user', '--unit=' + unit, '--collect', '--property=Restart=no',
                             '--property=TimeoutStopSec=3', '--property=MemoryMax=128M', '--property=TasksMax=32',
                             '--', binary, '-f', host['name'] + ':' + remote, str(mount), '-o',
                             ('ro' if read_only else 'rw') + ',nodev,nosuid,BatchMode=yes,StrictHostKeyChecking=yes,ConnectTimeout=8,ServerAliveInterval=15,ServerAliveCountMax=2'],
                            capture_output=True, timeout=6)
    if result.returncode:
        raise ValueError('无法保留远程挂载，请在对话中检查当前账号的 SSHFS 服务。')
    try:
        for _ in range(60):
            info = mounted(mount)
            if info:
                return info
            time.sleep(.2)
        raise ValueError('连接目录超时，请检查远程电脑是否在线。')
    except BaseException:
        subprocess.run(['systemctl', '--user', 'stop', unit], capture_output=True, timeout=5)
        raise


def attach(workspace, payload):
    thread = identifier(payload.get('threadId'))
    records, _ = read_state(workspace)
    host = get_host(records, payload.get('hostId'))
    remote = remote_path(payload.get('path'))
    existing = next((entry for entry in records if entry.get('host') == host['name'] and remote_path(entry.get('remote_path', '')) == remote), None)
    label = display_path(remote)
    folder_id = existing['id'] if existing else hashlib.sha256((host['name'] + '\0' + label).encode()).hexdigest()[:20]
    mount = Path(existing['mount_path']) if existing else workspace / '远程目录' / folder_id
    with state_lock(workspace, '.remote-mount-' + folder_id + '.lock'):
        if not mounted(mount):
            with sftp_connection(host) as client:
                if not stat.S_ISDIR(client.stat(remote).st_mode):
                    raise ValueError('所选路径不是目录。')
        info = connect_mount(workspace, host, remote, mount, folder_id, not existing or existing.get('read_only') is not False)
        with state_lock(workspace):
            records, views = read_state(workspace)
            selected = selected_ids(records, views, thread)
            record = next((entry for entry in records if entry['id'] == folder_id), None)
            if record is None:
                if len(records) >= 100:
                    raise ValueError('已达到 100 个已保存目录的限制。')
                record = dict(id=folder_id, name=posixpath.basename(remote.rstrip('/')) or '/', host=host['name'],
                              remote_path=label, mount_path=str(mount), read_only=info['read_only'], thread_ids=[thread])
                records.append(record)
            elif record.get('shared') is not True:
                record['thread_ids'] = list(dict.fromkeys([*(record.get('thread_ids') or []), thread]))
            record['read_only'] = info['read_only']
            views[thread] = list(dict.fromkeys([*selected, folder_id]))
            if len(views) > 5000 or len(record.get('thread_ids') or []) > 1000:
                raise ValueError('已达到对话目录配置的容量限制。')
            atomic_json(workspace / '.codex/remote-folders.json', records, 256 * 1024)
            atomic_json(workspace / '.codex/remote-folder-views.json', views, 2 * 1024 * 1024)
    return dict(id=folder_id)


def reconnect(workspace, payload):
    thread = identifier(payload.get('threadId'))
    folder = identifier(payload.get('folderId'))
    # Restoring a mount must not add a binding or reopen a directory the user closed.
    with state_lock(workspace, '.remote-mount-' + folder + '.lock'):
        records, views = read_state(workspace)
        record = next((entry for entry in records if entry['id'] == folder), None)
        if record is None or folder not in selected_ids(records, views, thread):
            raise ValueError('未找到此对话可用的远程目录。')
        mount = Path(record['mount_path'])
        host = get_host(records, host_id(record.get('host', '')))
        remote = remote_path(record.get('remote_path'))
        if not mounted(mount):
            with sftp_connection(host) as client:
                if not stat.S_ISDIR(client.stat(remote).st_mode):
                    raise ValueError('所选路径不是目录。')
        connect_mount(workspace, host, remote, mount, folder, record.get('read_only') is not False)
    return dict(id=folder)


def update_view(workspace, action, payload):
    thread = identifier(payload.get('threadId'))
    with state_lock(workspace):
        records, views = read_state(workspace)
        if action == 'close':
            folder = identifier(payload.get('folderId'))
            views[thread] = [value for value in selected_ids(records, views, thread) if value != folder]
        elif action == 'transfer':
            draft = identifier(payload.get('draftId'))
            if not draft.startswith('draft-') or thread.startswith('draft-'):
                raise ValueError('新对话目录绑定无效。')
            selected = views.get(draft, [])
            views[thread] = list(dict.fromkeys([*views.get(thread, []), *selected]))
            for record in records:
                bindings = record.get('thread_ids')
                if bindings is not None and draft in bindings:
                    record['thread_ids'] = list(dict.fromkeys([value for value in bindings if value != draft] + [thread]))
            views.pop(draft, None)
            atomic_json(workspace / '.codex/remote-folders.json', records, 256 * 1024)
        if len(views) > 5000:
            raise ValueError('已达到对话目录配置的容量限制。')
        atomic_json(workspace / '.codex/remote-folder-views.json', views, 2 * 1024 * 1024)
    return dict(ok=True)


def main():
    workspace = Path(sys.argv[1]).resolve(strict=True)
    action = sys.argv[2]
    payload = json.load(sys.stdin)
    if action == 'catalog':
        records, _ = read_state(workspace)
        return dict(hosts=hosts_for(records), recent=[dict(id=entry['id'], name=entry['name'], hostId=host_id(entry.get('host', '')),
                    path=entry.get('remote_path', '')) for entry in records if entry.get('host')])
    if action == 'browse':
        return browse(workspace, payload)
    if action == 'attach':
        return attach(workspace, payload)
    if action == 'reconnect':
        return reconnect(workspace, payload)
    if action in ('close', 'transfer'):
        return update_view(workspace, action, payload)
    raise ValueError('不支持的目录操作。')


if __name__ == '__main__':
    def timed_out(*_):
        raise TimeoutError('读取远程电脑超时，请检查连接后重试。')
    signal.signal(signal.SIGALRM, timed_out)
    signal.signal(signal.SIGTERM, timed_out)
    signal.alarm(35)
    try:
        print(json.dumps({'data': main()}, ensure_ascii=False))
    except Exception as error:
        messages = {2: '远程目录不存在。', 13: '没有读取此目录的权限。'}
        print(json.dumps({'error': messages.get(getattr(error, 'errno', None), str(error)) or '远程目录操作失败。'}, ensure_ascii=False))
