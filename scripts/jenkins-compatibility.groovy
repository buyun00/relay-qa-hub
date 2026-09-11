// QA_HUB_CHECK_ONLY_V2
// One executor, four parallel checker processes. Build jobs retain their existing scheduling.
def targets = [
    'Android Debug · 快捷检测': [id:'android-debug', platform:'Android', configuration:'Debug'],
    'Android Release · 快捷检测': [id:'android-release', platform:'Android', configuration:'Release'],
    'iOS Debug · 快捷检测': [id:'ios-debug', platform:'iOS', configuration:'Debug'],
    'iOS Release · 快捷检测': [id:'ios-release', platform:'iOS', configuration:'Release']
]
def batch = params['打包用途'] == '四组并行 · 快捷检测'
def target = targets[params['打包用途']]
if ((!batch && target == null) || !(params['参考版本'] in ['latest', '自动：最新成功版本'])) {
    error('检测参数无效；此入口只允许检测最新成功版本，不执行打包。')
}
def encoded = params['CHECK_SOURCE'] ?: ''
if (!(encoded ==~ /[A-Za-z0-9+\/=]{100,200000}/)) {
    error('检测脚本缺失或格式无效，请通过 QA Hub 开始检测。')
}
currentBuild.displayName = "#${env.BUILD_NUMBER} ${params['打包用途']}"
timeout(time:20, unit:'MINUTES') {
    node('built-in') {
        stage('准备检测源码') {
            withEnv(["QUICK_CHECK_SOURCE=${encoded}"]) {
                sh(script: '''#!/bin/sh
set -eu
/usr/bin/python3 - <<'QA_COMPATIBILITY_TOOLS'
import base64,json,os,pathlib,zlib
tools=json.loads(zlib.decompress(base64.b64decode(os.environ['QUICK_CHECK_SOURCE'])))
if set(tools) != {'BuildCompatibility.py','CheckPlayerRebuildRequired.py'}:
    raise RuntimeError('Unsupported checker module contract')
root=pathlib.Path('.compat-tools')
root.mkdir(exist_ok=True)
for name,content in tools.items():
    if not isinstance(content,str):
        raise RuntimeError('Invalid checker module')
    (root/name).write_text(content,encoding='utf-8')
QA_COMPATIBILITY_TOOLS
if [ ! -d .compat-repo.git ]; then
    git clone --bare --shared /Users/zd/jenkins/ozdqp/Android .compat-repo.git
fi
git --git-dir=.compat-repo.git fetch --no-tags git@git.dominogm.com:diaoyu/ozdqp.git +refs/heads/main:refs/heads/main
''')
            }
        }
        stage('四组并行检测累计修改') {
            catchError(buildResult:'UNSTABLE', stageResult:'FAILURE') {
                withEnv(["CHECK_TARGETS=${batch ? 'android-debug,android-release,ios-debug,ios-release' : target.id}"]) {
                    sh(script: '''#!/bin/sh
set -eu
/usr/bin/python3 - <<'QA_CHECK_PARALLEL'
import concurrent.futures,json,os,pathlib,subprocess,sys,time
root=pathlib.Path.cwd()
targets={'android-debug':('Android','Debug'),'android-release':('Android','Release'),'ios-debug':('iOS','Debug'),'ios-release':('iOS','Release')}
selected=os.environ['CHECK_TARGETS'].split(',')
if not selected or any(t not in targets for t in selected):
    raise RuntimeError('Invalid checker target')
def prepare(name):
    work=root/'checks'/name
    work.mkdir(parents=True,exist_ok=True)
    for file in ('compatibility.json','compatibility.html','compatibility-summary.txt','timing.json'):
        (work/file).unlink(missing_ok=True)
    repo=work/'.compat-repo.git'
    if not repo.is_dir():
        subprocess.run(['git','clone','--bare','--shared',str(root/'.compat-repo.git'),str(repo)],check=True)
    subprocess.run(['git','--git-dir='+str(repo),'fetch','--no-tags',str(root/'.compat-repo.git'),'+refs/heads/main:refs/heads/main'],check=True)
    return work
# Each checker may fetch missing baseline commits. Its Git refs, FETCH_HEAD and
# reports are private; all four begin from the same freshly fetched main commit.
with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
    workspaces=dict(zip(selected,pool.map(prepare,selected)))
    def check(name):
        work=workspaces[name]
        platform,configuration=targets[name]
        timing={'startedAt':time.time()}
        result=subprocess.run(['/usr/bin/python3',str(root/'.compat-tools'/'BuildCompatibility.py'),'--repo',str(work/'.compat-repo.git'),'--share-root','/Users/zd/gohttpserver/share','--platform',platform,'--configuration',configuration,'--selection','latest'],cwd=work)
        timing.update(finishedAt=time.time(),exitCode=result.returncode)
        (work/'timing.json').write_text(json.dumps(timing))
        return result.returncode
    statuses=list(pool.map(check,selected))
unknown=any((work/'compatibility-summary.txt').exists() and (work/'compatibility-summary.txt').read_text().splitlines()[0]=='UNKNOWN' for work in workspaces.values())
sys.exit(1 if any(statuses) or unknown else 0)
QA_CHECK_PARALLEL
''')
                }
            }
        }
        archiveArtifacts(artifacts:'checks/*/compatibility.json,checks/*/compatibility.html,checks/*/timing.json', allowEmptyArchive:true, fingerprint:true)
        currentBuild.description = batch ? 'Android / iOS × Debug / Release · 四组并行检测' : "${target.platform} ${target.configuration}"
        // Retain the artifact contract for already-deployed clients during rollout.
        if (!batch) {
            sh(script: "cp checks/${target.id}/compatibility.json checks/${target.id}/compatibility.html .")
            archiveArtifacts(artifacts:'compatibility.json,compatibility.html', fingerprint:true)
        }
    }
}
