"""Run four branch-aware checks in private Git repositories without allocating releases."""
import concurrent.futures
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import time

TOOLS = Path('/Users/zd/.jenkins/ozdqp-tools/source-routing/current')
TARGETS = {'android-debug': ('Android', 'Debug'), 'android-release': ('Android', 'Release'),
           'ios-debug': ('iOS', 'Debug'), 'ios-release': ('iOS', 'Release')}


def main():
    root = Path.cwd()
    spec = importlib.util.spec_from_file_location('build_source', TOOLS / 'build_source.py')
    source = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(source)
    branches = json.loads(os.environ.get('CHECK_BRANCHES', '{}'))
    if not isinstance(branches, dict) or set(branches) - set(TARGETS):
        raise ValueError('Invalid check branch selection')
    selected = os.environ.get('CHECK_TARGETS', ','.join(TARGETS)).split(',')
    if not selected or any(name not in TARGETS for name in selected):
        raise ValueError('Invalid check targets')
    # One remote snapshot pins all four targets. Resolving does not save a source
    # request or allocate a version/batch; checks do not enter the build workflow.
    for name in selected:
        work = root / 'checks' / name
        work.mkdir(parents=True, exist_ok=True)
        for file in ('compatibility.json', 'compatibility.html', 'compatibility-summary.txt', 'timing.json', 'source-request.json'):
            (work / file).unlink(missing_ok=True)
    heads = source.remote_heads()

    def check(name):
        work = root / 'checks' / name
        work.mkdir(parents=True, exist_ok=True)
        timing = {'startedAt': time.time()}
        try:
            platform, configuration = TARGETS[name]
            request = source.resolve(configuration, platform, branches.get(name, 'auto'), heads=heads)
            (work / 'source-request.json').write_text(json.dumps(request, ensure_ascii=False, indent=2), encoding='utf-8')
            repo = work / '.source-repo.git'
            if not repo.exists():
                seeds = [source.WORKSPACES[configuration], Path('/Users/zd/jenkins/ozdqp/Android')]
                seed = next((p for p in seeds if (p / '.git').exists()), None)
                if seed:
                    source.run_git('clone', '--bare', '--shared', str(seed), str(repo))
                else:
                    source.run_git('init', '--bare', str(repo))
            source.run_git('--git-dir=' + str(repo), 'fetch', '--no-tags', source.REPOSITORY, request['sourceRevision'])
            result = subprocess.run(['/usr/bin/python3', str(TOOLS / 'BuildCompatibility.py'), '--repo', str(repo),
                '--share-root', str(source.SHARE), '--platform', platform, '--configuration', configuration,
                '--target', request['sourceRevision'], '--source-branch', request['sourceBranch'], '--selection', 'latest'], cwd=work)
            report = json.loads((work / 'compatibility.json').read_text(encoding='utf-8'))
            if report.get('targetRevision') != request['sourceRevision']:
                raise ValueError('Check target differs from selected source')
            report['sourceBranch'] = request['sourceBranch']
            report['requestedBranch'] = branches.get(name, 'main' if configuration == 'Debug' else 'auto')
            (work / 'compatibility.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
            timing.update(exitCode=result.returncode, sourceBranch=request['sourceBranch'], sourceRevision=request['sourceRevision'])
            return result.returncode or (1 if report.get('result') == 'UNKNOWN' else 0)
        except Exception as error:
            timing.update(exitCode=1, error=str(error))
            return 1
        finally:
            timing['finishedAt'] = time.time()
            (work / 'timing.json').write_text(json.dumps(timing), encoding='utf-8')

    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(check, selected))
    return 1 if any(results) else 0


if __name__ == '__main__':
    sys.exit(main())
