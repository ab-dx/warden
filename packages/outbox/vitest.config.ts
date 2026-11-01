import { defineConfig } from 'vitest/config';

// containers take a while to boot
export default defineConfig({ test: { hookTimeout: 180_000, testTimeout: 60_000 } });
