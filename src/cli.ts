#!/usr/bin/env node
import { assertPlatformSupported } from './platform-check.js';

assertPlatformSupported();

// Phase 2 will add commander command wiring here.
// For Phase 0, the CLI entry's only job is to prove the Windows refusal path.
