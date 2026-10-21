// electron-builder "afterPack" hook (macOS only): signs the packaged app with an ad-hoc signature.
// The builds have no Apple certificate, but an app for Apple Silicon needs a signature that is valid:
// the one Electron ships with is broken as soon as the packaging changes Info.plist, and macOS then says
// "the app is damaged and can't be opened" (codesign: "code has no resources but signature indicates
// they must be present"). An ad-hoc signature (identity "-") needs no account and fixes that; the first
// start still shows the usual "unidentified developer" notice, which the user can confirm.
// Run on a Mac only: codesign does not exist elsewhere. Windows and Linux builds ignore this file.
const { execFileSync } = require('node:child_process');
const path = require('node:path');

exports.default = async function signAdHoc(context) {
  if (context.electronPlatformName !== 'darwin') return;
  if (process.platform !== 'darwin') throw new Error('The macOS app must be built on a Mac (codesign is needed for the ad-hoc signature)');
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app], { stdio: 'inherit' });
  console.log(`  • ad-hoc signature ok: ${app}`);
};
