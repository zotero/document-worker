import { defineConfig } from '@playwright/test';

export default defineConfig({
	use: process.env.CI ? { channel: 'chrome' } : {},
});
