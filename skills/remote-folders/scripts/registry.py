#!/usr/bin/env python3
"""Bind verified remote mounts to Codex conversations in the user's file sidebar."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import tempfile


def mount_info(mount_path):
    for line in Path('/proc/self/mountinfo').read_text().splitlines():
        before, after = line.split(' - ', 1)
        fields = before.split()
        actual = re.sub(r'\\([0-7]{3})', lambda match: chr(int(match[1], 8)), fields[4])
        if actual == str(mount_path):
            return {'read_only': 'ro' in fields[5].split(','), 'source': after.split()[1]}
    raise ValueError('The directory is not currently mounted; connect it before registering.')


def current_thread(args):
    if getattr(args, 'shared', False) or getattr(args, 'all_conversations', False):
        return None
    value = args.thread_id or os.environ.get('CODEX_THREAD_ID') or os.environ.get('CODEX_SESSION_ID')
    if not value or not re.fullmatch(r'[a-zA-Z0-9_-]{1,128}', value):
        raise ValueError('No valid current conversation ID. Provide --thread-id, or explicitly select account-wide scope.')
    return value


def visible_in(entry, thread_id):
    return entry.get('shared') is True or thread_id in (entry.get('thread_ids') or [])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--workspace', required=True, type=Path)
    commands = parser.add_subparsers(dest='command', required=True)
    register = commands.add_parser('register')
    register.add_argument('--name', required=True)
    register.add_argument('--host', required=True)
    register.add_argument('--remote-path', required=True)
    register.add_argument('--mount-path', type=Path, required=True)
    register_scope = register.add_mutually_exclusive_group()
    register_scope.add_argument('--thread-id', help='Defaults to CODEX_THREAD_ID or CODEX_SESSION_ID.')
    register_scope.add_argument('--shared', action='store_true', help='Show this directory in every conversation of this account.')
    listing = commands.add_parser('list')
    list_scope = listing.add_mutually_exclusive_group()
    list_scope.add_argument('--thread-id')
    list_scope.add_argument('--all-conversations', action='store_true')
    remove = commands.add_parser('remove')
    remove.add_argument('--id', required=True)
    remove_scope = remove.add_mutually_exclusive_group()
    remove_scope.add_argument('--thread-id')
    remove_scope.add_argument('--all-conversations', action='store_true', help='Remove the registration from every conversation; does not unmount.')
    args = parser.parse_args()
    thread_id = current_thread(args)
    workspace = args.workspace.resolve(strict=True)
    if not workspace.is_dir():
        raise ValueError('Workspace must be a directory.')
    directory = workspace / '.codex'
    registry = directory / 'remote-folders.json'
    views_file = directory / 'remote-folder-views.json'
    if directory.is_symlink() or registry.is_symlink() or views_file.is_symlink():
        raise ValueError('Registry directory and file must not be symbolic links.')
    if args.command == 'list' and not registry.exists():
        print('[]')
        return
    record = None
    if args.command == 'register':
        if not args.name.strip() or len(args.name) > 120:
            raise ValueError('Choose a nonempty display name of at most 120 characters.')
        mount = Path(os.path.abspath(args.mount_path))
        if not mount.is_relative_to(workspace) or mount == workspace or mount.is_symlink():
            raise ValueError('Mount point must be inside the personal workspace.')
        info = mount_info(mount)
        if not mount.resolve(strict=True).is_relative_to(workspace) or not mount.is_dir():
            raise ValueError('Mount point must resolve to a directory inside the workspace.')
        identifier = hashlib.sha256((args.host + '\0' + args.remote_path).encode()).hexdigest()[:20]
        record = dict(id=identifier, name=args.name.strip(), host=args.host, remote_path=args.remote_path,
                      mount_path=str(mount), read_only=info['read_only'])
    directory.mkdir(mode=0o700, exist_ok=True)
    lock_path = directory / '.remote-folders.lock'
    descriptor = os.open(lock_path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, 'r+') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        records = json.loads(registry.read_text()) if registry.exists() else []
        if views_file.exists() and views_file.stat().st_size > 2 * 1024 * 1024:
            raise ValueError('Conversation directory settings are too large.')
        views = json.loads(views_file.read_text()) if views_file.exists() else {}
        if not isinstance(views, dict) or any(not isinstance(key, str) or not re.fullmatch(r'[a-zA-Z0-9_-]{1,128}', key)
                or not isinstance(value, list) or len(value) > 100
                or any(not isinstance(item, str) or not re.fullmatch(r'[a-zA-Z0-9_-]{1,128}', item) for item in value)
                for key, value in views.items()):
            raise ValueError('Existing conversation directory settings are invalid.')
        if not isinstance(records, list) or any(not isinstance(item, dict) for item in records):
            raise ValueError('Existing registry is invalid; it has not been overwritten.')
        for item in records:
            bindings = item.get('thread_ids')
            if bindings is not None and (not isinstance(bindings, list) or len(bindings) > 1000
                    or any(not isinstance(value, str) or not re.fullmatch(r'[a-zA-Z0-9_-]{1,128}', value) for value in bindings)):
                raise ValueError('Existing conversation bindings are invalid; the registry has not been overwritten.')
        if args.command == 'list':
            print(json.dumps([item for item in records if args.all_conversations or
                             (item.get('id') in views[thread_id] if thread_id in views else visible_in(item, thread_id))], ensure_ascii=False, indent=2))
            return
        current_ids = views.get(thread_id, [item.get('id') for item in records if visible_in(item, thread_id)]) if thread_id else []
        if record:
            existing = next((item for item in records if item.get('id') == record['id']), None)
            if any(item.get('id') != record['id'] and item.get('mount_path') == record['mount_path'] for item in records):
                raise ValueError('This mount point is registered for another remote directory. Reuse that registration or choose a separate mount point.')
            if args.shared or (existing or {}).get('shared') is True:
                record['thread_ids'] = None
                record['shared'] = True
            else:
                record['thread_ids'] = list(dict.fromkeys([*((existing or {}).get('thread_ids') or []), thread_id]))
                if len(record['thread_ids']) > 1000:
                    raise ValueError('At most 1000 conversations can be bound to one directory.')
            records = [entry for entry in records if entry.get('id') != record['id']]
            records.append(record)
            if thread_id:
                views[thread_id] = list(dict.fromkeys([*current_ids, record['id']]))
        else:
            remaining = []
            for entry in records:
                if entry.get('id') != args.id:
                    remaining.append(entry)
                elif not args.all_conversations:
                    if entry.get('thread_ids') is not None:
                        entry['thread_ids'] = [value for value in entry['thread_ids'] if value != thread_id]
                    remaining.append(entry)
            records = remaining
            if args.all_conversations:
                views = {key: [value for value in ids if value != args.id] for key, ids in views.items()}
            else:
                views[thread_id] = [value for value in current_ids if value != args.id]
        if len(records) > 100:
            raise ValueError('At most 100 directories can be registered per workspace.')
        contents = json.dumps(records, ensure_ascii=False, indent=2) + '\n'
        if len(contents.encode('utf-8')) > 256 * 1024:
            raise ValueError('The remote directory registry must not exceed 256 KiB.')
        view_contents = json.dumps(views, ensure_ascii=False, indent=2) + '\n'
        if len(view_contents.encode('utf-8')) > 2 * 1024 * 1024 or len(views) > 5000:
            raise ValueError('Conversation directory settings exceed the storage limit.')
        for target, body in [(registry, contents), (views_file, view_contents)]:
            temporary = None
            try:
                with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=directory, prefix='.remote-folders-', delete=False) as handle:
                    temporary = handle.name
                    handle.write(body)
                os.replace(temporary, target)
            finally:
                if temporary and os.path.exists(temporary):
                    os.unlink(temporary)
    print(json.dumps(record if record else {'removed': args.id, 'thread_id': thread_id}, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError) as error:
        raise SystemExit(str(error))
