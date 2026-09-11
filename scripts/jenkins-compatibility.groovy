// QA_HUB_CHECK_ONLY_V1
// Dedicated check history/workspace; rule source stays in the user's quick-build job.
def targets = [
    'Android Debug · 快捷检测': [platform:'Android', configuration:'Debug'],
    'Android Release · 快捷检测': [platform:'Android', configuration:'Release'],
    'iOS Debug · 快捷检测': [platform:'iOS', configuration:'Debug'],
    'iOS Release · 快捷检测': [platform:'iOS', configuration:'Release']
]
def target = targets[params['打包用途']]
if (target == null || !(params['参考版本'] in ['latest', '自动：最新成功版本'])) {
    error('检测参数无效；此入口只允许检测最新成功版本，不执行打包。')
}
// The authenticated backend reads this payload from the current quick-build config.
// No Jenkins internal API, script approval, or credentials are needed in this sandbox.
def encoded = params['CHECK_SOURCE'] ?: ''
if (!(encoded ==~ /[A-Za-z0-9+\/=]{100,200000}/)) {
    error('检测脚本缺失或格式无效，请通过 QA Hub 刷新。')
}
currentBuild.displayName = "#${env.BUILD_NUMBER} ${params['打包用途']}"
timeout(time:20, unit:'MINUTES') {
    node('built-in') {
        stage('检测累计修改') {
            withEnv(["QUICK_PLATFORM=${target.platform}", "QUICK_CONFIGURATION=${target.configuration}", "QUICK_CHECK_SOURCE=${encoded}"]) {
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
/usr/bin/python3 .compat-tools/BuildCompatibility.py --repo .compat-repo.git --share-root /Users/zd/gohttpserver/share --platform "$QUICK_PLATFORM" --configuration "$QUICK_CONFIGURATION" --selection latest
''')
            }
            def lines = readFile('compatibility-summary.txt').readLines()
            currentBuild.description = "${target.platform} ${target.configuration} · ${lines[0]} · ${lines[1]}"
            if (lines[0] == 'UNKNOWN') { currentBuild.result = 'UNSTABLE' }
            archiveArtifacts(artifacts:'compatibility.json,compatibility.html', fingerprint:true)
        }
    }
}
