// QA_HUB_IOS_INSTALL_V1
// Paired physical iPhone devices; Release Ad Hoc copies, no game build/uninstall/launch.
if (!(params['打包用途'] in ['刷新测试机', '安装IPA']) ||
    !(params['INSTALL_SOURCE'] ==~ /[A-Za-z0-9+\/=]{100,200000}/) ||
    !(params['REQUEST_ID'] ==~ /[a-f0-9-]{36}/)) {
    error('请从 QA Hub 的 IPA 快速安装入口提交。')
}
currentBuild.displayName = "#${env.BUILD_NUMBER} ${params['打包用途']}"
timeout(time:15, unit:'MINUTES') {
    node('built-in') {
        stage('准备测试机安装') {
            sh('rm -f result.json install-intent.json adhoc.ipa')
            withEnv(["INSTALL_SOURCE=${params['INSTALL_SOURCE']}"]) {
                sh('''#!/bin/sh
set -eu
/usr/bin/python3 - <<'QA_IPA_SOURCE'
import base64,os,pathlib
source=base64.b64decode(os.environ['INSTALL_SOURCE'],validate=True).decode('utf8')
if 'QA Hub paired iPhone installer' not in source:
    raise RuntimeError('Unsupported installer source')
pathlib.Path('.qa-ios-install.py').write_text(source,encoding='utf8')
QA_IPA_SOURCE
''')
            }
        }
        stage('测试机连接与安装') {
            try {
                withEnv(["INSTALL_REQUEST=${params['INSTALL_REQUEST']}"]) {
                    sh('/usr/bin/python3 .qa-ios-install.py')
                }
            } finally {
                archiveArtifacts(artifacts:'result.json,install-intent.json,adhoc.ipa',allowEmptyArchive:true,fingerprint:true)
            }
        }
    }
}
