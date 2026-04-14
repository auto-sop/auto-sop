#!/usr/bin/env node
import { assertPlatformSupported } from './platform-check.js';
import { runCli } from './cli/main.js';

assertPlatformSupported();
runCli(process.argv).then((code) => process.exit(code));
