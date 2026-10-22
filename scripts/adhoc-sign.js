// electron-builder afterPack hook: signs the app ad hoc. Apple Silicon will not
// run an arm64 binary without a valid signature, and editing Info.plist breaks
// the one Electron ships with. This is not a Developer ID signature, so
// Gatekeeper still asks on first open; see the README.
'use strict';
const path = require('path');
const { execFileSync } = require('child_process');

exports.default = async function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
};
