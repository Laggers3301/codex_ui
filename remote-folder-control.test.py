import errno
import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch, Mock

spec = importlib.util.spec_from_file_location('remote_control', Path(__file__).with_name('remote-folder-control.py'))
control = importlib.util.module_from_spec(spec)
spec.loader.exec_module(control)


class MountRecoveryTest(unittest.TestCase):
    def test_disconnected_sshfs_is_restored_without_changing_access_mode(self):
        for read_only in (True, False):
            with self.subTest(read_only=read_only), tempfile.TemporaryDirectory() as temporary:
                workspace = Path(temporary)
                mount = workspace / 'mount'
                mount.mkdir()
                state = {'mounted': True}
                calls = []
                info = {'read_only': read_only, 'filesystem': 'fuse.sshfs'}
                def run(args, **kwargs):
                    calls.append(args)
                    if args[0] == control.sys.executable:
                        return subprocess.CompletedProcess(args, 0, str(errno.ENOTCONN), '')
                    if args[0] == '/usr/bin/fusermount3':
                        state['mounted'] = False
                    if args[0] == 'systemd-run':
                        state['mounted'] = True
                    return subprocess.CompletedProcess(args, 0, '', '')
                client = Mock()
                client.stat.return_value.st_mode = 0o040755
                with patch.object(control, 'mounted', side_effect=lambda _: info if state['mounted'] else None), \
                     patch.object(control.subprocess, 'run', side_effect=run), \
                     patch.object(control.shutil, 'which', side_effect=lambda name: '/usr/bin/' + name), \
                     patch.object(control.os, 'access', return_value=True), \
                     patch.object(control, 'sftp_connection') as connection:
                    connection.return_value.__enter__.return_value = client
                    self.assertEqual(control.connect_mount(workspace, {'name': 'computer'}, '/work', mount, 'folder', read_only), info)
                detach = next(args for args in calls if args[0] == '/usr/bin/fusermount3')
                self.assertEqual(detach, ['/usr/bin/fusermount3', '-u', str(mount)])
                launch = next(args for args in calls if args[0] == 'systemd-run')
                self.assertTrue(launch[-1].startswith('ro,' if read_only else 'rw,'))
                self.assertIn('--property=Restart=no', launch)

    def test_slow_mount_is_not_disconnected(self):
        info = {'read_only': True, 'filesystem': 'fuse.sshfs'}
        with patch.object(control, 'mounted', return_value=info), \
             patch.object(control.subprocess, 'run', side_effect=subprocess.TimeoutExpired('probe', 5)) as run:
            self.assertEqual(control.connect_mount(Path('/workspace'), {'name': 'computer'}, '/work', Path('/workspace/mount'), 'folder'), info)
            self.assertEqual(run.call_count, 1)

    def test_foreign_filesystem_is_never_unmounted(self):
        info = {'read_only': True, 'filesystem': 'nfs'}
        with patch.object(control, 'mounted', return_value=info), \
             patch.object(control.subprocess, 'run', return_value=subprocess.CompletedProcess('probe', 0, str(errno.EIO), '')) as run:
            with self.assertRaisesRegex(ValueError, '挂载点无效'):
                control.connect_mount(Path('/workspace'), {'name': 'computer'}, '/work', Path('/workspace/mount'), 'folder')
            self.assertEqual(run.call_count, 1)


if __name__ == '__main__':
    unittest.main()
