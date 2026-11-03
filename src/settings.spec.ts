import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from '@jest/globals';

import { PLATFORM_NAME, PLUGIN_NAME, STORAGE_DIR_NAME } from './settings.js';

const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));
const schema = JSON.parse(readFileSync(join(process.cwd(), 'config.schema.json'), 'utf8'));

describe('plugin identity', () => {
  test('PLUGIN_NAME matches the package name Homebridge loads the plugin by', () => {
    expect(PLUGIN_NAME).toBe(pkg.name);
  });

  test('the package name is one Homebridge accepts as a plugin', () => {
    expect(pkg.name).toMatch(/^(@[a-z0-9-]+\/)?homebridge-/);
    expect(pkg.keywords).toContain('homebridge-plugin');
  });

  test('platform name stays LGThinQ so existing configurations keep working', () => {
    expect(PLATFORM_NAME).toBe('LGThinQ');
    expect(schema.pluginAlias).toBe(PLATFORM_NAME);
  });

  test('caches stay in the original storage directory', () => {
    expect(STORAGE_DIR_NAME).toBe('homebridge-lg-thinq');
  });
});
