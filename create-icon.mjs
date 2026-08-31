import { spawnSync } from 'node:child_process';

const result = spawnSync('npx', ['tauri', 'icon', 'assets/icon.svg'], {
  stdio: 'inherit',
  shell: true,
});

process.exit(result.status ?? 1);
