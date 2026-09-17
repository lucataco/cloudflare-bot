import base64
from pathlib import Path
import tempfile
import unittest
import run


class WorkspaceOperations(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        run.ROOT = Path(self.temp.name).resolve()

    def tearDown(self):
        self.temp.cleanup()

    def test_file_round_trip_and_scope(self):
        run.run({'kind': 'write', 'path': 'folder/result.txt', 'data': base64.b64encode(b'result').decode()})
        result = run.run({'kind': 'read', 'path': 'folder/result.txt'})
        self.assertEqual(base64.b64decode(result['data']), b'result')
        self.assertEqual(run.run({'kind': 'list', 'path': 'folder'})['entries'], [{'name': 'result.txt', 'kind': 'file'}])
        with self.assertRaises(ValueError):
            run.run({'kind': 'read', 'path': '../outside'})
        (run.ROOT / 'escape').symlink_to('/tmp')
        with self.assertRaises(ValueError):
            run.run({'kind': 'read', 'path': 'escape/outside'})

    def test_shell_output_is_bounded_without_limiting_file_writes(self):
        result = run.run({'kind': 'exec', 'command': "python3 -c \"open('large.txt','w').write('x'*131072); print('y'*100000)\""})
        self.assertEqual(result['exitCode'], 0)
        self.assertEqual((run.ROOT / 'large.txt').stat().st_size, 131072)
        self.assertLessEqual(len(result['stdout']), run.MAX_OUTPUT)


if __name__ == '__main__':
    unittest.main()
