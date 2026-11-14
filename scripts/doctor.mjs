import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
let failed = false;
const check = (name, ok) => {
  console.log((ok ? 'OK  ' : 'FAIL ') + name);
  if (!ok) failed = true;
};
const [major, minor] = process.versions.node.split('.').map(Number);
check('Node.js 24.11+', major > 24 || (major === 24 && minor >= 11));
check('.env 已初始化', existsSync('.env'));
check('依赖已安装', existsSync('node_modules/.modules.yaml'));
const docker = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], {
  encoding: 'utf8',
  timeout: 10000,
  windowsHide: true,
});
check('Docker Engine 可用', docker.status === 0);
process.exitCode = failed ? 1 : 0;
