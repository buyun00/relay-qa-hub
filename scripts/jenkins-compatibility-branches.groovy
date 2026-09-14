// QA_HUB_CHECK_ONLY_V3
// One executor; four independent branch-aware checks using the current builder tools.
def targets = [
    'Android Debug · 快捷检测':'android-debug', 'Android Release · 快捷检测':'android-release',
    'iOS Debug · 快捷检测':'ios-debug', 'iOS Release · 快捷检测':'ios-release'
]
def batch = params['打包用途'] == '四组并行 · 快捷检测'
def target = targets[params['打包用途']]
if ((!batch && target == null) || !(params['参考版本'] in ['latest','自动：最新成功版本'])) {
    error('检测参数无效；此入口只检测最新成功版本，不执行打包。')
}
def encoded = params['CHECK_SOURCE'] ?: ''
if (!(encoded ==~ /[A-Za-z0-9+\/=]{100,200000}/)) {
    error('检测脚本缺失或格式无效，请通过 QA Hub 开始检测。')
}
currentBuild.displayName = "#${env.BUILD_NUMBER} ${params['打包用途']}"
timeout(time:20, unit:'MINUTES') {
    node('built-in') {
        stage('准备分支检测') {
            withEnv(["QUICK_CHECK_SOURCE=${encoded}"]) {
                sh(script: '''#!/bin/sh
set -eu
/usr/bin/python3 - <<'QA_BRANCH_CHECK_SOURCE'
import base64,os,pathlib
script=base64.b64decode(os.environ['QUICK_CHECK_SOURCE'],validate=True).decode('utf-8')
if 'Run four branch-aware checks' not in script:
    raise RuntimeError('Unsupported check script')
pathlib.Path('.qa-branch-checks.py').write_text(script,encoding='utf-8')
QA_BRANCH_CHECK_SOURCE
''')
            }
        }
        stage('四组并行检测所选分支') {
            catchError(buildResult:'UNSTABLE', stageResult:'FAILURE') {
                withEnv(["CHECK_TARGETS=${batch ? 'android-debug,android-release,ios-debug,ios-release' : target}",
                         "CHECK_BRANCHES=${params['CHECK_BRANCHES'] ?: '{}'}"]) {
                    sh(script:'/usr/bin/python3 .qa-branch-checks.py')
                }
            }
        }
        archiveArtifacts(artifacts:'checks/*/compatibility.json,checks/*/compatibility.html,checks/*/timing.json,checks/*/source-request.json',allowEmptyArchive:true,fingerprint:true)
        currentBuild.description = 'Android / iOS × Debug / Release · 所选分支并行检测'
        if (!batch) {
            sh(script:"cp checks/${target}/compatibility.json checks/${target}/compatibility.html .")
            archiveArtifacts(artifacts:'compatibility.json,compatibility.html',fingerprint:true)
        }
    }
}
