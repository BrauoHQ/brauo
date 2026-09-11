"""Exercise release shell steps locally without credentials or publishing.

Run: python -m pip install PyYAML==6.0.3
     python -m unittest discover -s scripts -p 'test_*.py' -v
"""
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import unittest
import zipfile

import yaml

ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = yaml.safe_load((ROOT / '.github/workflows/release.yml').read_text())
STEPS = {step['name']: step for step in WORKFLOW['jobs']['release']['steps']}


class ReleaseWorkflowTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.work = Path(self.directory.name)
        self.env = {'PATH': os.environ['PATH'], 'GITHUB_OUTPUT': str(self.work / 'output')}

    def run_step(self, name, **env):
        script = STEPS[name]['run']
        self.assertNotIn('${{', script, 'Workflow expressions must not generate shell source')
        return subprocess.run(['bash', '-e', '-o', 'pipefail', '-c', script],
                              cwd=self.work, env=self.env | env,
                              capture_output=True, text=True)

    def test_numeric_extension_tags_are_resolved(self):
        for tag in ['v1', 'v1.2', 'v0.17.0', 'v1.2.3.4']:
            with self.subTest(tag=tag):
                (self.work / 'output').unlink(missing_ok=True)
                result = self.run_step('Resolve version from tag', GITHUB_REF_NAME=tag)
                self.assertEqual(0, result.returncode, result.stderr)
                self.assertEqual('version=' + tag[1:] + '\n', (self.work / 'output').read_text())

    def test_invalid_tags_fail_before_output(self):
        for tag in ['', 'v', 'v1.2.3.4.5', 'v1.2.3-rc.1', 'v../other',
                    'v1.2.3$(printf${IFS}injected)', 'v1.2.3`id`', 'v1.2.3";id;',
                    'v1.2.3\nversion=other', 'v1.2.3 trailing']:
            with self.subTest(tag=tag):
                (self.work / 'output').unlink(missing_ok=True)
                result = self.run_step('Resolve version from tag', GITHUB_REF_NAME=tag)
                self.assertNotEqual(0, result.returncode)
                self.assertFalse((self.work / 'output').exists())

    def test_manifest_match_and_mismatch(self):
        (self.work / 'manifest.json').write_text('{"version":"0.17.0"}')
        self.assertEqual(0, self.run_step('Check manifest version matches tag', VERSION='0.17.0').returncode)
        self.assertNotEqual(0, self.run_step('Check manifest version matches tag', VERSION='0.17.1').returncode)
        hostile = '0.17.0$(printf${IFS}injected)'
        result = self.run_step('Check manifest version matches tag', VERSION=hostile)
        self.assertNotEqual(0, result.returncode)
        self.assertIn(hostile, result.stderr, 'Untrusted version must remain literal text')

    def test_package_checksum_and_publish_arguments(self):
        names = ['manifest.json', 'background.js', 'content.js', 'content.css',
                 'options.html', 'options.js', 'popup.html', 'popup.js', 'shared.js',
                 'voices.js', 'icons', '_locales']
        for name in names:
            source, destination = ROOT / name, self.work / name
            if source.is_dir():
                shutil.copytree(source, destination)
            else:
                shutil.copy2(source, destination)
        version = json.loads((self.work / 'manifest.json').read_text())['version']
        for name in ['Build package', 'Generate checksum']:
            result = self.run_step(name, VERSION=version)
            self.assertEqual(0, result.returncode, result.stderr)
        archive = self.work / f'brauo-{version}.zip'
        with zipfile.ZipFile(archive) as package:
            actual = {name for name in package.namelist() if not name.endswith('/')}
            expected = {str(path.relative_to(self.work)) for name in names
                        for path in ([self.work / name] if (self.work / name).is_file()
                                     else (self.work / name).rglob('*')) if path.is_file()}
            self.assertEqual(expected, actual)
            for name in actual:
                self.assertEqual((ROOT / name).read_bytes(), package.read(name))
        verified = subprocess.run(['sha256sum', '-c', archive.name + '.sha256'],
                                  cwd=self.work, capture_output=True, text=True)
        self.assertEqual(0, verified.returncode, verified.stderr)
        # Stub the only external write. Never call the real gh release command.
        bin_dir = self.work / 'bin'
        bin_dir.mkdir()
        gh = bin_dir / 'gh'
        gh.write_text('#!/bin/sh\nprintf "%s\\n" "$@" > "$STUB_ARGS"\n')
        gh.chmod(0o755)
        result = self.run_step('Publish release', VERSION=version, REPO='example/extension',
                               PATH=str(bin_dir) + os.pathsep + self.env['PATH'],
                               STUB_ARGS=str(self.work / 'gh-args'))
        self.assertEqual(0, result.returncode, result.stderr)
        args = (self.work / 'gh-args').read_text().splitlines()
        self.assertEqual(['release', 'create', 'v' + version, archive.name,
                          archive.name + '.sha256', '--title', 'Brauo v' + version,
                          '--notes-file', 'notes.md'], args)

    def test_actions_are_immutable_and_shell_source_is_static(self):
        for step in STEPS.values():
            if 'uses' in step:
                self.assertRegex(step['uses'], r'^[\w/-]+@[0-9a-f]{40}$')
            if 'run' in step:
                self.assertNotIn('${{', step['run'])
                result = subprocess.run(['bash', '-n'], input=step['run'],
                                        capture_output=True, text=True)
                self.assertEqual(0, result.returncode, result.stderr)
        self.assertIs(False, STEPS['Checkout']['with']['persist-credentials'])


if __name__ == '__main__':
    unittest.main()
