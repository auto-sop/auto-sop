import { checkLicenseBeforeTick } from './src/license/enforcement.js';
import os from 'os';

async function main() {
  const r = await checkLicenseBeforeTick(os.homedir());
  console.log('allowed:', r.allowed);
  console.log('licenseKey:', r.licenseKey ? r.licenseKey.substring(0, 10) + '...' : 'undefined');
  console.log('machineId:', r.machineId ? r.machineId.substring(0, 10) + '...' : 'undefined');
  console.log('plan:', r.plan);
}
main().catch(e => console.error('ERROR:', e.message));
