import { defineConfig } from '@playwright/test';

export default defineConfig({
  globalSetup: './screenshots-setup.ts',
  testMatch: [],
});
